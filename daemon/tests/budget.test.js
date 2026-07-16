// Tests for the cost-budget feature: threshold math (budgetState), the
// new-work gate (budgetAllowsNewWork), and the HTTP endpoints
// GET /stats/budget + POST /registry/budget.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const BASE_URL = "http://127.0.0.1:8787";

// --- 1. Pure-math characterization of the budget thresholds ---------------
// Mirrors budgetState() + the status derivation in GET /stats/budget. Daily
// and monthly caps are independent; the worse of the two wins.

// Derive {status, over} from two {budget, spent} caps (matches the server).
function budgetStatus(daily, monthly) {
  const pct = (b) => (b.budget > 0 ? b.spent / b.budget : 0);
  const dPct = pct(daily), mPct = pct(monthly);
  const status = (!daily.budget && !monthly.budget) ? "off"
    : (dPct >= 1 || mPct >= 1) ? "over"
    : (dPct >= 0.8 || mPct >= 0.8) ? "warn"
    : "ok";
  const over = dPct >= 1 || mPct >= 1;
  return { status, over };
}

test("no caps set → status 'off', new work allowed", () => {
  const r = budgetStatus({ budget: 0, spent: 5 }, { budget: 0, spent: 50 });
  assert.strictEqual(r.status, "off");
  assert.strictEqual(r.over, false);
});

test("spend under 80% → 'ok'", () => {
  const r = budgetStatus({ budget: 10, spent: 5 }, { budget: 0, spent: 0 });
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.over, false);
});

test("spend at/above 80% but under 100% → 'warn'", () => {
  assert.strictEqual(budgetStatus({ budget: 10, spent: 8 }, { budget: 0, spent: 0 }).status, "warn");
  assert.strictEqual(budgetStatus({ budget: 10, spent: 9.9 }, { budget: 0, spent: 0 }).status, "warn");
});

test("spend at/above 100% → 'over' and new work blocked", () => {
  const r = budgetStatus({ budget: 10, spent: 10 }, { budget: 0, spent: 0 });
  assert.strictEqual(r.status, "over");
  assert.strictEqual(r.over, true);
});

test("monthly cap can drive 'over' even if daily is fine", () => {
  const r = budgetStatus({ budget: 10, spent: 1 }, { budget: 100, spent: 100 });
  assert.strictEqual(r.status, "over");
  assert.strictEqual(r.over, true);
});

test("the worse of the two caps determines 'warn'", () => {
  // daily at 50% (ok) but monthly at 85% (warn) → warn
  const r = budgetStatus({ budget: 10, spent: 5 }, { budget: 100, spent: 85 });
  assert.strictEqual(r.status, "warn");
});

// --- 2. HTTP integration for the budget endpoints -------------------------

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${path}`, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ statusCode: res.statusCode, data: d ? JSON.parse(d) : null }));
    }).on("error", reject);
  });
}
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE_URL}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ statusCode: res.statusCode, data: d ? JSON.parse(d) : null }));
    });
    req.on("error", reject); req.end(data);
  });
}

test("GET /stats/budget returns daily/monthly spend + a status", async (t) => {
  let res;
  try { res = await get("/stats/budget"); }
  catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running"); throw err; }
  if (res.statusCode === 404) return t.skip("Live daemon predates /stats/budget");
  assert.strictEqual(res.statusCode, 200);
  assert.ok(["off", "ok", "warn", "over"].includes(res.data.status));
  assert.ok(typeof res.data.over === "boolean");
  for (const k of ["daily", "monthly"]) {
    assert.ok(typeof res.data[k].budget === "number");
    assert.ok(typeof res.data[k].spent === "number");
    assert.ok(typeof res.data[k].pct === "number");
  }
});

test("POST /registry/budget sets caps and they round-trip via GET", async (t) => {
  let probe;
  try { probe = await get("/stats/budget"); }
  catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running"); throw err; }
  if (probe.statusCode === 404) return t.skip("Live daemon predates /stats/budget");

  // Set a harmless test cap (large enough it won't trip 'over'), read it back,
  // then restore the original values so we don't change the user's office.
  const origDaily = probe.data.daily.budget, origMonthly = probe.data.monthly.budget;
  const set = await post("/registry/budget", { dailyBudgetUsd: 9999, monthlyBudgetUsd: 99999 });
  assert.strictEqual(set.statusCode, 200);
  assert.strictEqual(set.data.dailyBudgetUsd, 9999);
  const after = await get("/stats/budget");
  assert.strictEqual(after.data.daily.budget, 9999);
  // Restore.
  await post("/registry/budget", { dailyBudgetUsd: origDaily, monthlyBudgetUsd: origMonthly });
});
