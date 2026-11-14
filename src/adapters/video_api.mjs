function cleanEnv(val, fallback = "") {
  const s = String(val || "").trim();
  return !s || (s.startsWith("${") && s.endsWith("}")) ? fallback : s;
}

/**
 * Video API adapter supporting FreeLLMAPI media endpoint (explicit key),
 * Gemini (gemini-omni-1.2-flash), and Vertex AI (veo-3.1-generate-001).
 */
export async function generateVideoViaApi({ provider = "freellmapi", prompt, durationSec = 5, aspectRatio = "9:16" }) {
  if (!prompt) throw new Error("prompt is required for Video API generation");

  if (provider === "freellmapi") {
    const baseUrl = cleanEnv(process.env.FREELLMAPI_URL, "http://freellmapi:3001").replace(/\/+$/, "");
    const apiKey = cleanEnv(process.env.FREELLMAPI_KEY) || cleanEnv(process.env.FREEAPI_UNIFIED_API_KEY);
    if (!apiKey) throw new Error("FREELLMAPI_KEY is required for freellmapi media.ts video generation");

    const res = await fetch(`${baseUrl}/v1/media/video`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ prompt, duration: durationSec, aspect_ratio: aspectRatio }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`FreeLLMAPI media video failed HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  if (provider === "gemini") {
    const apiKey = cleanEnv(process.env.GEMINI_API_KEY);
    if (!apiKey) throw new Error("GEMINI_API_KEY is required for gemini-omni-1.2-flash");
    const model = cleanEnv(process.env.GEMINI_VIDEO_MODEL, "gemini-omni-1.2-flash");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: `${prompt} (${aspectRatio}, ${durationSec}s)` }] }] }),
        signal: AbortSignal.timeout(30000),
      }
    );
    if (!res.ok) throw new Error(`Gemini video API failed HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  if (provider === "vertex") {
    const projectId = cleanEnv(process.env.VERTEX_PROJECT_ID);
    const location = cleanEnv(process.env.VERTEX_LOCATION, "us-central1");
    const token = cleanEnv(process.env.VERTEX_ACCESS_TOKEN);
    const model = cleanEnv(process.env.VERTEX_VIDEO_MODEL, "veo-3.1-generate-001");
    if (!projectId || !token) throw new Error("VERTEX_PROJECT_ID and VERTEX_ACCESS_TOKEN are required for Veo 3.1");

    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predictLongRunning`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ instances: [{ prompt }], parameters: { aspectRatio, durationSeconds: durationSec } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Vertex Veo API failed HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  throw new Error(`Unsupported Video API provider: ${provider}`);
}
