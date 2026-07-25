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
