const reportUrl = "https://raw.githubusercontent.com/s7a7ic-37/river-data-monitor/data/snapshot.json";
const countFields = ["received", "added", "revised", "unchanged", "rejected"];
// Match the import batch and history bounds in monitor.py.
const maxBatchRows = 400;
const maxImportRuns = 8;
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));

function validRun(run) {
  if (!run || !isTime(run.at) || !countFields.every(field => isCount(run[field]))) return false;
  if (!run.reasons || typeof run.reasons !== "object" || Array.isArray(run.reasons)) return false;

  const reasons = Object.values(run.reasons);
  const accounted = run.added + run.revised + run.unchanged + run.rejected;
  return run.received <= maxBatchRows && accounted === run.received &&
    reasons.every(isCount) && reasons.reduce((total, count) => total + count, 0) === run.rejected &&
    (run.error === undefined || typeof run.error === "string");
}

function validReport(snapshot) {
  if (!Array.isArray(snapshot?.readings) || !Array.isArray(snapshot?.runs)) return false;
  if (snapshot.runs.length > maxImportRuns) return false;
  if (snapshot.last_import !== null && !isTime(snapshot.last_import)) return false;
  if (snapshot.readings.length && (!snapshot.last_import || !snapshot.runs.length)) return false;

  let previous = -Infinity;
  for (const row of snapshot.readings) {
    if (!Array.isArray(row) || row.length !== 2 || !isTime(row[0]) || !Number.isFinite(row[1])) return false;
    const observed = Date.parse(row[0]);
    if (observed <= previous) return false;
    previous = observed;
  }

  return snapshot.runs.every(validRun);
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/snapshot.json") return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    try {
      const upstream = await fetch(reportUrl, {
        signal: AbortSignal.timeout(5_000),
        cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 120, "400-599": 0 } },
      });
      if (upstream.ok) {
        const snapshot = await upstream.json();
        if (validReport(snapshot)) {
          return new Response(request.method === "HEAD" ? null : JSON.stringify(snapshot), {
            headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" },
          });
        }
      } else {
        await upstream.body?.cancel();
      }
    } catch {
      // The bundled snapshot gives readers a dated result while the report is unavailable.
    }
    const backup = await env.ASSETS.fetch(request);
    const headers = new Headers(backup.headers);
    headers.set("X-River-Snapshot", "backup");
    headers.set("Cache-Control", "no-store");
    return new Response(backup.body, { status: backup.status, headers });
  },
};
