import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { connect, JSONCodec } from "nats";
import { getS3Config, uploadRenderToObjectStorage } from "./storage.mjs";
import { renderVideoJob } from "./renderer.mjs";
import { getFlowConnectorStatus } from "./adapters/flow_cdp.mjs";

const PORT = Number(process.env.PORT || 3010);
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_RENDERS || 1));
const jsonCodec = JSONCodec();

const jobs = new Map();
const pendingQueue = [];
let activeRenders = 0;

function checkFfmpegAvailable() {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], (err) => resolve(!err));
  });
}

export async function processRenderJob(jobSpec) {
  const jobId = String(jobSpec.jobId || `job-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "");
  const record = jobs.get(jobId) || { jobId, status: "queued", createdAt: new Date().toISOString() };
  record.status = "rendering";
  jobs.set(jobId, record);

  try {
    const rendered = await renderVideoJob({ ...jobSpec, jobId });
    const objectKey = `renders/${jobId}/${rendered.format.replace(":", "x")}.mp4`;
    const uploaded = await uploadRenderToObjectStorage(rendered.outPath, objectKey);
    fs.rmSync(`/tmp/videoworker-${jobId}`, { recursive: true, force: true });

    const done = {
      ...record,
      status: "completed",
      format: rendered.format,
      probe: rendered.probe,
      storage: uploaded,
      completedAt: new Date().toISOString(),
    };
    jobs.set(jobId, done);
    return done;
  } catch (err) {
    const failed = {
      ...record,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      failedAt: new Date().toISOString(),
    };
    jobs.set(jobId, failed);
    throw err;
  }
}

function drainQueue() {
  while (activeRenders < MAX_CONCURRENT && pendingQueue.length > 0) {
    const next = pendingQueue.shift();
    activeRenders++;
    processRenderJob(next.jobSpec)
      .then(next.resolve)
      .catch(next.reject)
      .finally(() => {
        activeRenders--;
        drainQueue();
      });
  }
}

export function enqueueRenderJob(jobSpec) {
  const jobId = String(jobSpec.jobId || `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const spec = { ...jobSpec, jobId };
  jobs.set(jobId, { jobId, status: "queued", createdAt: new Date().toISOString() });
  const promise = new Promise((resolve, reject) => {
    pendingQueue.push({ jobSpec: spec, resolve, reject });
    drainQueue();
  });
  return { jobId, promise };
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

    if (url.pathname === "/health" || url.pathname === "/healthz") {
      const ffmpegOk = await checkFfmpegAvailable();
      const s3 = getS3Config();
      const flow = getFlowConnectorStatus();
      res.writeHead(ffmpegOk ? 200 : 503, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          status: ffmpegOk ? "ok" : "degraded",
          service: "videoworker",
          port: PORT,
          ffmpeg: ffmpegOk,
          objectstorage: s3.configured ? "configured" : "tmp-fallback",
          flowConnector: flow,
          activeRenders,
          queued: pendingQueue.length,
        })
      );
    }

    if (url.pathname === "/jobs" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      const { jobId, promise } = enqueueRenderJob(body);
      promise.catch((err) => console.error(`[videoworker] Job ${jobId} failed:`, err));
      res.writeHead(202, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jobId, status: "queued" }));
    }

    if (url.pathname.startsWith("/jobs/") && req.method === "GET") {
      const id = url.pathname.slice("/jobs/".length);
      const job = jobs.get(id);
      if (!job) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "Job not found" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(job));
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "videoworker", status: "ready", port: PORT }));
  });
}

async function startNatsWorker() {
  const natsUrl = (process.env.NATS_URL || "").trim();
  if (!natsUrl || natsUrl.startsWith("${")) return;
  try {
    const parsed = new URL(natsUrl);
    const nc = await connect({
      servers: `${parsed.hostname}:${parsed.port || "4222"}`,
      user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      pass: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    });
    try {
      const jsm = await nc.jetstreamManager();
      await jsm.streams.add({ name: "VIDEO_RENDER", subjects: ["video.render.jobs"] });
      console.log("[NATS] JetStream stream 'VIDEO_RENDER' ready");
    } catch {}

    const sub = nc.subscribe("video.render.jobs", { queue: "videoworker-group" });
    console.log("[NATS] Subscribed to 'video.render.jobs' (queue: videoworker-group)");
    (async () => {
      for await (const msg of sub) {
        try {
          const payload = jsonCodec.decode(msg.data);
          await enqueueRenderJob(payload).promise;
        } catch (err) {
          console.error("[NATS] Render job error:", err);
        }
      }
    })();
  } catch (err) {
    console.warn("[NATS] Worker skipped:", err instanceof Error ? err.message : String(err));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(PORT, "0.0.0.0", () => {
    console.log(`videoworker listening on ${PORT}`);
    startNatsWorker();
  });
}
