// Tests for the smc-radar engine (plugins/smc-radar/engine.js).
//
// Two things are being pinned here, and the second one is the reason this file
// exists at all:
//
//  1. The geometry is right — an FVG is a strict 3-candle imbalance, a BOS is a
//     CLOSE through an opposing swing (never a wick), a sweep is a raid that
//     closes back inside (never a breakout). Each of those ships with its
//     control fixture, because a detector that cannot tell the difference
//     between a sweep and a breakout is worse than no detector.
//
//  2. There is NO LOOKAHEAD. A zone's formation facts must be byte-identical
//     whether the engine sees 240 bars or 300, and its lifecycle may only ever
//     move forward. The naive "same output for a prefix" test would be WRONG
//     (a full run legitimately sees later zones and later fills), so the
//     assertion is formation-immutability + monotone lifecycle instead.
const test = require("node:test");
const assert = require("node:assert");
const eng = require("../../plugins/smc-radar/engine");

const TF = 900000; // 15m
const OPTS = { tf: "15m", htfTf: "1h", tfMs: TF };

/** rows: [open, high, low, close, volume?] -> candle array with 15m spacing */
function mk(rows, startIdx = 0) {
  return rows.map((r, k) => {
    const i = startIdx + k;
    return {
      t: i * TF, open: r[0], high: r[1], low: r[2], close: r[3],
      volume: r[4] === undefined ? 100 : r[4], closeT: i * TF + TF - 1,
    };
  });
}
const flat = (n, base = 100) =>
  Array.from({ length: n }, () => [base, base + 0.5, base - 0.5, base]);

function atrSafeOf(candles, cfg = eng.CFG) {
  return eng._ta
    .atrSeries(candles, cfg.atrPeriod)
    .map((v, i) => Math.max(v, (candles[i].close * cfg.atrFloorPct) / 100));
}
const findZones = (candles, cfg = eng.CFG) =>
  eng._fvg.findFvgs(candles, atrSafeOf(candles, cfg), TF, cfg);

/* ------------------------------------------------------------------ TA */

test("atrSeries matches the desk's simple-mean atr (plugins/binance/index.js:224)", () => {
  // The desk's atr() is a simple mean of the last N true ranges, NOT Wilder.
  // If these ever diverge, every ATR-normalised threshold in smc-radar silently
  // means something different from the same threshold in the binance plugin.
  function deskAtr(cs, period = 14) {
    let s = 0, n = 0;
    for (let i = Math.max(1, cs.length - period); i < cs.length; i++) {
      const c = cs[i], p = cs[i - 1];
      s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      n++;
    }
    return n ? s / n : 0;
  }
  const c = mk(Array.from({ length: 80 }, (_, i) => [100 + i * 0.1, 101.2 + i * 0.1, 99 + i * 0.1, 100.6 + i * 0.1]));
  assert.ok(Math.abs(eng._ta.atrSeries(c, 14)[c.length - 1] - deskAtr(c, 14)) < 1e-12);
});

test("avgVolAt excludes the current bar", () => {
  const c = mk([[1, 2, 0, 1, 10], [1, 2, 0, 1, 20], [1, 2, 0, 1, 999]]);
  assert.strictEqual(eng._ta.avgVolAt(c, 2, 20), 15);
});

/* ----------------------------------------------------------------- FVG */

// A quiet tape (range ~1.0) with one displacement bar at index 20 that leaves
// daylight between bar 19's high (100.5) and bar 21's low (102.0).
const FVG_ROWS = [
  ...flat(20),
  [100.4, 102.6, 100.3, 102.5, 400],
  [102.5, 103.0, 102.0, 102.8],
  ...Array.from({ length: 6 }, () => [102.8, 103.2, 102.4, 102.9]),
];

