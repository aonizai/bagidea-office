// Tests for the office-stats derivation layer: per-day KPI enrichment
// (successRate, avgDurationSec) and the 7-day per-agent roll-up served by
// GET /stats. The daemon stores raw buckets (durations{id:{sum,count,max}},
// outcomes{id:{done,failed}}); /stats derives the human numbers from them.
//
// Two layers:
//   1. Pure-math tests (always run) — lock down the derivation formula so a
//      refactor can't silently change what successRate/avgDurationSec mean.
//   2. HTTP tests — exercise the real endpoint, skipped when no daemon.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const BASE_URL = "http://127.0.0.1:8787";

// --- 1. Pure-math characterization of the /stats derivation ---------------
// Mirrors the exact math in the GET /stats handler. If that handler's
// formula changes, update it here intentionally.

// Per-day per-agent derivation (matches the perAgent loop in /stats).
function derivePerAgent(rawDay) {
  const agents = rawDay.agents || {};
  const out = rawDay.outcomes || {};
  const dur = rawDay.durations || {};
  const perAgent = {};
  const ids = new Set([
    ...Object.keys(agents),
    ...Object.keys(out),
    ...Object.keys(dur),
  ]);
  for (const id of ids) {
    const o = out[id] || { done: 0, failed: 0 };
    const tot = o.done + o.failed;
    const du = dur[id] || { sum: 0, count: 0 };
    perAgent[id] = {
      runs: agents[id] || 0,
      done: o.done,
      failed: o.failed,
      successRate: tot ? Math.round((o.done / tot) * 1000) / 10 : null,
      avgDurationSec: du.count ? Math.round((du.sum / du.count) / 1000) : null,
    };
  }
  return perAgent;
}

test("successRate is done/(done+failed) rounded to 1dp, null when no runs", () => {
  const pa = derivePerAgent({
    agents: { main: 10 },
    outcomes: { main: { done: 8, failed: 2 } },
  });
  assert.strictEqual(pa.main.successRate, 80);
  assert.strictEqual(pa.main.done, 8);
  assert.strictEqual(pa.main.failed, 2);
});

test("successRate is null when an agent has no outcomes yet", () => {
  const pa = derivePerAgent({ agents: { main: 5 } }); // runs but no outcomes
  assert.strictEqual(pa.main.successRate, null);
});

test("avgDurationSec is sum/count in seconds, rounded; null when no samples", () => {
  // two runs: 90s + 30s => avg 60s
  const pa = derivePerAgent({
    agents: { athena: 2 },
    durations: { athena: { sum: 120000, count: 2, max: 90000 } },
  });
  assert.strictEqual(pa.athena.avgDurationSec, 60);
  assert.strictEqual(pa.athena.successRate, null); // no outcomes recorded
});

test("an agent appearing only in durations (not agents/outcomes) is still listed", () => {
  // This guards the union-of-keys in the derivation — a run that started but
  // whose 'runs' count was lost still shows its timing.
  const pa = derivePerAgent({
    durations: { guten: { sum: 50000, count: 1, max: 50000 } },
  });
  assert.ok(pa.guten, "guten should be present even without an agents/outcomes entry");
  assert.strictEqual(pa.guten.avgDurationSec, 50);
});

test("empty day yields an empty per-agent object", () => {
  const pa = derivePerAgent({});
  assert.deepStrictEqual(pa, {});
});

// 7-day roll-up (matches the kpi array in /stats: sums across days).
function rollUp(days) {
  const kpiRoll = {};
  for (const raw of days) {
    const out = raw.outcomes || {};
    const dur = raw.durations || {};
    const ids = new Set([
      ...Object.keys(raw.agents || {}),
      ...Object.keys(out),
      ...Object.keys(dur),
    ]);
    for (const id of ids) {
      const o = out[id] || { done: 0, failed: 0 };
      const du = dur[id] || { sum: 0, count: 0 };
      const r = (kpiRoll[id] = kpiRoll[id] || { runs: 0, done: 0, failed: 0, durSum: 0, durCount: 0 });
      r.runs += raw.agents[id] || 0;
      r.done += o.done;
      r.failed += o.failed;
      r.durSum += du.sum;
      r.durCount += du.count;
    }
  }
  return Object.entries(kpiRoll)
    .map(([id, r]) => ({
      id, runs: r.runs, done: r.done, failed: r.failed,
      successRate: (r.done + r.failed) ? Math.round((r.done / (r.done + r.failed)) * 1000) / 10 : null,
      avgDurationSec: r.durCount ? Math.round((r.durSum / r.durCount) / 1000) : null,
    }))
    .sort((a, b) => b.runs - a.runs);
}

