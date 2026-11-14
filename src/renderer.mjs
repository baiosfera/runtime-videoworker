import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const FORMAT_PRESETS = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
};

function runProcess(cmd, args, inputBuffer = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (d) => stdout.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolve({ code, stdout: out, stderr: err });
      } else {
        reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`));
      }
    });
    if (inputBuffer) {
      child.stdin.write(inputBuffer);
    }
    child.stdin.end();
  });
}

export async function probeVideo(filePath) {
  const { stdout } = await runProcess("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size:stream=codec_name,width,height,pix_fmt",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout);
  const videoStream = (parsed.streams || []).find((s) => s.width && s.height) || {};
  return {
    duration: Number(parsed.format?.duration || 0),
    sizeBytes: Number(parsed.format?.size || 0),
    codec: videoStream.codec_name || "",
    width: Number(videoStream.width || 0),
    height: Number(videoStream.height || 0),
    pixFmt: videoStream.pix_fmt || "",
  };
}

/**
 * Renders an Ad / Motion MP4 (9:16, 16:9, or 1:1) using FFmpeg Smart-Crop or deterministic canvas pipe.
 */
export async function renderVideoJob(job = {}) {
  const format = FORMAT_PRESETS[job.format] ? job.format : "9:16";
  const { width, height } = FORMAT_PRESETS[format];
  const durationSec = Math.min(30, Math.max(1, Number(job.durationSec || 3)));
  const fps = Math.min(60, Math.max(15, Number(job.fps || 30)));
  const bgColor = /^0x[0-9a-fA-F]{6}$/.test(String(job.bgColor || "")) ? job.bgColor : "0x111827";
  const jobId = String(job.jobId || `job-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "");

  const workDir = `/tmp/videoworker-${jobId}`;
  fs.mkdirSync(workDir, { recursive: true });
  const outPath = path.join(workDir, `${format.replace(":", "x")}.mp4`);

  const sourcePath = job.sourcePath && fs.existsSync(job.sourcePath) ? job.sourcePath : null;
  if (sourcePath) {
    // FFmpeg Smart-Crop preserving aspect ratio and centering subject
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`;
    await runProcess("ffmpeg", [
      "-y",
      "-i",
      sourcePath,
      "-t",
      String(durationSec),
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outPath,
    ]);
  } else {
    // Deterministic synthetic ad canvas + silent AAC track (no PNG disk spam)
    await runProcess("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${bgColor}:s=${width}x${height}:r=${fps}:d=${durationSec}`,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=channel_layout=stereo:sample_rate=44100`,
      "-t",
      String(durationSec),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      outPath,
    ]);
  }

  const probe = await probeVideo(outPath);
  return { jobId, format, outPath, probe };
}
