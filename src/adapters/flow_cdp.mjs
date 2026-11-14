export const FLOW_RETIREMENT_DATE_ISO = "2026-12-05T00:00:00Z";

/**
 * Optional decoupled connector for Google Flow AI Pro (Chrome CDP + noVNC).
 * Automatically disables itself on or after the Dec 5, 2026 retirement date.
 */
export function getFlowConnectorStatus(now = new Date()) {
  const retired = now.getTime() >= Date.parse(FLOW_RETIREMENT_DATE_ISO);
  const cdpUrl = (process.env.FLOW_CDP_URL || "").trim();
  if (retired) {
    return { available: false, reason: "retired_2026_12_05" };
  }
  if (!cdpUrl) {
    return { available: false, reason: "flow_cdp_url_not_configured" };
  }
  return { available: true, cdpUrl, novncUrl: (process.env.FLOW_NOVNC_URL || "").trim() || null };
}

export async function dispatchFlowJob(job, now = new Date()) {
  const status = getFlowConnectorStatus(now);
  if (!status.available) {
    throw new Error(`Google Flow optional connector unavailable: ${status.reason}`);
  }
  const res = await fetch(`${status.cdpUrl.replace(/\/+$/, "")}/flow/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(job),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`Flow CDP bridge returned HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}
