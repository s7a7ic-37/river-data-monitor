import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker.js";

const report = { readings: [["2026-11-21T13:45:00Z", 0.35]], runs: [] };
const request = new Request("https://river.artemislab.co.uk/snapshot.json");
const backup = { ASSETS: { fetch: async () => Response.json(report) } };

test("the same-origin report serves the published data", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://raw.githubusercontent.com/s7a7ic-37/river-data-monitor/data/snapshot.json");
    return Response.json(report);
  });
  const response = await worker.fetch(request, backup);
  assert.deepEqual(await response.json(), report);
  assert.equal(response.headers.get("X-River-Snapshot"), null);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=120");
});

test("failed and invalid report responses use the dated backup", async (t) => {
  for (const upstream of [new Response("temporary failure", { status: 503 }), Response.json({ broken: true })]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => upstream);
    const response = await worker.fetch(request, backup);
    assert.equal(response.headers.get("X-River-Snapshot"), "backup");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), report);
    mocked.mock.restore();
  }
});

test("page assets do not fetch the report service", async (t) => {
  const mock = t.mock.method(globalThis, "fetch");
  const response = await worker.fetch(new Request("https://river.artemislab.co.uk/"), {
    ASSETS: { fetch: async () => new Response("dashboard") },
  });
  assert.equal(await response.text(), "dashboard");
  assert.equal(mock.mock.callCount(), 0);
});
