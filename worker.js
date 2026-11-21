const reportUrl = "https://raw.githubusercontent.com/s7a7ic-37/river-data-monitor/data/snapshot.json";

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
        if (Array.isArray(snapshot?.readings) && Array.isArray(snapshot?.runs)) {
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
