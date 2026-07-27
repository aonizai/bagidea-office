// Tests for the pure safety deciders in plugins/binance/index.js.
//
// This 2400-line money path had ZERO test coverage. The deciders were lifted to
// module scope precisely so they can be exercised without an exchange — every
// test here runs offline and deterministically.
//
// The rule every one of them encodes: when the input needed to decide is
// MISSING, the answer is the safe one. An exchange outage or a trimmed log must
// tighten the risk envelope, never loosen it.
const test = require("node:test");
const assert = require("node:assert");
const S = require("../../plugins/binance/index.js").__safety;

/* ------------------------------------------------------------- news gate */

test("parseEventAt reads ISO strings and epoch ms, and admits when it cannot", () => {
  assert.strictEqual(S.parseEventAt({ at: "2026-07-29T18:00:00Z" }), Date.parse("2026-07-29T18:00:00Z"));
  assert.strictEqual(S.parseEventAt({ at: 1784880000000 }), 1784880000000);
  assert.strictEqual(S.parseEventAt({ at: "not a date" }), null);
  assert.strictEqual(S.parseEventAt({}), null);
  assert.strictEqual(S.parseEventAt(null), null);
});

test("newsGate BLOCKS inside the window when `at` is an ISO string", () => {
  // The live bug: `ev.at - now` on a string is NaN, `NaN == null` is false, and
  // every comparison after it is false — so a gate marked enabled:true had
  // never once blocked a trade. news-cache.json stores ISO strings.
  const now = Date.parse("2026-07-29T17:57:00Z");
  const gate = { enabled: true, blockBeforeMin: 5, blockAfterMin: 5, highImpactOnly: true };
  const events = [{ title: "FOMC", impact: "high", at: "2026-07-29T18:00:00Z" }];
  const r = S.newsGateDecide({ events, nowMs: now, gate, cacheOk: true, cacheMtimeMs: now });
  assert.ok(r && /FOMC/.test(r), `expected a block, got ${JSON.stringify(r)}`);
});

test("newsGate allows well outside the window, and ignores low impact when configured", () => {
  const gate = { enabled: true, blockBeforeMin: 5, blockAfterMin: 5, highImpactOnly: true };
  const at = "2026-07-29T18:00:00Z";
  const far = Date.parse(at) - 4 * 24 * 3600e3;
  assert.strictEqual(S.newsGateDecide({ events: [{ title: "FOMC", impact: "high", at }], nowMs: far, gate, cacheOk: true, cacheMtimeMs: far }), null);
  const near = Date.parse(at) - 60e3;
  assert.strictEqual(S.newsGateDecide({ events: [{ title: "minor", impact: "low", at }], nowMs: near, gate, cacheOk: true, cacheMtimeMs: near }), null);
});

test("newsGate fails CLOSED: unreadable cache, stale cache, unparseable event", () => {
  const now = Date.now();
  const gate = { enabled: true, blockBeforeMin: 5, blockAfterMin: 5, highImpactOnly: true, maxCacheAgeH: 24 };
  assert.ok(S.newsGateDecide({ events: [], nowMs: now, gate, cacheOk: false, cacheMtimeMs: now }), "unreadable cache must block");
  assert.ok(S.newsGateDecide({ events: [], nowMs: now, gate, cacheOk: true, cacheMtimeMs: now - 48 * 3600e3 }), "stale cache must block");
  assert.ok(S.newsGateDecide({ events: [{ title: "x", impact: "high", at: "garbage" }], nowMs: now, gate, cacheOk: true, cacheMtimeMs: now }), "unparseable time must block");
  // A disabled gate stays out of the way entirely.
  assert.strictEqual(S.newsGateDecide({ events: [], nowMs: now, gate: { enabled: false }, cacheOk: false, cacheMtimeMs: NaN }), null);
});