test("F1 — clean bullish FVG is found with the right boundaries", () => {
  const { zones } = findZones(mk(FVG_ROWS));
  assert.strictEqual(zones.length, 1);
  const z = zones[0];
  assert.strictEqual(z.dir, "bull");
  assert.strictEqual(z.bottom, 100.5);
  assert.strictEqual(z.top, 102);
  assert.strictEqual(z.i, 20);
  assert.strictEqual(z.confirmIdx, 21, "a zone is not knowable until bar i+1 closes");
  assert.strictEqual(z.quality, true);
});

test("F1b — an exact touch is NOT a gap (strict >, not >=)", () => {
  const rows = FVG_ROWS.map((r, i) => (i === 21 ? [102.5, 103.0, 100.5, 102.8] : r));
  assert.strictEqual(findZones(mk(rows)).zones.length, 0);
});

test("F2 — a wick into the zone taps it; the id never changes", () => {
  const base = mk(FVG_ROWS);
  const zFresh = findZones(base).zones[0];
  eng._fvg.updateZoneState(zFresh, base, [], eng.CFG);
  assert.strictEqual(zFresh.state, "fresh");

  const tapped = mk([...FVG_ROWS, [102.8, 103.0, 101.6, 102.6]]);
  const zt = findZones(tapped).zones[0];
  eng._fvg.updateZoneState(zt, tapped, [], eng.CFG);
  assert.strictEqual(zt.id, zFresh.id);
  assert.strictEqual(zt.state, "tapped", "101.6 is inside the zone but above CE (101.25)");
  assert.ok(zt.maxPenetration > 0 && zt.maxPenetration < 0.5);
});

test("F2b — a wick through the whole gap fills it; a body close beyond kills it", () => {
  const filled = mk([...FVG_ROWS, [102.8, 103.0, 100.4, 102.6]]);
  const zf = findZones(filled).zones[0];
  eng._fvg.updateZoneState(zf, filled, [], eng.CFG);
  assert.strictEqual(zf.state, "filled");
  assert.strictEqual(zf.maxPenetration, 1);

  const dead = mk([...FVG_ROWS, [102.8, 103.0, 100.0, 100.2]]);
  const zd = findZones(dead).zones[0];
  eng._fvg.updateZoneState(zd, dead, [], eng.CFG);
  assert.strictEqual(zd.state, "invalidated");
  assert.strictEqual(zd.invalidReason, "close-through");
});

test("F3 — bearish FVG mirrors correctly", () => {
  const rows = [
    ...flat(20),
    [100.6, 100.7, 98.4, 98.5, 400],
    [98.5, 99.0, 98.0, 98.2],
    ...Array.from({ length: 6 }, () => [98.2, 98.6, 97.8, 98.1]),
  ];
  const { zones } = findZones(mk(rows));
  assert.strictEqual(zones.length, 1);
  assert.strictEqual(zones[0].dir, "bear");
  assert.strictEqual(zones[0].top, 99.5, "top = the pre-gap candle's low");
  assert.strictEqual(zones[0].bottom, 99.0, "bottom = the post-gap candle's high");
});

test("a missing bar cannot manufacture an FVG", () => {
  const c = mk(FVG_ROWS);
  c.splice(20, 0); // no-op guard; now punch a real hole in the open-times
  const holed = c.map((x, i) => (i >= 21 ? { ...x, t: x.t + TF, closeT: x.closeT + TF } : x));
  assert.strictEqual(findZones(holed).zones.length, 0);
});

/* ----------------------------------------------------------- structure */

const CFG_T = { ...eng.CFG, warmupBars: 4 };

// swing HIGH 103.0 @i4, swing LOW 98.0 @i8, then i13 CLOSES above 103.0.
const BOS_ROWS = [
  [100.0, 100.5, 99.5, 100.0], [100.0, 100.5, 99.5, 100.0],
  [100.0, 100.5, 99.5, 100.0], [100.0, 100.5, 99.5, 100.0],
  [100.2, 103.0, 100.0, 102.5],
  [102.0, 102.2, 101.0, 101.2], [101.0, 101.3, 100.0, 100.3],
  [100.0, 100.4, 99.0, 99.2], [99.0, 99.3, 98.0, 98.2],
  [98.2, 99.5, 98.5, 99.3], [99.3, 100.5, 99.2, 100.4],
  [100.4, 101.5, 100.2, 101.3], [101.3, 102.5, 101.0, 102.3],
  [102.3, 103.5, 102.0, 103.4],
  [103.4, 104.0, 103.0, 103.8],
];

