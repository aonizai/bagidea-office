// Tests for the trade-teams paper engine (plugins/trade-teams/engine.js).
//
// Two properties carry the arena's honesty and both are pinned here:
//  1. The physics can't be gamed — pessimistic fills, stop-wins-tie,
//     modify can't conjure profit or widen risk, caps bind everyone.
//  2. The control team is deterministic and signal-blind — the yardstick
//     the leaderboard is measured against must itself be reproducible.
// Plus the structural safety rule: this plugin's exchange egress is a frozen
// READ-ONLY allowlist — asserted against the actual index.js source.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../../plugins/trade-teams/engine");

const T = 1700000000000;
const mk = (team = "test") => E.newBook(team);

test("mandatory stop / wrong-side stop / cost floor all reject", () => {
  const b = mk();
  assert.match(E.placeOrder(b, { symbol: "BTCUSDT", side: "LONG", riskUsd: 50 }, 100, T).reject, /mandatory-stop/);
  assert.match(E.placeOrder(b, { symbol: "BTCUSDT", side: "LONG", stop: 101 }, 100, T).reject, /stop-wrong-side/);
  assert.match(E.placeOrder(b, { symbol: "BTCUSDT", side: "LONG", stop: 99.5 }, 100, T).reject, /cost-floor/);
  assert.equal(b.positions.length, 0);
});

test("market fill pays slippage against you and fee on notional", () => {
  const b = mk();
  const r = E.placeOrder(b, { symbol: "BTCUSDT", side: "LONG", riskUsd: 100, stop: 98 }, 100, T);
  assert.ok(r.ok);
  const p = r.position;
  assert.ok(p.entry > 100, "long entry must be worse than mark");
  assert.ok(Math.abs(p.entry - 100.03) < 1e-9, "slip 0.03%");
  const expectedFee = p.qty * p.entry * 0.0006;
  assert.ok(Math.abs(p.feePaid - expectedFee) < 0.01);
  assert.ok(Math.abs(p.qty * (p.entry - p.stop) - 100) < 0.01, "risk sized at the actual fill");
});

test("risk cap (1% equity) and notional cap (50%) bind", () => {
  const b = mk();
  const r = E.placeOrder(b, { symbol: "BTCUSDT", side: "LONG", riskUsd: 5000, stop: 95 }, 100, T);
  assert.ok(r.ok);
  assert.ok(r.position.riskUsd <= 100.01, "risk clamped to 1% of $10k");
  const b2 = mk();
  const v = E.validateOrder(b2, { symbol: "X", side: "LONG", riskUsd: 100, stop: 98.9 }, 100);
  assert.match(v.reject || "", /notional-cap/, "1.1% stop with $100 risk = $9090 notional > 50%");
});

test("one-per-symbol and max-concurrent bind", () => {
  const b = mk();
  E.placeOrder(b, { symbol: "AAA", side: "LONG", stop: 98 }, 100, T);
  assert.match(E.placeOrder(b, { symbol: "AAA", side: "SHORT", stop: 102 }, 100, T).reject, /one-per-symbol/);
  E.placeOrder(b, { symbol: "BBB", side: "LONG", stop: 98 }, 100, T);
  E.placeOrder(b, { symbol: "CCC", side: "LONG", stop: 98 }, 100, T);
  assert.match(E.placeOrder(b, { symbol: "DDD", side: "LONG", stop: 98 }, 100, T).reject, /max-concurrent/);
});

test("stop fills at the MARK (pessimistic), target at the LEVEL", () => {
  const b = mk();
  E.placeOrder(b, { symbol: "AAA", side: "LONG", riskUsd: 50, stop: 98, target: 105 }, 100, T);
  // gap far through the stop: exit at mark 95 (worse), never at the stop 98
  const { events } = E.tickBook(b, { AAA: 95 }, T + 1000);
  assert.equal(events[0].type, "stop");
  assert.ok(events[0].trade.exit < 95.001, "filled at mark, not at the friendlier stop level");
  const b2 = mk();
  E.placeOrder(b2, { symbol: "AAA", side: "LONG", riskUsd: 50, stop: 98, target: 105 }, 100, T);
  // gap far through the target: exit pays only the target level
  const r2 = E.tickBook(b2, { AAA: 120 }, T + 1000);
  assert.equal(r2.events[0].type, "target");
  assert.ok(r2.events[0].trade.exit <= 105, "favorable gap pays only the target");
});