test("commentary stamped with the cache's own write time never blocks", () => {
  // The live cache mixes calendar releases with running commentary. The notes
  // carry no schedule, so the writer stamps them with the scan time — which put
  // them inside the +/-5 min window on EVERY scan, i.e. a permanent block.
  // A note is identified exactly: its `at` equals the cache's `updated` field.
  const updated = Date.parse("2026-07-25T13:42:11Z");
  const gate = { enabled: true, blockBeforeMin: 5, blockAfterMin: 5, highImpactOnly: true };
  const commentary = { title: "US-Iran conflict: no new escalation details this scan", impact: "high", at: "2026-07-25T13:42:11Z" };
  const now = updated + 2 * 60e3;
  assert.strictEqual(
    S.newsGateDecide({ events: [commentary], nowMs: now, gate, cacheOk: true, cacheMtimeMs: updated, cacheUpdatedMs: updated }),
    null, "rolling commentary must not block");
  assert.strictEqual(S.isScheduledEvent(commentary, updated), false);

  // A real release keeps its own timestamp and MUST still block.
  const fomc = { title: "FOMC", impact: "high", at: "2026-07-29T18:00:00Z" };
  assert.strictEqual(S.isScheduledEvent(fomc, updated), true);
  const justBefore = Date.parse("2026-07-29T17:57:00Z");
  assert.ok(S.newsGateDecide({ events: [fomc], nowMs: justBefore, gate, cacheOk: true, cacheMtimeMs: justBefore, cacheUpdatedMs: updated }),
    "a scheduled release inside the window must still block");
});

test("with no cache `updated` field, every event counts as scheduled (fails closed)", () => {
  const gate = { enabled: true, blockBeforeMin: 5, blockAfterMin: 5, highImpactOnly: true };
  const now = Date.parse("2026-07-25T13:44:00Z");
  const ev = { title: "note", impact: "high", at: "2026-07-25T13:42:11Z" };
  assert.strictEqual(S.isScheduledEvent(ev, NaN), true, "cannot classify ⇒ treat as real");
  assert.ok(S.newsGateDecide({ events: [ev], nowMs: now, gate, cacheOk: true, cacheMtimeMs: now, cacheUpdatedMs: NaN }));
});

/* ------------------------------------------------- audit / daily trade cap */

test("tradesTodayDecide counts every entry path, not just manual orders", () => {
  const now = Date.parse("2026-07-25T12:00:00Z");
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const t = midnight.getTime();
  const log = [
    { ts: t - 3600e3, cmd: "order", ok: true },                 // yesterday
    { ts: t + 1000, cmd: "order", ok: true },
    { ts: t + 2000, cmd: "autotrade", orderOk: true },
    { ts: t + 3000, cmd: "auto-signal", orderOk: true },
    { ts: t + 4000, cmd: "auto-signal-blocked", blocked: "x" }, // never counts
    { ts: t + 5000, cmd: "order", ok: false },                  // rejected
  ];
  const r = S.tradesTodayDecide(log, now);
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.complete, true);
});

test("tradesTodayDecide fails CLOSED when the count cannot be trusted", () => {
  const now = Date.parse("2026-07-25T12:00:00Z");
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const t = midnight.getTime();
  // Unreadable log: the old code returned 0 here, i.e. a free pass.
  assert.deepStrictEqual(S.tradesTodayDecide(null, now), { count: 0, complete: false });
  // Ring already trimmed past midnight ⇒ the count is only a lower bound.
  const trimmed = [{ ts: t + 1000, cmd: "order", ok: true }];
  assert.strictEqual(S.tradesTodayDecide(trimmed, now).complete, false);
  // An empty but readable log genuinely means zero.
  assert.deepStrictEqual(S.tradesTodayDecide([], now), { count: 0, complete: true });
});

test("auditTrim drops noise before money, and keeps chronological order", () => {
  const log = [];
  for (let i = 0; i < 500; i++) log.push({ ts: i, cmd: "auto-signal-blocked" });
  for (let i = 500; i < 520; i++) log.push({ ts: i, cmd: "order", ok: true });
  const out = S.auditTrim(log, { maxMoney: 400, maxOther: 100 });
  assert.strictEqual(out.filter((e) => e.cmd === "order").length, 20, "every real fill survives");
  assert.strictEqual(out.filter((e) => e.cmd === "auto-signal-blocked").length, 100, "noise is capped");
  for (let i = 1; i < out.length; i++) assert.ok(out[i].ts >= out[i - 1].ts, "output stays sorted by ts");
});