function breaksOf(rows, cfg = CFG_T) {
  const c = mk(rows);
  const sw = eng._struct.swings(c, cfg.wing);
  const zones = eng._fvg.findFvgs(c, atrSafeOf(c, cfg), TF, cfg).zones;
  return { c, sw, ...eng._struct.scanBreaks(c, sw, atrSafeOf(c, cfg), zones, cfg) };
}

test("swings: a plateau yields exactly one pivot (the first bar of the tie)", () => {
  // The desk's fractals() uses strict inequality on BOTH sides, so a double top
  // yields nothing. Equal highs are what a liquidity pool is made of, so
  // smc-radar deliberately uses the max-window + strictly-greater-left rule.
  const rows = [...flat(3), [100, 103, 99.8, 102], [102, 103, 101, 102.5], ...flat(3, 101)];
  const c = mk(rows);
  const highs = eng._struct.swings(c, 2).filter((s) => s.kind === "HIGH");
  assert.strictEqual(highs.length, 1);
  assert.strictEqual(highs[0].i, 3, "the FIRST bar of the tie");
  const strict = eng._struct.fractalsStrict(c, 2).highs;
  assert.strictEqual(strict.length, 0, "the desk's strict rule finds nothing here — that is the divergence");
});

test("swings never report the last `wing` bars (no-lookahead at the tail)", () => {
  const c = mk(BOS_ROWS);
  assert.ok(eng._struct.swings(c, 2).every((s) => s.i <= c.length - 1 - 2));
});

test("F4 — a CLOSE through the opposing swing high is a BOS", () => {
  const { breaks } = breaksOf(BOS_ROWS);
  assert.strictEqual(breaks.length, 1);
  assert.strictEqual(breaks[0].kind, "BOS_UP");
  assert.strictEqual(breaks[0].j, 13);
  assert.strictEqual(breaks[0].level, 103.0);
});

test("F4b — a wick through the swing high is NOT a BOS", () => {
  // Identical bars except the breaking candle closes back below 103.0.
  const rows = BOS_ROWS.map((r, i) =>
    i === 13 ? [102.3, 103.5, 102.0, 102.9] : i === 14 ? [102.9, 103.4, 102.5, 102.8] : r,
  );
  assert.deepStrictEqual(breaksOf(rows).breaks, []);
});

const MSS_ROWS = [
  ...BOS_ROWS,
  [103.8, 104.5, 103.5, 104.2], [104.2, 104.6, 103.8, 104.0],
  [104.0, 104.2, 102.5, 102.8], [102.8, 103.2, 102.0, 102.4],
  [102.4, 103.5, 102.2, 103.3], [103.3, 104.2, 103.0, 104.0],
  [104.0, 104.5, 103.5, 104.2], [104.2, 104.4, 101.0, 101.2],
];

test("F5 — the first break AGAINST the prevailing bias is an MSS, and history is untouched", () => {
  const { breaks } = breaksOf(MSS_ROWS);
  const mss = breaks.filter((b) => b.kind === "MSS_DOWN");
  assert.strictEqual(mss.length, 1);
  assert.strictEqual(mss[0].j, 22);
  assert.strictEqual(mss[0].biasBefore, "up");
  assert.strictEqual(mss[0].weak, false, "a 3-point drop is displacement");

  // Every label BEFORE the flip must be identical to the shorter fixture's.
  const earlier = breaksOf(BOS_ROWS).breaks;
  assert.deepStrictEqual(breaks.filter((b) => b.j < 15), earlier.filter((b) => b.j < 15));
});

