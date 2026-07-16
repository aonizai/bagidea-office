// Tests for the "meeting" job mode — a scheduled runDiscussion (e.g. a daily
// standup). Layer 1 characterizes the jobDue rule for meeting jobs (pure
// math, always runs). Layer 2 exercises POST /jobs with mode:"meeting" and is
// skipped when no daemon is reachable.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const BASE_URL = "http://127.0.0.1:8787";

// --- 1. jobDue characterization for the meeting mode ----------------------
// Mirrors the meeting branch of jobDue in server.js. A meeting job is due
// once per day at its configured HH:MM (daily-only; meetings are recurring).
function meetingDue(job, now) {
  if (job.enabled === false || job.done) return false;
  if (job.mode !== "meeting") return false;
  if (job.daily && job.time) {
    const [h, m] = job.time.split(":").map(Number);
    const today = new Date(now); today.setHours(h, m, 0, 0);
    const dayKey = new Date(now).toDateString();
    return now >= today.getTime() && job.lastDay !== dayKey;
  }
  return false;   // non-daily meetings are never due (matches the server rule)
}

// Build a fixed "now" on a given day at HH:MM for deterministic checks.
const at = (h, m) => new Date(2026, 6, 14, h, m, 0).getTime();   // 2026-07-14

test("a daily meeting is due at/after its time, once per day", () => {
  const job = { mode: "meeting", daily: true, time: "09:00", enabled: true };
  assert.strictEqual(meetingDue(job, at(8, 59)), false);   // before time
  assert.strictEqual(meetingDue(job, at(9, 0)), true);     // exactly at time
  assert.strictEqual(meetingDue(job, at(11, 30)), true);   // well after time
});

test("once lastDay is set to today, the meeting is NOT due again today", () => {
  const job = { mode: "meeting", daily: true, time: "09:00", enabled: true,
    lastDay: new Date(at(12, 0)).toDateString() };
  assert.strictEqual(meetingDue(job, at(12, 0)), false);   // already ran today
  assert.strictEqual(meetingDue(job, at(23, 59)), false);
});

test("a disabled meeting is never due", () => {
  const job = { mode: "meeting", daily: true, time: "09:00", enabled: false };
  assert.strictEqual(meetingDue(job, at(9, 0)), false);
});

test("a non-daily meeting config is not due (meetings are always recurring)", () => {
  const job = { mode: "meeting", daily: false, time: "09:00", enabled: true };
  assert.strictEqual(meetingDue(job, at(9, 0)), false);
});

// --- 2. HTTP integration for POST /jobs meeting creation ------------------

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE_URL}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ statusCode: res.statusCode, data: d }));
    });
    req.on("error", reject); req.end(data);
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${path}`, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ statusCode: res.statusCode, data: d ? JSON.parse(d) : null }));
    }).on("error", reject);
  });
}

test("POST /jobs with mode:meeting creates a recurring meeting job", async (t) => {
  let reg;
  try { reg = await get("/registry"); }
  catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running"); throw err; }
  // Pick real non-ceo agents from the roster so the request validates.
  const ids = Object.keys(reg.agents || {}).filter((x) => x !== "ceo").slice(0, 2);
  if (ids.length < 1) return t.skip("No non-ceo agents in roster to test with");

  const res = await post("/jobs", {
    mode: "meeting", topic: "Test standup", agents: ids, time: "09:00", rounds: 1,
  });
  assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.data}`);
  const id = JSON.parse(res.data).id;
  assert.ok(id, "response must include an id");

  // Verify it landed correctly in the jobs list, then clean it up.
  const list = await get("/jobs");
  const job = (list.data.jobs || []).find((j) => j.id === id);
  assert.ok(job, "created job must appear in GET /jobs");
  assert.strictEqual(job.mode, "meeting");
  assert.strictEqual(job.topic, "Test standup");
  assert.strictEqual(job.daily, true);
  assert.strictEqual(job.time, "09:00");
  assert.deepStrictEqual(job.agents, ids);
  // Cleanup (don't leave test jobs in the user's office).
  await post("/jobs/update", { id, remove: true });
});

test("POST /jobs meeting rejects when no agents are given", async (t) => {
  let reg;
  try { reg = await get("/registry"); }
  catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running"); throw err; }
  const res = await post("/jobs", { mode: "meeting", topic: "x", agents: [], time: "09:00" });
  assert.strictEqual(res.statusCode, 400, "empty agents must be rejected");
});

test("POST /jobs meeting rejects when time is missing", async (t) => {
  let reg;
  try { reg = await get("/registry"); }
  catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running"); throw err; }
  const ids = Object.keys(reg.agents || {}).filter((x) => x !== "ceo").slice(0, 1);
  if (!ids.length) return t.skip("No non-ceo agents");
  const res = await post("/jobs", { mode: "meeting", topic: "x", agents: ids });
  assert.strictEqual(res.statusCode, 400, "missing time must be rejected");
});