test("auditTrim keeps the newest money entries when money exceeds its own cap", () => {
  const log = [];
  for (let i = 0; i < 500; i++) log.push({ ts: i, cmd: "order", ok: true });
  const out = S.auditTrim(log, { maxMoney: 400, maxOther: 100 });
  assert.strictEqual(out.length, 400);
  assert.strictEqual(out[0].ts, 100, "oldest dropped, newest kept");
});

/* ------------------------------------------------------------------ dedup */

test("dedup is PER KEY — two signals in one tick both announce, neither repeats", () => {
  // The old dedup was a single string: with two qualifying signals the key
  // rotated every iteration, so both re-fired on the next tick.
  const d = S.makeDedup({ ttlMs: 1000 });
  const t = 1000;
  assert.strictEqual(d.fresh("BTCUSDT:A:bull", t), true);
  assert.strictEqual(d.fresh("ETHUSDT:A:bull", t), true);
  assert.strictEqual(d.fresh("BTCUSDT:A:bull", t + 1), false, "same key must not re-fire");
  assert.strictEqual(d.fresh("ETHUSDT:A:bull", t + 1), false);
  assert.strictEqual(d.fresh("BTCUSDT:A:bull", t + 2000), true, "after the TTL it may re-announce");
});

/* ------------------------------------------------------- emergency close */

test("emergencyOutcome declares flat ONLY on positive proof", () => {
  // unknown ≡ naked. Every row but the last means "assume still open".
  assert.deepStrictEqual(S.emergencyOutcome({ closeOk: false, verifyOk: true, verifyAmt: 0 }),
    { flat: false, reason: "close-rejected" });
  assert.deepStrictEqual(S.emergencyOutcome({ closeOk: true, verifyOk: false, verifyAmt: 0 }),
    { flat: false, reason: "verify-failed" });
  assert.deepStrictEqual(S.emergencyOutcome({ closeOk: true, verifyOk: true, verifyAmt: 0.5 }),
    { flat: false, reason: "still-open" });
  assert.deepStrictEqual(S.emergencyOutcome({ closeOk: true, verifyOk: true, verifyAmt: 0 }),
    { flat: true, reason: null });
  // A short position reports a negative amount — magnitude is what matters.
  assert.strictEqual(S.emergencyOutcome({ closeOk: true, verifyOk: true, verifyAmt: -0.4 }).flat, false);
});

/* ------------------------------------------------------------ exit result */

test("a rejected close keeps tracking and invents no PnL", () => {
  const r = S.exitOutcome({ orderOk: false, avgPrice: 0, mark: 100 });
  assert.strictEqual(r.shouldRemove, false, "the position must stay tracked");
  assert.strictEqual(r.exitPrice, null, "no exit price may be fabricated");
  assert.strictEqual(r.pnlSource, null);
});

test("a filled close prefers the real fill price over the polled mark", () => {
  assert.deepStrictEqual(S.exitOutcome({ orderOk: true, avgPrice: 101.5, mark: 100 }),
    { shouldRemove: true, exitPrice: 101.5, pnlSource: "fill" });
  // avgPrice "0" is what a MARKET response carries before the fill is booked.
  assert.deepStrictEqual(S.exitOutcome({ orderOk: true, avgPrice: 0, mark: 100 }),
    { shouldRemove: true, exitPrice: 100, pnlSource: "estimated-from-mark" });
});

/* --------------------------------------------------- structural assertions */

test("requiring the plugin module starts nothing (no timers, no I/O)", () => {
  // The research harness and these tests both require this file directly. If a
  // timer or an fs write ever moved to module scope, that would start a live
  // trading loop inside a test run.
  const m = require("../../plugins/binance/index.js");
  assert.strictEqual(typeof m, "function", "module.exports must stay the factory");
  assert.ok(m.__safety, "safety deciders are exported for tests");
});

test("blocked signals and dry runs are NOT classified as money entries", () => {
  // They used to share one 200-entry ring with real fills; 79 of 200 slots were
  // blocked signals, which is enough to trim a day of fills out from under the
  // daily cap.
  for (const c of ["auto-signal-blocked", "order-dry", "monitor-error"])
    assert.ok(!S.AUDIT_MONEY_CMDS.has(c), `${c} must be noise`);
  for (const c of ["order", "autotrade", "auto-signal", "exit", "exit-failed", "emergency-close", "close", "stoploss"])
    assert.ok(S.AUDIT_MONEY_CMDS.has(c), `${c} must be on the money trail`);
});