test("a swing level can only be broken once (no double-counting a grind)", () => {
  const rows = [...BOS_ROWS, [103.8, 104.2, 103.4, 104.0], [104.0, 104.3, 103.6, 104.1]];
  const ups = breaksOf(rows).breaks.filter((b) => b.dir === "up");
  assert.strictEqual(ups.length, 1, "three closes above 103.0 is still one BOS");
});

/* ----------------------------------------------------------- liquidity */

// Two near-equal highs (103.00 @i4, 103.02 @i10) then a raid at i14.
const SWEEP_ROWS = [
  ...flat(4),
  [100.2, 103.0, 100.0, 102.5],
  [102.0, 102.2, 101.0, 101.2], [101.0, 101.3, 100.0, 100.3],
  [100.0, 100.4, 99.6, 100.0], [100.0, 100.6, 99.8, 100.4],
  [100.4, 101.6, 100.2, 101.4],
  [101.4, 103.02, 101.2, 102.6],
  [102.6, 102.8, 101.8, 102.0], [102.0, 102.3, 101.4, 101.8],
  [101.8, 102.4, 101.5, 102.2],
  [102.5, 103.6, 102.0, 102.2],
  [102.2, 102.6, 101.6, 101.8], [101.8, 102.0, 101.0, 101.2],
  [101.2, 101.5, 100.6, 100.8],
];

function sweepsOf(rows, cfg = CFG_T) {
  const c = mk(rows);
  const a = atrSafeOf(c, cfg);
  const sw = eng._struct.swings(c, cfg.wing);
  const pools = eng._liq.buildPools(c, sw, a, cfg);
  const zones = eng._fvg.findFvgs(c, a, TF, cfg).zones;
  return { pools, sweeps: eng._liq.detectSweeps(c, pools, a, zones, cfg) };
}

test("equal highs cluster into one pool", () => {
  const { pools } = sweepsOf(SWEEP_ROWS);
  const eq = pools.filter((p) => p.side === "BSL" && p.count >= 2);
  assert.strictEqual(eq.length, 1);
  assert.strictEqual(eq[0].count, 2);
  assert.strictEqual(eq[0].level, 103.02, "the pool level is the highest member — the actual trigger");
});

test("F6 — a wick above the pool that CLOSES back inside is a sweep", () => {
  const { sweeps } = sweepsOf(SWEEP_ROWS);
  const buyside = sweeps.filter((s) => s.type === "buyside");
  assert.strictEqual(buyside.length, 1);
  assert.strictEqual(buyside[0].j, 14);
  assert.ok(buyside[0].wickFrac >= 0.4);
});

test("F6b — the same wick that CLOSES above is a breakout, not a sweep", () => {
  const rows = SWEEP_ROWS.map((r, i) => (i === 14 ? [102.5, 103.6, 102.0, 103.5] : r));
  assert.strictEqual(sweepsOf(rows).sweeps.filter((s) => s.type === "buyside").length, 0);
});

test("a sweep near the tail is pending, not confirmed — unknown is never false", () => {
  const rows = SWEEP_ROWS.slice(0, 16); // only 1 bar after the raid
  const s = sweepsOf(rows).sweeps.find((x) => x.j === 14);
  assert.ok(s, "the core predicate still fires with zero future bars");
  assert.strictEqual(s.pending, true);
  assert.strictEqual(s.noReclaim, null);
  assert.strictEqual(s.displacement, null);
  assert.strictEqual(s.confirmed, false);
});

/* -------------------------------------------------------------- range */

