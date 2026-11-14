import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enqueueRenderJob } from "./index.mjs";
import { getFlowConnectorStatus } from "./adapters/flow_cdp.mjs";
import { generateVideoViaApi } from "./adapters/video_api.mjs";

describe("videoworker production-first", () => {
  it("renders a valid 9:16 MP4 verified by ffprobe and uploads to storage", async () => {
    const { jobId, promise } = enqueueRenderJob({
      jobId: `test-916-${Date.now()}`,
      format: "9:16",
      durationSec: 1,
      fps: 24,
    });
    const result = await promise;
    assert.equal(result.jobId, jobId);
    assert.equal(result.status, "completed");
    assert.equal(result.format, "9:16");
    assert.equal(result.probe.codec, "h264");
    assert.equal(result.probe.width, 1080);
    assert.equal(result.probe.height, 1920);
    assert.equal(result.probe.pixFmt, "yuv420p");
    assert.ok(result.probe.sizeBytes > 1000);
    assert.ok(result.storage.key.endsWith(".mp4"));
  });

  it("enforces Flow retirement cutoff on 2026-12-05 and explicit Video API keys", async () => {
    const before = getFlowConnectorStatus(new Date("2026-11-15T00:00:00Z"));
    assert.equal(before.available, false);
    assert.equal(before.reason, "flow_cdp_url_not_configured");

    const after = getFlowConnectorStatus(new Date("2026-12-05T00:00:00Z"));
    assert.equal(after.available, false);
    assert.equal(after.reason, "retired_2026_12_05");

    await assert.rejects(() => generateVideoViaApi({ provider: "freellmapi", prompt: "test" }), /FREELLMAPI_KEY/);
  });
});