/* ------------------------------------------------------------- ownership */

test("client order ids fit Binance's charset and do not collide", () => {
  const seen = new Set();
  const re = /^[.A-Za-z0-9_-]{1,36}$/;
  for (let i = 0; i < 10000; i++) {
    const id = S.makeClientOrderId("as", 1784988298387 + i);
    assert.ok(re.test(id), `bad id: ${id}`);
    assert.ok(S.isDeskTagged(id));
    seen.add(id);
  }
  assert.ok(seen.size > 9900, `too many collisions: ${seen.size}/10000`);
  assert.ok(!S.isDeskTagged("x-NqBcVsE4Xk1"), "an exchange-generated id is not ours");
  assert.ok(!S.isDeskTagged(""), "a missing id is not ours");
});

test("classifyPosition: ours only when EVERY opening fill carries our tag", () => {
  const since = 1000;
  const mk = (o) => ({ status: "FILLED", side: "BUY", executedQty: "1", time: 2000, ...o });
  // Fully tagged ⇒ desk.
  assert.strictEqual(S.classifyPosition({
    positionAmt: "1", tracked: false, taggingSinceMs: since,
    orders: [mk({ clientOrderId: "bd-as-lz9k2p-x7f3" })],
  }), "desk");
  // One untagged fill in the opening set ⇒ foreign. Not "mostly ours".
  assert.strictEqual(S.classifyPosition({
    positionAmt: "2", tracked: false, taggingSinceMs: since,
    orders: [mk({ clientOrderId: "bd-as-lz9k2p-x7f3" }), mk({ clientOrderId: "web_manual_123" })],
  }), "foreign");
  // Opened before tagging existed ⇒ unknown, forever.
  assert.strictEqual(S.classifyPosition({
    positionAmt: "1", tracked: false, taggingSinceMs: 5000,
    orders: [mk({ clientOrderId: "bd-as-lz9k2p-x7f3", time: 4000 })],
  }), "unknown");
  // Order history unreadable ⇒ unknown (never assume it is ours).
  assert.strictEqual(S.classifyPosition({ positionAmt: "1", tracked: false, orders: null, taggingSinceMs: since }), "unknown");
  // Fills do not add up to the position ⇒ unknown.
  assert.strictEqual(S.classifyPosition({
    positionAmt: "5", tracked: false, taggingSinceMs: since,
    orders: [mk({ clientOrderId: "bd-as-a-b" })],
  }), "unknown");
  // Already in our own store ⇒ desk without needing history.
  assert.strictEqual(S.classifyPosition({ positionAmt: "1", tracked: true, orders: null }), "desk");
});

test("stopCoverage separates 'no stop' from 'could not check' — never conflates them", () => {
  const long = { positionAmt: "1" };
  assert.deepStrictEqual(S.stopCoverage({ ...long, algos: [{ side: "SELL", closePosition: "true" }] }),
    { covered: true, unverified: false, reason: null });
  // A stop on the wrong side does not protect a long.
  assert.strictEqual(S.stopCoverage({ ...long, algos: [{ side: "BUY", closePosition: "true" }] }).covered, false);
  assert.strictEqual(S.stopCoverage({ ...long, algos: [{ side: "BUY", closePosition: "true" }] }).unverified, false);
  // Quantity-based coverage counts too.
  assert.strictEqual(S.stopCoverage({ ...long, algos: [{ side: "SELL", origQty: "1" }] }).covered, true);
  assert.strictEqual(S.stopCoverage({ ...long, algos: [{ side: "SELL", origQty: "0.4" }] }).covered, false);
  // API failure and unrecognised rows are UNVERIFIED, not uncovered.
  assert.deepStrictEqual(S.stopCoverage({ ...long, algos: null }),
    { covered: false, unverified: true, reason: "algo-read-failed" });
  assert.strictEqual(S.stopCoverage({ ...long, algos: [{ algoId: 1 }] }).unverified, true);
  // Flat is trivially covered.
  assert.strictEqual(S.stopCoverage({ positionAmt: "0", algos: [] }).covered, true);
});