test("one tick crossing both stop and target → the stop wins", () => {
  // With point-mark ticks a double-cross can't arise through the order door
  // (validation forbids the geometry), so inject the pathological position
  // directly and prove the EVALUATION ORDER: stop is checked first, always.
  const b = mk();
  b.positions.push({ id: "x-1", symbol: "AAA", side: "LONG", qty: 1, entry: 100,
    stop: 98, target: 97, riskUsd: 50, openedAt: T, feePaid: 0, note: null });
  const ev = E.tickBook(b, { AAA: 96 }, T + 1000).events;
  assert.equal(ev.length, 1, "one position closes once, not twice");
  assert.equal(ev[0].type, "stop", "stop evaluated before target on the same tick");
});

test("resting limit fills when crossed; stillborn fill stops out same tick", () => {
  const b = mk();
  const r = E.placeOrder(b, { symbol: "AAA", side: "LONG", riskUsd: 50, stop: 90, limit: 95 }, 100, T);
  assert.ok(r.resting);
  assert.equal(b.positions.length, 0);
  const ev = E.tickBook(b, { AAA: 94.5 }, T + 1000).events;
  assert.equal(ev[0].type, "limit-fill");
  assert.equal(b.positions.length, 1);
  assert.ok(Math.abs(b.positions[0].entry - 95 * 1.0003) < 1e-6, "limit fill at limit+slip");
  // stillborn: mark already through the stop when the limit crosses
  const b2 = mk();
  E.placeOrder(b2, { symbol: "AAA", side: "LONG", riskUsd: 50, stop: 94, limit: 95 }, 100, T);
  const ev2 = E.tickBook(b2, { AAA: 93 }, T + 1000).events;
  assert.deepEqual(ev2.map((e) => e.type), ["limit-fill", "stop"]);
  assert.equal(b2.positions.length, 0, "no free pass through the stop");
});

test("modify cannot conjure profit or widen risk", () => {
  const b = mk();
  E.placeOrder(b, { symbol: "AAA", side: "LONG", riskUsd: 50, stop: 98 }, 100, T);
  const id = b.positions[0].id;
  assert.match(E.modifyPosition(b, id, { stop: 101 }, 100).reject, /stop-would-trigger-now/);
  assert.match(E.modifyPosition(b, id, { target: 99 }, 100).reject, /target-would-trigger-now/);
  assert.match(E.modifyPosition(b, id, { stop: 97 }, 100).reject, /stop-widen-forbidden/);
  // the legit breakeven move: price ran up, stop tightens to entry
  assert.ok(E.modifyPosition(b, id, { stop: 100.5 }, 102).ok, "BE move above entry is legal once price is past it");
});

test("drawdown circuit pauses the team and blocks new entries", () => {
  const b = mk();
  b.cash = 5500;   // simulate a -45% book
  const { events } = E.tickBook(b, {}, T);
  assert.equal(events[0].type, "team-paused");
  assert.match(E.placeOrder(b, { symbol: "AAA", side: "LONG", stop: 98 }, 100, T).reject, /team-paused/);
});

test("control team is deterministic, capped, and can pass", () => {
  const b = mk("control");
  const syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const marks = { BTCUSDT: 64000, ETHUSDT: 1900, SOLUSDT: 74 };
  const a1 = E.controlDecide("seed-1", 7, b, syms, marks);
  const a2 = E.controlDecide("seed-1", 7, b, syms, marks);
  assert.deepEqual(a1, a2, "same seed+cycle → same decision");
  let traded = 0, passed = 0;
  for (let i = 0; i < 200; i++) {
    const d = E.controlDecide("seed-x", i, b, syms, marks);
    if (d) { traded++; const v = E.validateOrder(b, d, marks[d.symbol]); assert.ok(v.ok, v.reject); }
    else passed++;
  }
  assert.ok(traded > 50 && passed > 50, "coin flip actually flips");
});

test("leaderboard ranks by equity and reports process metrics", () => {
  const books = { a: mk("a"), b: mk("b") };
  E.placeOrder(books.a, { symbol: "AAA", side: "LONG", riskUsd: 100, stop: 98 }, 100, T);
  E.tickBook(books.a, { AAA: 90 }, T + 1000);   // full loss
  const rows = E.leaderboard(books, {});
  assert.equal(rows[0].team, "b");
  assert.equal(rows[1].team, "a");
  assert.ok(rows[1].avgCostR > 0, "cost-in-R is a first-class metric");
  assert.ok(rows[1].avgPnlR < -0.9, "a stopped trade costs about -1R and change");
});

test("STRUCTURAL: index.js egress is a frozen read-only allowlist, loopback only", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "plugins", "trade-teams", "index.js"), "utf8");
  assert.ok(src.includes('Object.freeze(["price", "ticker", "klines", "funding", "status"])'),
    "the read-only allowlist must exist verbatim");
  assert.ok(!/https\./.test(src), "no direct exchange access — loopback only");
  const httpCalls = (src.match(/http\.request/g) || []).length;
  assert.equal(httpCalls, 1, "exactly one egress call site (the guarded loopback)");
  for (const forbidden of ['"order"', '"autotrade"', '"stoploss"', '"cancel"', '"close"', '"pause"', '"leverage"'])
    assert.ok(!src.includes(`callBinance(${forbidden}`), `must never call binance ${forbidden}`);
});