test("F7 — an oscillating tape reads as range with a usable premium/discount split", () => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const up = i % 8 < 4;
    const base = up ? 100 + (i % 4) : 104 - (i % 4);
    rows.push([base, base + 0.6, base - 0.6, base + (up ? 0.3 : -0.3)]);
  }
  const c = mk(rows);
  const core = eng._util.coreAnalyze(c, CFG_T, TF);
  assert.strictEqual(core.struct.trend, "range");
  assert.ok(core.dr.rangeHigh > core.dr.rangeLow);
  const lo = eng._struct.pdZone(core.dr.rangeLow + core.dr.width * 0.1, core.dr, CFG_T);
  const hi = eng._struct.pdZone(core.dr.rangeLow + core.dr.width * 0.9, core.dr, CFG_T);
  assert.strictEqual(lo, "discount");
  assert.strictEqual(hi, "premium");
});

/* --------------------------------------------------------- degenerate */

test("F8 — degenerate inputs never throw, never NaN, never invent a zone", () => {
  for (const rows of [[], flat(1), flat(2), flat(3), [[5, 5, 5, 5], [5, 5, 5, 5], [5, 5, 5, 5]]]) {
    const c = mk(rows);
    assert.doesNotThrow(() => eng._struct.swings(c, 2));
    if (c.length) {
      const z = eng._fvg.findFvgs(c, atrSafeOf(c), TF, eng.CFG).zones;
      assert.strictEqual(z.length, 0);
    }
    const out = eng.analyze(c, [], OPTS);
    assert.strictEqual(out.ok, false);
    assert.ok(typeof out.msg === "string" && out.msg.length);
  }
});

test("malformed candles are dropped, and too many of them is an error not a guess", () => {
  const good = mk(flat(100));
  const bad = good.map((c, i) => (i % 2 ? { ...c, high: c.low - 1 } : c));
  const out = eng.analyze(bad, [], OPTS);
  assert.strictEqual(out.ok, false);
  assert.match(out.msg, /ผิดรูป/);
});

/* --------------------------------- determinism / no-lookahead (Phase 2) */

/** Deterministic pseudo-random walk — no Math.random, so the fixture is stable. */
function walk(n, seed = 12345) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rows = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 23) * 0.35;
    // Every so often the tape displaces: a big body with almost no wick. That
    // is what actually leaves an imbalance behind, so the fixture has to
    // contain them or the no-lookahead test would pass on an empty zone list.
    const impulse = i % 17 === 0 && i > 20;
    const shock = impulse
      ? (rnd() > 0.5 ? 1 : -1) * (2.6 + rnd() * 1.6) + drift
      : (rnd() - 0.5) * 1.6 + drift;
    const open = px;
    const close = Math.max(1, px + shock);
    const wick = impulse ? 0.02 + rnd() * 0.06 : 0.2 + rnd() * 0.9;
    rows.push([
      open, Math.max(open, close) + wick, Math.min(open, close) - wick, close,
      impulse ? 300 + Math.round(rnd() * 400) : 50 + Math.round(rnd() * 200),
    ]);
    px = close;
  }
  return mk(rows);
}

const KEY = (z) => JSON.stringify([z.id, z.dir, z.top, z.bottom, z.i, z.confirmIdx, z.ts, z.formGrade]);
const LIFE = { fresh: 0, tapped: 1, ce: 2, filled: 3, invalidated: 4 };

test("no lookahead: a zone's FORMATION facts never change when future bars arrive", () => {
  const full = walk(300);
  const ref = eng.analyze(full, [], { ...OPTS, nowMs: full[full.length - 1].closeT });
  assert.strictEqual(ref.ok, true);
  assert.ok(ref.zones.length >= 5, `fixture should produce zones, got ${ref.zones.length}`);

  const refById = new Map(ref.zones.map((z) => [z.id, z]));
  for (let k = 1; k <= 60; k++) {
    const cut = full.length - k;
    const out = eng.analyze(full.slice(0, cut), [], { ...OPTS, nowMs: full[cut - 1].closeT });
    assert.strictEqual(out.ok, true, `prefix run failed at k=${k}`);
    for (const z of out.zones) {
      const r = refById.get(z.id);
      assert.ok(r, `zone ${z.id} present at k=${k} but absent in the full run`);
      assert.strictEqual(KEY(z), KEY(r), `formation mutated by future bars (k=${k}, ${z.id})`);
      assert.ok(LIFE[r.state] >= LIFE[z.state], `lifecycle moved backwards (k=${k}, ${z.id})`);
      assert.ok(r.maxPenetration >= z.maxPenetration, `fill regressed (k=${k}, ${z.id})`);
    }
  }
});