test("a naked FOREIGN position produces an alert and ZERO orders", () => {
  // This is the standing rule ("never touch the CEO's positions") written as an
  // assertion rather than a comment. If reconcileDecide ever emits an order for
  // a position it cannot prove is ours, this test fails.
  const live = [{ symbol: "ETHUSDT", positionAmt: "1", entryPrice: "1800" }];
  const d = S.reconcileDecide({
    live, tracked: [], classes: { ETHUSDT: "foreign" },
    coverage: { ETHUSDT: { covered: false, unverified: false, reason: "no-stop" } },
    state: {}, nowMs: 1e12,
  });
  assert.deepStrictEqual(d.replace, [], "no order may EVER be sent for a foreign position");
  assert.deepStrictEqual(d.adopt, [], "a foreign position is never adopted into our store");
  assert.strictEqual(d.pause, null, "someone else's book does not pause our desk");
  assert.strictEqual(d.alerts.length, 1);
  assert.strictEqual(d.alerts[0].kind, "foreign-naked");
  // `unknown` must behave identically — it differs only in wording.
  const u = S.reconcileDecide({
    live, tracked: [], classes: { ETHUSDT: "unknown" },
    coverage: { ETHUSDT: { covered: false, unverified: false, reason: "no-stop" } },
    state: {}, nowMs: 1e12,
  });
  assert.deepStrictEqual(u.replace, []);
  assert.deepStrictEqual(u.adopt, []);
});

test("our own naked position: one tick observes, two ticks re-place, then it stops and pauses", () => {
  const live = [{ symbol: "BTCUSDT", positionAmt: "0.01", entryPrice: "64000" }];
  const tracked = [{ symbol: "BTCUSDT", stop: 63000, managed: true }];
  const classes = { BTCUSDT: "desk" };
  const coverage = { BTCUSDT: { covered: false, unverified: false, reason: "no-stop" } };
  const t0 = 1e12;

  const a = S.reconcileDecide({ live, tracked, classes, coverage, state: {}, nowMs: t0 });
  assert.deepStrictEqual(a.replace, [], "a single uncovered tick could be a race — observe first");

  const b = S.reconcileDecide({ live, tracked, classes, coverage, state: a.state, nowMs: t0 + 30e3 });
  assert.strictEqual(b.replace.length, 1);
  assert.deepStrictEqual(b.replace[0], { symbol: "BTCUSDT", stop: 63000, side: "SELL", qty: 0.01 });

  // Attempts are budgeted and spaced; after the budget it pauses instead of looping orders.
  let st = b.state;
  for (let i = 0; i < 6; i++) {
    const r = S.reconcileDecide({ live, tracked, classes, coverage, state: st, nowMs: t0 + (i + 2) * 700e3 });
    st = r.state;
    if (r.pause) { assert.match(r.pause, /stop-replace-exhausted/); return; }
  }
  assert.fail("should have exhausted the replace budget and paused");
});

test("an adopted position with no known stop pauses instead of guessing one", () => {
  const live = [{ symbol: "SOLUSDT", positionAmt: "1", entryPrice: "74" }];
  const d = S.reconcileDecide({
    live, tracked: [{ symbol: "SOLUSDT", stop: null, managed: false }],
    classes: { SOLUSDT: "desk" },
    coverage: { SOLUSDT: { covered: false, unverified: false, reason: "no-stop" } },
    state: {}, nowMs: 1e12,
  });
  assert.deepStrictEqual(d.replace, [], "inventing a stop price is not allowed");
  assert.match(d.pause, /naked-no-known-stop/);
});

test("an untracked position of OURS is adopted for watching, not managing", () => {
  const d = S.reconcileDecide({
    live: [{ symbol: "BNBUSDT", positionAmt: "0.5", entryPrice: "565" }],
    tracked: [], classes: { BNBUSDT: "desk" },
    coverage: { BNBUSDT: { covered: true, unverified: false, reason: null } },
    state: {}, nowMs: 1e12,
  });
  assert.strictEqual(d.adopt.length, 1);
  assert.strictEqual(d.adopt[0].symbol, "BNBUSDT");
  assert.deepStrictEqual(d.replace, []);
});