/* ---- red-team regressions (adversarial review 2026-07-28) ---- */

test("RED: NaN stop/target through modify is rejected, never written", () => {
  const b = mk();
  E.placeOrder(b, { symbol: "AAA", side: "LONG", riskUsd: 50, stop: 98 }, 100, T);
  const id = b.positions[0].id;
  assert.match(E.modifyPosition(b, id, { stop: Number("1.2.3") }, 100).reject, /stop-invalid/);
  assert.match(E.modifyPosition(b, id, { target: NaN }, 100).reject, /target-invalid/);
  assert.ok(Number.isFinite(b.positions[0].stop), "stop must stay a number");
});

test("RED: a limit on the wrong side of the mark is not a resting order", () => {
  const b = mk();
  assert.match(E.placeOrder(b, { symbol: "AAA", side: "LONG", stop: 107.8, limit: 110 }, 100, T).reject,
    /limit-wrong-side/);
  assert.match(E.placeOrder(b, { symbol: "AAA", side: "SHORT", stop: 92, limit: 90 }, 100, T).reject,
    /limit-wrong-side/);
});

test("RED: stillborn limit fill settles at the STOP level — gap loss bounded near -1R", () => {
  const b = mk();
  E.placeOrder(b, { symbol: "AAA", side: "LONG", riskUsd: 50, stop: 93.5, limit: 95 }, 100, T);
  const ev = E.tickBook(b, { AAA: 80 }, T + 1000).events;   // 20% gap through everything
  const stop = ev.find((e) => e.type === "stop");
  assert.ok(stop, "stillborn close still happens");
  assert.ok(stop.trade.exit > 93.4, "settled at the stop level, not the gapped mark");
  assert.ok(stop.trade.pnlR > -1.3, `bounded loss, got ${stop.trade.pnlR}R`);
});

test("RED: a scratch that rounds to -0 is a loss, not a win", () => {
  const b = mk();
  E.placeOrder(b, { symbol: "AAA", side: "LONG", riskUsd: 100, stop: 98 }, 100, T);
  const r = E.manualClose(b, b.positions[0].id, 100.18014, T + 1000);
  assert.ok(r.ok);
  assert.equal(b.stats.wins, 0, "breakeven-ish scratch must not count as a win");
  assert.equal(b.stats.losses, 1);
  assert.ok(!Object.is(r.trade.pnlUsd, -0), "-0 is normalized");
});

test("RED: costR carries slippage, not just fees (ratified model = both)", () => {
  const b = mk();
  E.placeOrder(b, { symbol: "AAA", side: "LONG", riskUsd: 100, stop: 98 }, 100, T);
  const ev = E.tickBook(b, { AAA: 98 }, T + 1000).events;
  const t = ev[0].trade;
  assert.ok(t.costR >= 0.08 && t.costR <= 0.10,
    `2% stop → fee 0.06R + slip 0.03R ≈ 0.09R, got ${t.costR}`);
  assert.ok(t.slipUsd > 0);
});

test("RED: caps size against LIVE equity when the full mark map is supplied", () => {
  const b = mk();
  b.positions.push({ id: "x-9", symbol: "BBB", side: "LONG", qty: 50, entry: 100,
    stop: 90, target: null, riskUsd: 100, openedAt: T, feePaid: 0, slipEntryUsd: 0, note: null });
  const marks = { AAA: 100, BBB: 40 };   // BBB is -$3000 unrealized → live equity ~$7000
  const v = E.validateOrder(b, { symbol: "AAA", side: "LONG", stop: 97 }, 100, undefined, marks);
  assert.ok(v.ok, v.reject);
  assert.ok(v.riskUsd <= 70.01, `risk must be 1% of LIVE equity (~$70), got ${v.riskUsd}`);
});

test("RED: drawdown rebase makes amend-unpause stick for a flat team", () => {
  const b = mk();
  b.cash = 5500;
  E.tickBook(b, {}, T);
  assert.ok(b.paused);
  // the amend path (index) unpauses and rebases; emulate it:
  b.paused = false; b.pausedReason = null; b.ddRebase = 5500;
  const again = E.tickBook(b, {}, T + 30000).events;
  assert.equal(again.length, 0, "no immediate re-pause after rebase");
  b.cash = 4900;   // another -11% from the acknowledged base
  assert.equal(E.tickBook(b, {}, T + 60000).events[0].type, "team-paused", "floor still exists below the rebase");
});
