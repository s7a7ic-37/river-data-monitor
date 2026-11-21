import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker.js";

const importTime = "2026-11-21T14:15:00Z";
const report = {
  last_import: importTime,
  readings: [["2026-11-21T13:45:00Z", 0.35]],
  runs: [{ at: importTime, received: 1, added: 1, revised: 0, unchanged: 0, rejected: 0, reasons: {} }],
};
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

test("malformed reading rows or import history use the dated backup", async (t) => {
  const invalidReports = [
    { ...report, readings: [["invalid date", 0.35]] },
    { ...report, readings: [[report.readings[0][0], "0.35"]] },
    { ...report, readings: [...report.readings, ...report.readings] },
    { ...report, last_import: null },
    { ...report, runs: [] },
    { ...report, runs: [{ ...report.runs[0], reasons: null }] },
  ];
  for (const invalid of invalidReports) {
    const mocked = t.mock.method(globalThis, "fetch", async () => Response.json(invalid));
    const response = await worker.fetch(request, backup);
    assert.equal(response.headers.get("X-River-Snapshot"), "backup");
    assert.deepEqual(await response.json(), report);
    mocked.mock.restore();
  }
});

test("import logs outside the writer's batch and history contract use the backup", async (t) => {
  const run = report.runs[0];
  const invalidRuns = [
    [{ ...run, added: 20 }],
    [{ ...run, received: 2, rejected: 1, reasons: { "Invalid gauge height": 2 } }],
    [{ ...run, received: 401, unchanged: 400 }],
    Array.from({ length: 9 }, () => run),
  ];
  for (const runs of invalidRuns) {
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ ...report, runs }));
    const response = await worker.fetch(request, backup);
    assert.equal(response.headers.get("X-River-Snapshot"), "backup");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), report);
    fetch.mock.restore();
  }
});

test("duplicate rows and failed batches retain valid complete accounting", async (t) => {
  const run = report.runs[0];
  const replay = {
    ...run, received: 400, added: 1, revised: 1, unchanged: 396, rejected: 2,
    reasons: { "Invalid gauge height": 1, "Unexpected measure": 1 },
  };
  const failure = {
    ...run, at: "2026-11-21T16:27:00Z", received: 2, added: 0, rejected: 2,
    reasons: { "Invalid gauge height": 2 }, error: "The feed returned no usable readings.",
  };
  const snapshot = { ...report, runs: [failure, replay, ...Array.from({ length: 6 }, () => run)] };
  t.mock.method(globalThis, "fetch", async () => Response.json(snapshot));
  const response = await worker.fetch(request, backup);
  assert.equal(response.headers.get("X-River-Snapshot"), null);
  assert.deepEqual(await response.json(), snapshot);
});

test("page assets do not fetch the report service", async (t) => {
  const mock = t.mock.method(globalThis, "fetch");
  const response = await worker.fetch(new Request("https://river.artemislab.co.uk/"), {
    ASSETS: { fetch: async () => new Response("dashboard") },
  });
  assert.equal(await response.text(), "dashboard");
  assert.equal(mock.mock.callCount(), 0);
});