test("unverified coverage never triggers an action, and only alerts after several ticks", () => {
  const live = [{ symbol: "XRPUSDT", positionAmt: "10", entryPrice: "1.08" }];
  const tracked = [{ symbol: "XRPUSDT", stop: 1.05, managed: true }];
  const classes = { XRPUSDT: "desk" };
  const coverage = { XRPUSDT: { covered: false, unverified: true, reason: "algo-read-failed" } };
  let st = {}, alerted = false;
  for (let i = 0; i < 5; i++) {
    const r = S.reconcileDecide({ live, tracked, classes, coverage, state: st, nowMs: 1e12 + i * 30e3 });
    assert.deepStrictEqual(r.replace, [], "an unreadable algo list is NOT evidence of a missing stop");
    assert.strictEqual(r.pause, null);
    if (r.alerts.length) alerted = true;
    st = r.state;
  }
  assert.ok(alerted, "persistent inability to verify must eventually be reported");
});

/* ------------------------------------------------- portfolio + drawdown */

test("hwmDecide returns the most severe breached level and never acts on garbage", () => {
  const levels = [
    { drawdown_pct: 4, action: "autoTrade off" },
    { drawdown_pct: 8, action: "pause" },
    { drawdown_pct: 12, action: "stay paused" },
  ];
  assert.strictEqual(S.hwmDecide({ equity: 5000, hwm: 5000, levels }), null, "no drawdown, no action");
  assert.strictEqual(S.hwmDecide({ equity: 4850, hwm: 5000, levels }), null, "3% is under the first rung");
  assert.strictEqual(S.hwmDecide({ equity: 4790, hwm: 5000, levels }).drawdown_pct, 4);
  assert.strictEqual(S.hwmDecide({ equity: 4400, hwm: 5000, levels }).drawdown_pct, 12, "most severe rung wins");
  // Missing data must never trigger a tightening built on garbage.
  assert.strictEqual(S.hwmDecide({ equity: 0, hwm: 5000, levels }), null);
  assert.strictEqual(S.hwmDecide({ equity: 5000, hwm: NaN, levels }), null);
});

test("sameDirectionDecide counts direction, not symbols — 0.65 corr makes them one bet", () => {
  const open = [
    { symbol: "BTCUSDT", positionAmt: "0.01" },   // long
    { symbol: "ETHUSDT", positionAmt: "1" },      // long
    { symbol: "SOLUSDT", positionAmt: "-5" },     // short
  ];
  assert.ok(S.sameDirectionDecide({ open, side: "BUY", max: 2 }), "third same-direction long is blocked");
  assert.strictEqual(S.sameDirectionDecide({ open, side: "SELL", max: 2 }), null, "a second short is a different bet");
  assert.strictEqual(S.sameDirectionDecide({ open, side: "BUY", max: 0 }), null, "unset cap = no rule");
  assert.strictEqual(S.sameDirectionDecide({ open: null, side: "BUY", max: 2 }), null, "no data, no block (the livePositions gate already failed closed upstream)");
});

test("costFloorDecide blocks geometry that cannot pay for itself", () => {
  // Yesterday's live practice trade: XRPUSDT stop 0.27% wide = 0.67R round-trip
  // cost. No realistic edge survives that; the floor blocks it with arithmetic.
  assert.ok(S.costFloorDecide({ entry: 1.1077, stop: 1.1047, minStopPct: 0.6 }),
    "a 0.27% stop must be blocked at a 0.6% floor");
  assert.strictEqual(S.costFloorDecide({ entry: 100, stop: 98.6, minStopPct: 0.6 }), null,
    "a 1.4% stop passes");
  assert.strictEqual(S.costFloorDecide({ entry: 100, stop: 98.6, minStopPct: 0 }), null,
    "no floor configured = no rule");
  assert.strictEqual(S.costFloorDecide({ entry: 100, stop: null, minStopPct: 0.6 }), null,
    "a missing stop is someone else's rejection (mandatoryStop), not a false block here");
});