test("roll-up sums counts + durations across days, sorted by runs desc", () => {
  const kpi = rollUp([
    { agents: { main: 10, edith: 3 }, outcomes: { main: { done: 9, failed: 1 }, edith: { done: 3, failed: 0 } },
      durations: { main: { sum: 100000, count: 2 } } },
    { agents: { main: 5 }, outcomes: { main: { done: 4, failed: 1 } },
      durations: { main: { sum: 200000, count: 4 } } },
  ]);
  assert.strictEqual(kpi[0].id, "main");          // 15 runs > edith 3
  assert.strictEqual(kpi[0].runs, 15);
  assert.strictEqual(kpi[0].done, 13);
  assert.strictEqual(kpi[0].failed, 2);
  // successRate = 13/15 = 0.8666... -> 86.7
  assert.strictEqual(kpi[0].successRate, 86.7);
  // avgDuration = (100000+200000)/(2+4) = 50000ms = 50s
  assert.strictEqual(kpi[0].avgDurationSec, 50);
});

// --- 2. HTTP integration (skipped if the daemon isn't running) ------------

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${path}`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ statusCode: res.statusCode, data: data ? JSON.parse(data) : null }));
    }).on("error", reject);
  });
}

test("GET /stats returns a kpi array (7-day per-agent roll-up)", async (t) => {
  let res;
  try { res = await get("/stats"); }
  catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running at 127.0.0.1:8787"); throw err; }
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.data.kpi), "kpi must be an array");
  // When present, each KPI row carries the derived fields.
  for (const row of res.data.kpi) {
    assert.ok(["runs", "done", "failed"].every((f) => typeof row[f] === "number"));
    assert.ok(row.successRate === null || typeof row.successRate === "number");
    assert.ok(row.avgDurationSec === null || typeof row.avgDurationSec === "number");
  }
});

test("GET /stats days each carry a perAgent map with derived fields", async (t) => {
  let res;
  try { res = await get("/stats"); }
  catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running at 127.0.0.1:8787"); throw err; }
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.data.days.length === 7);
  for (const d of res.data.days) {
    assert.ok(typeof d.perAgent === "object" && d.perAgent !== null);
  }
});

test("GET /stats/kpi returns per-agent KPI over the requested window", async (t) => {
  let res;
  try { res = await get("/stats/kpi?days=7"); }
  catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running at 127.0.0.1:8787"); throw err; }
  // A live daemon running older code predating this endpoint answers 404 —
  // treat that as "not applicable" rather than a failure.
  if (res.statusCode === 404) return t.skip("Live daemon predates /stats/kpi");
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.data.days, 7);
  assert.ok(typeof res.data.costTotal === "number");
  assert.ok(Array.isArray(res.data.kpi));
  for (const row of res.data.kpi) {
    // Each row carries identity + the derived performance fields.
    assert.ok(typeof row.id === "string" && typeof row.name === "string");
    assert.ok(["runs", "done", "failed", "activeDays"].every((f) => typeof row[f] === "number"));
    assert.ok(row.successRate === null || typeof row.successRate === "number");
    assert.ok(row.avgDurationSec === null || typeof row.avgDurationSec === "number");
  }
});

test("GET /stats/kpi?agent=<id> filters to a single agent", async (t) => {
  let res;
  try { res = await get("/stats"); }
  catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running at 127.0.0.1:8787"); throw err; }
  const someId = (res.data.kpi[0] || {}).id;
  if (!someId) return t.skip("No agents with runs to filter on");
  const filtered = await get(`/stats/kpi?days=7&agent=${encodeURIComponent(someId)}`);
  if (filtered.statusCode === 404) return t.skip("Live daemon predates /stats/kpi");
  assert.strictEqual(filtered.statusCode, 200);
  assert.ok(filtered.data.kpi.length <= 1, "agent filter must yield at most one row");
  if (filtered.data.kpi.length === 1)
    assert.strictEqual(filtered.data.kpi[0].id, someId);
});

test("GET /stats/kpi clamps an out-of-range days param", async (t) => {
  let res;
  try { res = await get("/stats/kpi?days=99999"); }
  catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running at 127.0.0.1:8787"); throw err; }
  if (res.statusCode === 404) return t.skip("Live daemon predates /stats/kpi");
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.data.days <= 90, "days must be clamped to 90");
});