test("no lookahead: structure breaks for a prefix are byte-identical to the full run's", () => {
  const full = walk(300);
  const ref = eng.analyze(full, [], { ...OPTS, nowMs: full[full.length - 1].closeT });
  for (const k of [1, 7, 23, 60]) {
    const cut = full.length - k;
    const out = eng.analyze(full.slice(0, cut), [], { ...OPTS, nowMs: full[cut - 1].closeT });
    assert.deepStrictEqual(out.breaks, ref.breaks.filter((b) => b.j < cut));
  }
});

test("analyzeAsOf(k) equals analyze(candles[0..k])", () => {
  const full = walk(300);
  for (const k of [120, 199, 299]) {
    const a = eng.analyze(full.slice(0, k + 1), [], { ...OPTS, nowMs: full[k].closeT });
    const b = eng.analyzeAsOf(full, [], k, OPTS);
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b), `mismatch at k=${k}`);
  }
});

test("the forming candle is dropped, so a mid-bar rerun is byte-identical", () => {
  const full = walk(300);
  const lastOpen = full[full.length - 1].t;
  const a = eng.analyze(full, [], { ...OPTS, nowMs: lastOpen + 1000 });
  const b = eng.analyze(full, [], { ...OPTS, nowMs: lastOpen + 600000 });
  assert.strictEqual(a.asOf.droppedUnclosed, 1);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

/* ------------------------------------------------- advisory-only contract */

test("the analysis carries no order payload and says so", () => {
  const full = walk(300);
  const out = eng.analyze(full, [], { ...OPTS, nowMs: full[full.length - 1].closeT });
  assert.strictEqual(out.advisoryOnly, true);
  const blob = JSON.stringify(out);
  for (const banned of ["qty", "leverage", "reduceOnly", "orderId", "apiKey"]) {
    assert.ok(!blob.includes(banned), `analysis must never carry \`${banned}\``);
  }
  for (const s of out.setups) {
    assert.ok(["waiting", "armed", "triggered"].includes(s.readiness));
    assert.ok(s.rr >= eng.CFG.minRr, "a setup below minRr must be on the watchlist, not here");
    assert.ok(s.sl != null && s.tp1 != null, "every setup states its invalidation and its target");
  }
});

test("a bare FVG with no structural story is never a setup", () => {
  const full = walk(300);
  const out = eng.analyze(full, [], { ...OPTS, nowMs: full[full.length - 1].closeT });
  const ids = new Set(out.setups.map((s) => s.id));
  for (const z of out.zones) {
    if (ids.has(z.id)) assert.ok(z.postBos || z.postMss || z.sourceSweep || out.regime.isRange === true);
  }
  assert.ok(out.watchlist.some((w) => w.reject === "no-structural-story") || out.zones.length < 3);
});

/* ---------------------------------------------------------- SL hazard ----
 * slHazardDecide (mandate: liquidity_hazard_2026_07_28) — pure geometry over
 * REPORTED pool objects. The one rule that must never regress: unknown ≠
 * clear. Bad inputs read as "cannot assess", never as safety.
 */
const pool = (side, level, tol, extra = {}) => ({
  side, level, bandLo: level - tol, bandHi: level + tol, count: 3, strength: "strong", swept: false, ...extra,
});

test("slHazard: stop inside an SSL band is HIGH for a long", () => {
  const h = eng.slHazardDecide({ side: "BUY", entry: 100, stop: 94.9,
    pools: [pool("SSL", 95, 0.2)], atr: 1 });
  assert.equal(h.hazard, "high");
  assert.equal(h.mode, "in-band");
  assert.equal(h.pool.level, 95);
});

test("slHazard: stop below the band but inside sweep-pierce reach is MID", () => {
  // bandLo = 94.8, stop 94.2 → 0.6 ATR beyond: a 1.5-ATR raid still takes it out.
  const h = eng.slHazardDecide({ side: "BUY", entry: 100, stop: 94.2,
    pools: [pool("SSL", 95, 0.2)], atr: 1 });
  assert.equal(h.hazard, "mid");
  assert.equal(h.mode, "pierce-reach");
});

test("slHazard: stop beyond max pierce is CLEAR", () => {
  const h = eng.slHazardDecide({ side: "BUY", entry: 100, stop: 93.0,
    pools: [pool("SSL", 95, 0.2)], atr: 1 });
  assert.equal(h.hazard, "clear");
  assert.equal(h.mode, "beyond-pierce");
});

test("slHazard: stop shallower than a nearby pool sits on the raid path (MID)", () => {
  // Pool at 94 (bandHi 94.2), stop 94.9 → price must chew through our stop to raid the pool.
  const h = eng.slHazardDecide({ side: "BUY", entry: 100, stop: 94.9,
    pools: [pool("SSL", 94, 0.2)], atr: 1 });
  assert.equal(h.hazard, "mid");
  assert.equal(h.mode, "on-approach");
});

test("slHazard: a pool far beyond the stop is irrelevant (NONE)", () => {
  const h = eng.slHazardDecide({ side: "BUY", entry: 100, stop: 97,
    pools: [pool("SSL", 90, 0.2)], atr: 1 });
  assert.equal(h.hazard, "none");
});

test("slHazard: swept pools are spent liquidity and ignored", () => {
  const h = eng.slHazardDecide({ side: "BUY", entry: 100, stop: 94.9,
    pools: [pool("SSL", 95, 0.2, { swept: true })], atr: 1 });
  assert.equal(h.hazard, "none");
});

test("slHazard: SELL mirrors against BSL pools above", () => {
  const h = eng.slHazardDecide({ side: "SELL", entry: 100, stop: 105.1,
    pools: [pool("BSL", 105, 0.2)], atr: 1 });
  assert.equal(h.hazard, "high");
  assert.equal(h.mode, "in-band");
});

test("slHazard: worst pool wins when several are visible", () => {
  const h = eng.slHazardDecide({ side: "BUY", entry: 100, stop: 94.9,
    pools: [pool("SSL", 92, 0.2), pool("SSL", 95, 0.2)], atr: 1 });
  assert.equal(h.hazard, "high");
  assert.equal(h.pool.level, 95);
});

test("slHazard: bad inputs are UNKNOWN, never clear", () => {
  assert.equal(eng.slHazardDecide({ side: "BUY", entry: 100, stop: 95, pools: [], atr: 0 }).hazard, "unknown");
  assert.equal(eng.slHazardDecide({ side: "HOLD", entry: 100, stop: 95, pools: [], atr: 1 }).hazard, "unknown");
  assert.equal(eng.slHazardDecide({ side: "BUY", entry: 100, stop: 101, pools: [], atr: 1 }).hazard, "unknown",
    "a long stop above entry is nonsense and must not read as safe");
  assert.equal(eng.slHazardDecide({ side: "BUY", entry: 100, stop: 95, pools: [], atr: 1 }).hazard, "none");
});

test("slHazard: a lone weak pivot is not a pile and creates no hazard", () => {
  const h = eng.slHazardDecide({ side: "BUY", entry: 100, stop: 94.9,
    pools: [pool("SSL", 95, 0.2, { count: 1, strength: "weak" })], atr: 1 });
  assert.equal(h.hazard, "none");
  const maj = eng.slHazardDecide({ side: "BUY", entry: 100, stop: 94.9,
    pools: [pool("SSL", 95, 0.2, { count: 1, strength: "major" })], atr: 1 });
  assert.equal(maj.hazard, "high", "a range extreme is a pile even with one touch");
});
