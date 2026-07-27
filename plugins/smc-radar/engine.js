"use strict";
/**
 * smc-radar engine — deterministic Smart-Money-Concepts reader.
 *
 * PURE. No I/O, no require("http"), no Date.now(), no Math.random(). `nowMs`
 * and the timeframe arrive as arguments so the same candles always produce the
 * same answer — that is what makes the no-lookahead proof in
 * daemon/tests/smc-radar.test.js possible at all.
 *
 * House style follows plugins/regime-radar/index.js: TA helpers are
 * re-implemented locally rather than imported across plugins, so a plugin is a
 * single self-contained unit that can be copied, reloaded and tested alone.
 * Where a helper mirrors one in plugins/binance/index.js the semantics are
 * matched exactly (see `atrSeries` and `avgVolAt`) — a test pins that.
 *
 * ADVISORY ONLY. Nothing here places, sizes or modifies an order. An FVG is a
 * WAITING ZONE, and that is enforced structurally (see `readiness`), not with a
 * disclaimer string.
 */

const CFG = {
  // ---- data ----
  entryTf: "15m", entryLimit: 300, htfTf: "1h", htfLimit: 200,
  minBars: 120, minBarsPartial: 60, htfMinBars: 40, warmupBars: 40,

  // ---- TA ----
  atrPeriod: 14, adxPeriod: 14, emaFast: 20, emaSlow: 50,
  emaSlopeLookback: 10, volLookback: 20,

  // ---- FVG ----
  wing: 2, minGapAtr: 0.25, minGapPct: 0.05,
  minBodyAtr: 0.70, minBodyRatio: 0.50, nestOverlap: 0.50,

  // ---- lifecycle ----
  maxAgeBars: 60, maxDriftAtr: 12, invalidateOnOpposingMss: true,

  // ---- structure ----
  postBreakWindow: 10, mssRequireDisplacement: true, mssDispAtr: 0.80,

  // ---- liquidity ----
  eqTolAtr: 0.10, eqMaxSpanBars: 60, eqMinGapBars: 2, poolReportAtr: 15,
  minPierceAtr: 0.05, maxPierceAtr: 1.50, sweepWickFrac: 0.40,
  sweepConfirmBars: 3, sweepDispWindow: 3, sweepRecency: 20,
  sweepToFvgWindow: 5, nearLiqAtr: 3.0,

  // ---- premium / discount ----
  eqBand: 0.05, drFallbackBars: 60, drMaxAgeBars: 150, minRangeAtr: 1.50,

  // ---- range (adxTrendMin + slopeEps are deliberately SHARED with
  // regime-radar so the two plugins cannot contradict each other on
  // "is this symbol trending?") ----
  adxTrendMin: 22, slopeEps: 0.05, rangeLookback: 60,
  edgeBandAtr: 0.50, minEdgeTouches: 2,

  // ---- trade plan ----
  entryAnchor: "ce", slBufferAtr: 0.25, slBufferPct: 0.03,
  minStopAtr: 0.40, maxStopAtr: 4.00, tpShaveAtr: 0.10,
  minTargetAtr: 1.00, maxTargetAtr: 8.00,
  minRr: 1.80, minRrGradeA: 2.00,

  // ---- scoring (INDEPENDENT of analyzeSymbol's flat signals.length scheme) ----
  // MEASURED, not asserted. Swept over 12 symbols × 1020 snapshots of real 15m
  // klines (see README §Calibration): at these thresholds grade A lands on 4.8%
  // of scored zones, B on 42%, C on 46%. A first cut at 78/58 put A at 21% —
  // a grade that common says nothing. Re-measure if the weights ever change.
  gradeAMin: 90, gradeBMin: 70, gradeCMin: 40, maxSetups: 5,

  // ---- safety ----
  atrFloorPct: 0.02, malformedMaxFrac: 0.02, staleDataTfMult: 3,
};

/* ------------------------------------------------------------------ utils */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
const num = (v) => (typeof v === "number" ? v : Number(v));

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const TF_MS = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
function tfMs(tf) {
  const m = String(tf || "").trim().toLowerCase().match(/^(\d+)([mhdw])$/);
  if (!m) return null;
  return Number(m[1]) * TF_MS[m[2]];
}

/**
 * Coerce, drop malformed, sort, dedupe. A retried kline request can splice a
 * duplicate open-time in; keeping the LAST occurrence keeps the fresher copy.
 */
function normalizeCandles(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const seen = new Map();
  let malformed = 0;
  for (const k of src) {
    if (!k || typeof k !== "object") { malformed++; continue; }
    const c = {
      t: num(k.t), open: num(k.open), high: num(k.high), low: num(k.low),
      close: num(k.close), volume: num(k.volume), closeT: num(k.closeT),
    };
    const finite = [c.t, c.open, c.high, c.low, c.close, c.closeT].every(Number.isFinite);
    if (!finite || c.high < c.low ||
        c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) {
      malformed++; continue;
    }
    if (!Number.isFinite(c.volume)) c.volume = 0;
    seen.set(c.t, c);
  }
  const out = [...seen.values()].sort((a, b) => a.t - b.t);
  return { candles: out, malformedDropped: malformed, rawLen: src.length };
}

/** Drop every candle that has not closed yet. Binance returns the forming bar. */
function sealCandles(candles, nowMs) {
  if (!Number.isFinite(nowMs)) return { closed: candles.slice(), droppedUnclosed: 0 };
  let end = candles.length;
  while (end > 0 && candles[end - 1].closeT > nowMs) end--;
  return { closed: candles.slice(0, end), droppedUnclosed: candles.length - end };
}

/* --------------------------------------------------------------------- TA */

function emaSeries(values, period) {
  const out = [];
  if (!values.length) return out;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 0; i < values.length; i++) {
    e = i === 0 ? values[0] : values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}
const ema = (values, period) => {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
};

function trueRanges(candles) {
  const tr = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return tr;
}

/**
 * Trailing SIMPLE mean of the last `period` true ranges — matches
 * plugins/binance/index.js:224 exactly (which is NOT Wilder). Pinned by a test:
 * atrSeries(c,14).at(-1) must equal that function's atr(c,14).
 */
function atrSeries(candles, period = 14) {
  const tr = trueRanges(candles);
  const out = new Array(candles.length).fill(0);
  for (let i = 0; i < candles.length; i++) {
    const from = Math.max(1, i - period + 1);
    let sum = 0, n = 0;
    for (let j = from; j <= i; j++) { sum += tr[j]; n++; }
    out[i] = n ? sum / n : 0;
  }
  return out;
}
const atr = (candles, period = 14) => {
  const s = atrSeries(candles, period);
  return s.length ? s[s.length - 1] : 0;
};

/** Mean volume over the `lookback` bars BEFORE k — excludes bar k, like the desk's avgVol. */
function avgVolAt(candles, k, lookback = 20) {
  const from = Math.max(0, k - lookback);
  let sum = 0, n = 0;
  for (let j = from; j < k; j++) { sum += candles[j].volume; n++; }
  if (!n || sum <= 0) return null;
  return sum / n;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function adx(candles, period = 14) {
  const n = candles.length;
  if (n < period * 2 + 1) return null;
  let tr = 0, pdm = 0, mdm = 0;
  for (let i = 1; i <= period; i++) {
    const c = candles[i], p = candles[i - 1];
    tr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high, dn = p.low - c.low;
    pdm += up > dn && up > 0 ? up : 0;
    mdm += dn > up && dn > 0 ? dn : 0;
  }
  const dxs = [];
  let plusDI = 0, minusDI = 0;
  for (let i = period + 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const t = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high, dn = p.low - c.low;
    tr = tr - tr / period + t;
    pdm = pdm - pdm / period + (up > dn && up > 0 ? up : 0);
    mdm = mdm - mdm / period + (dn > up && dn > 0 ? dn : 0);
    plusDI = tr > 0 ? (100 * pdm) / tr : 0;
    minusDI = tr > 0 ? (100 * mdm) / tr : 0;
    const sum = plusDI + minusDI;
    dxs.push(sum > 0 ? (100 * Math.abs(plusDI - minusDI)) / sum : 0);
  }
  if (dxs.length < period) return null;
  let a = dxs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < dxs.length; i++) a = (a * (period - 1) + dxs[i]) / period;
  return { adx: a, plusDI, minusDI };
}

/* -------------------------------------------------------------- structure */

/**
 * Swing pivots, mirroring trading_partner/market_structure/detector.py:50 —
 * `high[i] === max(window) && high[i] > max(left)`. A plateau therefore yields
 * exactly ONE pivot (the first bar of the tie).
 *
 * This DIVERGES from plugins/binance/index.js:257 on purpose: that one uses
 * strict inequality on both sides, so a double top produces no pivot at all.
 * Equal highs are precisely what a liquidity pool is made of, so the strict
 * rule is the wrong tool here. `fractalsStrict` below is a faithful copy of the
 * desk's rule, kept for cross-checking.
 *
 * The last `wing` bars can never be pivots. That is not a limitation to work
 * around — relaxing it at the tail IS lookahead.
 */
function swings(candles, wing = 2) {
  const n = candles.length, out = [];
  for (let i = wing; i < n - wing; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (candles[j].high > candles[i].high) isHigh = false;
      if (candles[j].low < candles[i].low) isLow = false;
    }
    for (let j = i - wing; j < i && (isHigh || isLow); j++) {
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) out.push({ i, price: candles[i].high, kind: "HIGH", confirmedAt: i + wing });
    if (isLow) out.push({ i, price: candles[i].low, kind: "LOW", confirmedAt: i + wing });
  }
  return out.sort((a, b) => a.i - b.i || (a.kind < b.kind ? -1 : 1));
}

/** Byte-for-byte the desk's rule (plugins/binance/index.js:257) — cross-check only. */
function fractalsStrict(c, n = 2) {
  const highs = [], lows = [];
  for (let i = n; i < c.length - n; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= n; j++) {
      if (c[i].high <= c[i - j].high || c[i].high <= c[i + j].high) isHigh = false;
      if (c[i].low >= c[i - j].low || c[i].low >= c[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ i, price: c[i].high });
    if (isLow) lows.push({ i, price: c[i].low });
  }
  return { highs, lows };
}

/** Stateless last-two-pivot snapshot (the desk's classifyStructure semantics). */
function classifyStructure(sw) {
  const highs = sw.filter((s) => s.kind === "HIGH");
  const lows = sw.filter((s) => s.kind === "LOW");
  const h2 = highs.slice(-2), l2 = lows.slice(-2);
  const res = {
    trend: "range",
    lastHigh: highs.length ? highs[highs.length - 1] : null,
    prevHigh: h2.length === 2 ? h2[0] : null,
    lastLow: lows.length ? lows[lows.length - 1] : null,
    prevLow: l2.length === 2 ? l2[0] : null,
  };
  if (h2.length < 2 || l2.length < 2) return res;
  const hh = h2[1].price > h2[0].price, hl = l2[1].price > l2[0].price;
  const lh = h2[1].price < h2[0].price, ll = l2[1].price < l2[0].price;
  if (hh && hl) res.trend = "up";
  else if (lh && ll) res.trend = "down";
  return res;
}

/**
 * BOS vs MSS, as a single left-to-right fold. Everything it reads at bar j is
 * derived from candles[0..j] only:
 *   - swings enter the pointers when confirmedAt <= j (wing bars after they printed)
 *   - breaks are close-based, never wick-based (the desk's own rule)
 *   - a swing level can be broken exactly ONCE, so grinding above the same high
 *     for 10 bars is one BOS, not ten
 *   - MSS fires only on a bias flip and the flip applies immediately, so two
 *     consecutive MSS in the same direction are impossible by construction
 *
 * The MSS displacement gate accepts an FVG as evidence only if that zone was
 * already CONFIRMED at bar j (confirmIdx <= j). The design note allowed
 * i ∈ [j-1, j+1]; a zone at i = j is confirmed at j+1 and one at i = j+1 at
 * j+2, so honouring that literally would let a future bar relabel a past break.
 * The close-delta test already covers "the break bar itself displaced".
 */
function scanBreaks(candles, sw, atrSafeArr, zones, cfg) {
  const n = candles.length;
  // Constant, never derived from n — a warmup that scaled with the array length
  // would give a prefix run a different seed bias and silently break H3.
  const warm = cfg.warmupBars;
  const seeded = sw.filter((s) => s.confirmedAt < warm);
  let bias = classifyStructure(seeded).trend;
  if (bias === "range") bias = "none";

  const brokenH = new Set(), brokenL = new Set();
  const sorted = sw.slice().sort((a, b) => a.confirmedAt - b.confirmedAt || a.i - b.i);
  const breaks = [];
  const ambiguous = [];
  let hi = null, lo = null, p = 0;

  for (let j = 0; j < n; j++) {
    while (p < sorted.length && sorted[p].confirmedAt <= j) {
      const s = sorted[p++];
      if (s.kind === "HIGH") hi = s; else lo = s;
    }
    if (j < warm) continue;

    const c = candles[j];
    const a = atrSafeArr[j];
    const upOk = hi && hi.i < j && !brokenH.has(hi.i) && c.close > hi.price;
    const dnOk = lo && lo.i < j && !brokenL.has(lo.i) && c.close < lo.price;
    let dir = null;
    if (upOk && dnOk) {
      // Degenerate (last confirmed low sits above the last confirmed high).
      dir = (c.close - hi.price) / a >= (lo.price - c.close) / a ? "up" : "down";
      ambiguous.push(j);
    } else if (upOk) dir = "up";
    else if (dnOk) dir = "down";
    if (!dir) continue;

    const level = dir === "up" ? hi.price : lo.price;
    const brokenSwing = dir === "up" ? hi : lo;
    const seed = bias === "none";
    const isMss = !seed && ((dir === "up" && bias === "down") || (dir === "down" && bias === "up"));
    const kind = (isMss ? "MSS_" : "BOS_") + (dir === "up" ? "UP" : "DOWN");

    const dispAtr = j > 0 ? Math.abs(c.close - candles[j - 1].close) / a : 0;
    let weak = false;
    if (isMss && cfg.mssRequireDisplacement) {
      const fvgEvidence = zones.some(
        (z) => z.quality && z.confirmIdx <= j && j - z.confirmIdx <= 1 &&
               (dir === "up") === (z.dir === "bull"),
      );
      weak = !(dispAtr >= cfg.mssDispAtr || fvgEvidence);
    }

    breaks.push({
      kind, dir, j, ts: c.t, level, brokenSwing: { i: brokenSwing.i, price: brokenSwing.price },
      biasBefore: bias, biasAfter: dir, displacementAtr: r2(dispAtr), weak, seed,
      reliable: j >= warm + 10, isMss,
    });
    if (dir === "up") brokenH.add(hi.i); else brokenL.add(lo.i);
    bias = dir;
  }
  return { breaks, bias, ambiguous, warmupBars: warm };
}

/* --------------------------------------------------------------------- FVG */

/**
 * Three-candle imbalance. The zone at middle index `i` is NOT knowable until
 * candle i+1 closes, so every zone carries confirmIdx = i+1 and its lifecycle
 * is only ever evaluated against bars strictly after that.
 */
function findFvgs(candles, atrSafeArr, tfMsVal, cfg) {
  const zones = [];
  let gapSkipped = 0;
  for (let i = 1; i < candles.length - 1; i++) {
    const a = candles[i - 1], m = candles[i], b = candles[i + 1];
    let dir = null, top = 0, bottom = 0;
    if (a.high < b.low) { dir = "bull"; bottom = a.high; top = b.low; }
    else if (a.low > b.high) { dir = "bear"; top = a.low; bottom = b.high; }
    else continue;

    const size = top - bottom;
    const ce = (top + bottom) / 2;
    if (!(size > 1e-12 * Math.max(Math.abs(ce), 1e-12))) continue;

    // A missing bar manufactures a fake imbalance. Crypto perps are 24/7, so any
    // gap in open-times is an outage, never a session boundary.
    if (tfMsVal && b.t - a.t !== 2 * tfMsVal) { gapSkipped++; continue; }

    const confirmIdx = i + 1;
    const atrC = atrSafeArr[confirmIdx];
    const sizeAtr = size / atrC;
    const sizePct = (size / ce) * 100;
    if (sizeAtr < cfg.minGapAtr || sizePct < cfg.minGapPct) continue;

    const body = Math.abs(m.close - m.open);
    const rng = m.high - m.low;
    const bodyAtr = body / atrSafeArr[i];
    const bodyRatio = rng > 0 ? body / rng : 0;
    const av = avgVolAt(candles, i, cfg.volLookback);
    // volume is a SCORER input, never a gate: testnet reports 0 for whole
    // stretches and a hard gate would silently blank the plugin there.
    const volMult = av ? m.volume / av : null;
    const dirAgrees = dir === "bull" ? m.close > m.open : m.close < m.open;
    const quality = dirAgrees && bodyAtr >= cfg.minBodyAtr && bodyRatio >= cfg.minBodyRatio;
    const dispScore =
      clamp(bodyAtr / 1.5, 0, 1) * 0.5 +
      clamp(bodyRatio, 0, 1) * 0.25 +
      clamp((volMult === null ? 1 : volMult) / 2, 0, 1) * 0.25;

    zones.push({
      id: (dir === "bull" ? "BULL@" : "BEAR@") + m.t,
      dir, top, bottom, ce, size,
      sizePct: r4(sizePct), sizeAtr: r2(sizeAtr),
      i, confirmIdx, ts: m.t, confirmTs: b.closeT, atrAt: atrC,
      displacement: {
        bodyAtr: r2(bodyAtr), bodyRatio: r2(bodyRatio),
        volMult: volMult === null ? null : r2(volMult), score: r2(dispScore),
      },
      quality, nestedWith: [],
    });
  }
  return { zones, gapSkipped };
}

const overlapFrac = (a, b) => {
  const ov = Math.max(0, Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom));
  const denom = Math.min(a.size, b.size);
  return denom > 0 ? ov / denom : 0;
};

/**
 * Lifecycle. Monotone: a zone only ever moves forward.
 *   fresh -> tapped -> ce -> filled, or -> invalidated.
 * Boundary convention, fixed once: ENTERING uses <= / >=, an invalidation CLOSE
 * uses strict < / >. A wick through the gap is mitigation (the zone did its
 * job); a body close beyond the far side is death.
 */
function updateZoneState(z, candles, breaks, cfg) {
  const n = candles.length;
  const bull = z.dir === "bull";
  let ext = bull ? Infinity : -Infinity;
  let firstTouchIdx = null, ceIdx = null, fillIdx = null, closeThroughIdx = null;

  for (let j = z.confirmIdx + 1; j < n; j++) {
    const c = candles[j];
    if (bull) {
      if (c.low < ext) ext = c.low;
      if (firstTouchIdx === null && c.low <= z.top) firstTouchIdx = j;
      if (ceIdx === null && c.low <= z.ce) ceIdx = j;
      if (fillIdx === null && c.low <= z.bottom) fillIdx = j;
      if (closeThroughIdx === null && c.close < z.bottom) closeThroughIdx = j;
    } else {
      if (c.high > ext) ext = c.high;
      if (firstTouchIdx === null && c.high >= z.bottom) firstTouchIdx = j;
      if (ceIdx === null && c.high >= z.ce) ceIdx = j;
      if (fillIdx === null && c.high >= z.top) fillIdx = j;
      if (closeThroughIdx === null && c.close > z.top) closeThroughIdx = j;
    }
  }

  const cands = [];
  if (closeThroughIdx !== null) cands.push({ idx: closeThroughIdx, reason: "close-through" });
  const ageIdx = z.confirmIdx + cfg.maxAgeBars + 1;
  if (ageIdx <= n - 1) cands.push({ idx: ageIdx, reason: "age" });
  if (cfg.invalidateOnOpposingMss) {
    const opp = breaks.find(
      (b) => b.isMss && b.j > z.confirmIdx && (bull ? b.dir === "down" : b.dir === "up"),
    );
    if (opp) cands.push({ idx: opp.j, reason: "opposing-mss" });
  }
  cands.sort((a, b) => a.idx - b.idx);
  const inv = cands[0] || null;

  let state;
  if (inv) state = "invalidated";
  else if (fillIdx !== null) state = "filled";
  else if (ceIdx !== null) state = "ce";
  else if (firstTouchIdx !== null) state = "tapped";
  else state = "fresh";

  const pen = !Number.isFinite(ext)
    ? 0
    : clamp(bull ? (z.top - ext) / z.size : (ext - z.bottom) / z.size, 0, 1);

  let reaction = null;
  if (firstTouchIdx !== null && z.size > 0) {
    let hiMax = -Infinity, loMin = Infinity;
    for (let j = firstTouchIdx; j < n; j++) {
      if (candles[j].high > hiMax) hiMax = candles[j].high;
      if (candles[j].low < loMin) loMin = candles[j].low;
    }
    reaction = bull
      ? r2((hiMax - candles[firstTouchIdx].low) / z.size)
      : r2((candles[firstTouchIdx].high - loMin) / z.size);
  }

  z.state = state;
  z.invalidIdx = inv ? inv.idx : null;
  z.invalidReason = inv ? inv.reason : null;
  z.firstTouchIdx = firstTouchIdx;
  z.ceIdx = ceIdx;
  z.fillIdx = fillIdx;
  z.maxPenetration = r2(pen);
  z.reaction = reaction;
  z.barsSinceForm = n - 1 - z.confirmIdx;
  return z;
}

/* --------------------------------------------------------------- liquidity */

/**
 * Liquidity pools. A swing high is buy-side liquidity (stops of shorts +
 * breakout buys rest above it); a swing low is sell-side. Equal highs/lows
 * within tolerance cluster into a stronger pool — those are the levels the
 * market actually reaches for.
 */
function buildPools(candles, sw, atrSafeArr, cfg) {
  const n = candles.length;
  const mk = (kind, side) => {
    const pts = sw.filter((s) => s.kind === kind).slice().sort((a, b) => a.price - b.price);
    const groups = [];
    for (const s of pts) {
      const g = groups[groups.length - 1];
      const tol = cfg.eqTolAtr * atrSafeArr[s.i];
      const fits =
        g &&
        Math.abs(s.price - g.members[g.members.length - 1].price) <= tol &&
        g.members.every(
          (m) =>
            Math.abs(m.i - s.i) <= cfg.eqMaxSpanBars && Math.abs(m.i - s.i) >= cfg.eqMinGapBars,
        );
      if (fits) g.members.push(s);
      else groups.push({ members: [s] });
    }
    return groups.map((g) => {
      const prices = g.members.map((m) => m.price);
      const level = side === "BSL" ? Math.max(...prices) : Math.min(...prices);
      const tol = cfg.eqTolAtr * atrSafeArr[g.members[g.members.length - 1].i];
      return {
        side, level,
        bandLo: Math.min(...prices) - tol, bandHi: Math.max(...prices) + tol,
        members: g.members.map((m) => ({ i: m.i, price: m.price, confirmedAt: m.confirmedAt })),
        count: g.members.length,
        strength: g.members.length >= 3 ? "strong" : g.members.length >= 2 ? "weak-eq" : "weak",
        firstIdx: Math.min(...g.members.map((m) => m.i)),
        lastIdx: Math.max(...g.members.map((m) => m.i)),
        confirmedAt: Math.max(...g.members.map((m) => m.confirmedAt)),
        swept: false, sweepIdx: null,
      };
    });
  };

  const pools = [...mk("HIGH", "BSL"), ...mk("LOW", "SSL")];

  // Major extremes over the recent window — the obvious magnets.
  const from = Math.max(0, n - cfg.rangeLookback);
  let hiP = -Infinity, loP = Infinity, hiI = from, loI = from;
  for (let j = from; j < n; j++) {
    if (candles[j].high > hiP) { hiP = candles[j].high; hiI = j; }
    if (candles[j].low < loP) { loP = candles[j].low; loI = j; }
  }
  const tolNow = cfg.eqTolAtr * atrSafeArr[n - 1];
  for (const [price, idx, side] of [[hiP, hiI, "BSL"], [loP, loI, "SSL"]]) {
    if (!Number.isFinite(price)) continue;
    const near = pools.find((p) => p.side === side && Math.abs(p.level - price) <= tolNow);
    if (near) { near.strength = "major"; continue; }
    pools.push({
      side, level: price, bandLo: price - tolNow, bandHi: price + tolNow,
      members: [{ i: idx, price, confirmedAt: idx }], count: 1, strength: "major",
      firstIdx: idx, lastIdx: idx, confirmedAt: idx, swept: false, sweepIdx: null,
    });
  }
  return pools.sort((a, b) => a.level - b.level);
}

/**
 * A sweep is a raid, not a breakout: the wick pierces the pool and the candle
 * CLOSES back inside. Predicates (1)-(5) are self-contained on bar j, so a
 * sweep is detectable with zero lookahead. `noReclaim` / `displacement` need
 * bars after j — near the tail they are null (NOT false) and the sweep is
 * marked unconfirmed, which caps any setup resting on it at grade C.
 *
 * Pool membership is evaluated AS OF bar j (only members already confirmed),
 * so a swing that prints later cannot retro-create a sweep.
 */
function detectSweeps(candles, pools, atrSafeArr, zones, cfg) {
  const n = candles.length;
  const sweeps = [];
  for (const P of pools) {
    for (let j = 0; j < n; j++) {
      const vis = P.members.filter((m) => m.confirmedAt <= j - 1);
      if (!vis.length) continue;
      const lastIdx = Math.max(...vis.map((m) => m.i));
      if (j <= lastIdx) continue;
      const prices = vis.map((m) => m.price);
      const a = atrSafeArr[j];
      const tol = cfg.eqTolAtr * a;
      const level = P.side === "BSL" ? Math.max(...prices) : Math.min(...prices);
      const bandHi = Math.max(...prices) + tol, bandLo = Math.min(...prices) - tol;
      const c = candles[j];
      const rng = c.high - c.low;
      if (rng <= 0) continue;

      let ok = false, pierce = 0, wickFrac = 0;
      if (P.side === "BSL") {
        pierce = c.high - level;
        wickFrac = (c.high - Math.max(c.open, c.close)) / rng;
        ok = c.high > bandHi && pierce >= cfg.minPierceAtr * a &&
             pierce <= cfg.maxPierceAtr * a && c.close < level &&
             wickFrac >= cfg.sweepWickFrac;
      } else {
        pierce = level - c.low;
        wickFrac = (Math.min(c.open, c.close) - c.low) / rng;
        ok = c.low < bandLo && pierce >= cfg.minPierceAtr * a &&
             pierce <= cfg.maxPierceAtr * a && c.close > level &&
             wickFrac >= cfg.sweepWickFrac;
      }
      if (!ok) continue;

      const horizon = j + cfg.sweepConfirmBars;
      const enoughBars = horizon <= n - 1;
      let noReclaim = null, displacement = null;
      if (enoughBars) {
        noReclaim = true;
        for (let k = j + 1; k <= horizon; k++) {
          if (P.side === "BSL" ? candles[k].close > bandHi : candles[k].close < bandLo) {
            noReclaim = false; break;
          }
        }
        displacement = false;
        for (let k = j + 1; k <= Math.min(n - 1, j + cfg.sweepDispWindow); k++) {
          const b = Math.abs(candles[k].close - candles[k].open) / atrSafeArr[k];
          const rightWay = P.side === "BSL"
            ? candles[k].close < candles[k].open
            : candles[k].close > candles[k].open;
          if (b >= 0.7 && rightWay) { displacement = true; break; }
        }
        if (!displacement) {
          displacement = zones.some(
            (z) => z.quality && z.i > j && z.i <= j + cfg.sweepDispWindow &&
                   (P.side === "BSL" ? z.dir === "bear" : z.dir === "bull"),
          );
        }
      }

      sweeps.push({
        side: P.side, type: P.side === "BSL" ? "buyside" : "sellside",
        j, ts: c.t, level, pierceAtr: r2(pierce / a), wickFrac: r2(wickFrac),
        extreme: P.side === "BSL" ? c.high : c.low,
        noReclaim, displacement,
        confirmed: enoughBars ? noReclaim === true : false,
        pending: !enoughBars,
        live: j >= n - cfg.sweepRecency,
        poolStrength: P.strength, poolCount: vis.length,
      });
      P.swept = true;
      P.sweepIdx = j;
      break; // one sweep per pool: the first raid is the one that matters
    }
  }
  return sweeps.sort((a, b) => a.j - b.j);
}

/**
 * Nearest untapped pool on one side. `realOnly` drops lone unclustered pivots
 * (strength "weak") — those are structure, not liquidity, and treating them as
 * magnets is what makes a target list useless.
 */
/**
 * Swing extremes price has never CLOSED beyond. A swing low that a later candle
 * closed under has had its liquidity taken and is no longer a destination; the
 * survivors are the running extremes, which is what "High เดิม / Low เดิม"
 * means on the chart.
 */
function unbrokenExtremes(candles, sw) {
  const n = candles.length;
  const out = [];
  for (const s of sw) {
    let broken = false;
    for (let j = s.i + 1; j < n; j++) {
      if (s.kind === "HIGH" ? candles[j].close > s.price : candles[j].close < s.price) {
        broken = true;
        break;
      }
    }
    if (!broken) out.push(s);
  }
  return out;
}

const nearestPool = (pools, from, side, above, realOnly = false) =>
  pools
    .filter(
      (p) => p.side === side && !p.swept && (above ? p.level > from : p.level < from) &&
             (!realOnly || p.strength !== "weak"),
    )
    .sort((a, b) => Math.abs(a.level - from) - Math.abs(b.level - from))[0] || null;

/* ------------------------------------------------------- premium / discount */

function dealingRange(candles, sw, breaks, bias, atrNow, cfg) {
  const n = candles.length;
  const price = candles[n - 1].close;
  let anchor = null, rangeLow = null, rangeHigh = null, source = "fallback-" + cfg.drFallbackBars;

  const lastBreak = [...breaks].reverse().find((b) => b.dir === bias) || null;
  if (bias === "up") {
    const lows = sw.filter(
      (s) => s.kind === "LOW" && s.price < price && (!lastBreak || s.i < lastBreak.j),
    );
    anchor = lows.length ? lows[lows.length - 1] : null;
    if (anchor) {
      rangeLow = anchor.price;
      rangeHigh = Math.max(...candles.slice(anchor.i).map((c) => c.high));
      source = "impulse-leg";
    }
  } else if (bias === "down") {
    const highs = sw.filter(
      (s) => s.kind === "HIGH" && s.price > price && (!lastBreak || s.i < lastBreak.j),
    );
    anchor = highs.length ? highs[highs.length - 1] : null;
    if (anchor) {
      rangeHigh = anchor.price;
      rangeLow = Math.min(...candles.slice(anchor.i).map((c) => c.low));
      source = "impulse-leg";
    }
  }
  if (!anchor) {
    const from = Math.max(0, n - cfg.drFallbackBars);
    rangeLow = Math.min(...candles.slice(from).map((c) => c.low));
    rangeHigh = Math.max(...candles.slice(from).map((c) => c.high));
  }

  const width = rangeHigh - rangeLow;
  const valid = width > 0 && width >= cfg.minRangeAtr * atrNow;
  const anchorIdx = anchor ? anchor.i : Math.max(0, n - cfg.drFallbackBars);
  return {
    valid, source, rangeLow, rangeHigh,
    equilibrium: (rangeHigh + rangeLow) / 2,
    width, anchorIdx,
    stale: n - 1 - anchorIdx > cfg.drMaxAgeBars,
    outsideRange: price > rangeHigh || price < rangeLow,
    reason: valid ? null : "degenerate-range",
  };
}

function rangePos(p, dr) {
  if (!dr.valid || dr.width <= 0) return null;
  return clamp((p - dr.rangeLow) / dr.width, 0, 1);
}
function pdZone(p, dr, cfg) {
  const rp = rangePos(p, dr);
  if (rp === null) return null;
  if (rp < 0.5 - cfg.eqBand) return "discount";
  if (rp > 0.5 + cfg.eqBand) return "premium";
  return "equilibrium";
}

/* ------------------------------------------------------------- core per-TF */

function coreAnalyze(candles, cfg, tfMsVal) {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const atrArr = atrSeries(candles, cfg.atrPeriod);
  const atrSafeArr = atrArr.map((v, i) =>
    Math.max(v, (candles[i].close * cfg.atrFloorPct) / 100),
  );
  const atrFloored = atrArr[n - 1] < atrSafeArr[n - 1];
  const atrNow = atrSafeArr[n - 1];
  const price = candles[n - 1].close;

  const sw = swings(candles, cfg.wing);
  const unbroken = unbrokenExtremes(candles, sw);
  const struct = classifyStructure(sw);
  const { zones, gapSkipped } = findFvgs(candles, atrSafeArr, tfMsVal, cfg);
  const { breaks, bias, ambiguous, warmupBars } = scanBreaks(candles, sw, atrSafeArr, zones, cfg);
  for (const z of zones) updateZoneState(z, candles, breaks, cfg);

  // Nested clusters: consecutive displacement bars stack zones. Flag them so the
  // ranker can report one trade instead of three.
  for (let a = 0; a < zones.length; a++) {
    for (let b = a + 1; b < zones.length; b++) {
      if (zones[a].dir !== zones[b].dir) continue;
      if (overlapFrac(zones[a], zones[b]) >= cfg.nestOverlap) {
        zones[a].nestedWith.push(zones[b].id);
        zones[b].nestedWith.push(zones[a].id);
      }
    }
  }

  const pools = buildPools(candles, sw, atrSafeArr, cfg);
  const sweeps = detectSweeps(candles, pools, atrSafeArr, zones, cfg);
  const dr = dealingRange(candles, sw, breaks, bias, atrNow, cfg);

  const ad = adx(candles, cfg.adxPeriod);
  const emaSlowSeries = emaSeries(closes, cfg.emaSlow);
  const back = Math.max(0, emaSlowSeries.length - 1 - cfg.emaSlopeLookback);
  const ref = emaSlowSeries[back];
  const slopePct = ref ? ((emaSlowSeries[emaSlowSeries.length - 1] - ref) / ref) * 100 : 0;

  const trPct = [];
  const tr = trueRanges(candles);
  for (let i = Math.max(1, n - 100); i < n; i++) trPct.push((tr[i] / candles[i].close) * 100);
  const baseVol = median(trPct) || 0;
  const atrPct = (atrNow / price) * 100;
  const volState =
    atrPct >= 4.5 || (baseVol && atrPct >= baseVol * 1.8) ? "high"
      : atrPct >= 3.0 || (baseVol && atrPct >= baseVol * 1.3) ? "elevated"
      : "normal";

  const isRange =
    ad === null ? null
      : ad.adx < cfg.adxTrendMin && struct.trend === "range" && Math.abs(slopePct) <= cfg.slopeEps;

  const trend =
    ad === null || n < cfg.htfMinBars ? "unknown"
      : isRange === true ? "range"
      : bias !== "none" && struct.trend !== (bias === "up" ? "down" : "up") ? bias
      : "range";

  return {
    n, price, candles, atrArr, atrSafeArr, atrNow, atrPct, atrFloored,
    sw, unbroken, struct, zones, breaks, bias, ambiguous, warmupBars,
    pools, sweeps, dr, adx: ad, slopePct, volState, isRange, trend, gapSkipped,
    lastClosedTs: candles[n - 1].closeT,
  };
}

/* ---------------------------------------------------------------- setups */

const GRADE_ORDER = { A: 3, B: 2, C: 1 };
const capGrade = (g, cap) => {
  if (!g || !cap) return g;
  return GRADE_ORDER[g] > GRADE_ORDER[cap] ? cap : g;
};

function classifyScenario(z, ctx) {
  const matches = [];
  if (z.sourceSweep) matches.push("fvg-sweep");
  if (z.postMss) matches.push("post-mss");
  if (z.dir === "bull" && z.postBos && ctx.bias === "up") matches.push("uptrend-bos");
  if (z.dir === "bear" && z.postBos && ctx.bias === "down") matches.push("downtrend-bos");
  if (ctx.isRange === true && z.inEdgeBand) matches.push("range-edge");
  return { scenario: matches[0] || "unclassified", alsoMatches: matches.slice(1) };
}

/**
 * TP is always a real LEVEL — the previous high/low or the next liquidity pool,
 * exactly as the infographic draws it. Manufacturing a target from an R-multiple
 * would fabricate an R:R the market never offered, so a zone with nothing above
 * it is rejected rather than given an invented number.
 */
function planTrade(z, scenario, ctx) {
  const cfg = ctx.cfg;
  const long = z.dir === "bull";
  const atrNow = ctx.atrNow;
  const entry = z.ce;
  const buf = Math.max(cfg.slBufferAtr * atrNow, (entry * cfg.slBufferPct) / 100);

  let slBase = long ? z.bottom : z.top;
  if (scenario === "post-mss") {
    const s = long ? ctx.struct.lastLow : ctx.struct.lastHigh;
    if (s) slBase = long ? Math.min(slBase, s.price) : Math.max(slBase, s.price);
  } else if (scenario === "fvg-sweep" && z.sweepExtreme != null) {
    slBase = long ? Math.min(slBase, z.sweepExtreme) : Math.max(slBase, z.sweepExtreme);
  } else if (scenario === "range-edge" && z.edgeBand) {
    slBase = long ? Math.min(slBase, z.edgeBand.lo) : Math.max(slBase, z.edgeBand.hi);
  }
  let sl = long ? slBase - buf : slBase + buf;

  let risk = Math.abs(entry - sl);
  let slWidened = false;
  if (risk < cfg.minStopAtr * atrNow) {
    risk = cfg.minStopAtr * atrNow;
    sl = long ? entry - risk : entry + risk;
    slWidened = true;
  }
  if (risk > cfg.maxStopAtr * atrNow) return { reject: "stop-too-wide", entry, sl };

  // A target is a place where orders actually rest — an untapped liquidity pool
  // or the structural extreme the infographic calls "High เดิม". It is NOT the
  // nearest pivot: with wing=2 a swing prints every ~4 bars, so "nearest swing
  // beyond entry" lands a few ticks away and manufactures an R:R of 0.05.
  // Lone unclustered pivots (strength "weak") are therefore excluded, and every
  // candidate must sit at least minTargetAtr away to count as a destination.
  const side = long ? "BSL" : "SSL";
  const kind = long ? "HIGH" : "LOW";
  const minDist = cfg.minTargetAtr * atrNow;
  const maxDist = cfg.maxTargetAtr * atrNow;
  // A target must be (a) far enough from entry to be a destination rather than
  // noise, (b) close enough to be reachable on this timeframe, and (c) not a
  // level price has already traded past — a "target" between the entry and the
  // current price was reached before the trade even started.
  const beyond = (lvl) => {
    const d = long ? lvl - entry : entry - lvl;
    if (d < minDist || d > maxDist) return false;
    return long ? lvl > ctx.price : lvl < ctx.price;
  };
  const cands = [];
  const addPools = (pools, src) => {
    for (const p of pools) {
      if (p.side !== side || p.swept) continue;
      if (beyond(p.level)) cands.push({ lvl: p.level, src });
    }
  };
  addPools(ctx.pools, side + "-pool");
  for (const s of ctx.unbroken) {
    if (s.kind === kind && beyond(s.price)) cands.push({ lvl: s.price, src: long ? "swing-high" : "swing-low" });
  }
  if (ctx.htf) {
    addPools(ctx.htf.pools, "htf-pool");
    for (const s of ctx.htf.unbroken) {
      if (s.kind === kind && beyond(s.price)) cands.push({ lvl: s.price, src: "htf-swing" });
    }
  }
  if (ctx.dr.valid) {
    const edge = long ? ctx.dr.rangeHigh : ctx.dr.rangeLow;
    if (beyond(edge)) cands.push({ lvl: edge, src: scenario === "range-edge" ? "range-edge" : "range-extreme" });
  }
  cands.sort((a, b) => Math.abs(a.lvl - entry) - Math.abs(b.lvl - entry));
  if (!cands.length) return { reject: "no-target", entry, sl };

  const shave = cfg.tpShaveAtr * atrNow;
  const tp1 = long ? cands[0].lvl - shave : cands[0].lvl + shave;
  const second = cands.find((c) => (long ? c.lvl > cands[0].lvl : c.lvl < cands[0].lvl));
  const tp2 = second ? (long ? second.lvl - shave : second.lvl + shave) : null;

  const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : null;
  const rr2 = second && risk > 0 ? Math.abs(tp2 - entry) / risk : null;
  return {
    entry, sl, tp1, tp2, rr, rr2, slWidened,
    tpSource: cands[0].src, riskAtr: risk / atrNow,
  };
}

function scoreZone(z, scenario, ctx) {
  const reasons = [], missing = [], unknowns = [];
  let score = 0;
  const add = (code, label, w) => { score += w; reasons.push({ code, label, weight: w }); };

  if (z.postMss && !z.mssWeak) add("post-mss", "เกิดหลัง MSS (เปลี่ยนโครงสร้าง)", 22);
  else if (z.postBos || z.postMss) add("post-bos", z.postMss ? "เกิดหลัง MSS อ่อน" : "เกิดหลัง BOS (ยืนยันเทรนด์)", 18);
  else missing.push("post-bos/mss");

  if (z.htfAligned === true) add("htf-aligned", "TF ใหญ่ตรงทาง", 18);
  else if (z.htfAligned === false) { score -= 12; reasons.push({ code: "htf-conflict", label: "TF ใหญ่สวนทาง", weight: -12 }); }
  else { missing.push("htf-trend"); unknowns.push("htf-trend ยังไม่ชัด"); }

  if (z.pdAligned === true) add("pd-aligned", z.dir === "bull" ? "อยู่โซน discount" : "อยู่โซน premium", 14);
  else if (z.pdAligned === "partial") add("pd-partial", "อยู่แถว equilibrium", 7);
  else if (z.pdAligned === false) { score -= 10; reasons.push({ code: "pd-wrong", label: "อยู่ผิดโซน (premium สำหรับ long / discount สำหรับ short)", weight: -10 }); }
  else { missing.push("premium-discount"); unknowns.push("ช่วงราคาใช้ไม่ได้ (degenerate)"); }

  if (z.targetLiquidity) {
    const bonus = ["strong", "major"].includes(z.targetLiquidity.strength) ? 4 : 0;
    add("target-liq", `มี ${z.targetLiquidity.side} รออยู่ (${z.targetLiquidity.strength})`, 12 + bonus);
  } else missing.push("target-liquidity");

  if (z.sourceSweep) add("source-sweep", "เกิดหลังกวาด liquidity", 12);
  else missing.push("liquidity-sweep");

  const disp = Math.round((z.displacement.score || 0) * 10);
  if (disp > 0) add("displacement", `แท่ง momentum แรง (${z.displacement.bodyAtr}×ATR)`, disp);

  if (z.state === "fresh") add("fresh", "โซนยังไม่ถูกแตะ", 8);
  else if (z.state === "tapped") add("tapped", "แตะแล้วแต่ยังไม่ถึง 50%", 4);

  if (z.htfOverlap) add("htf-fvg", "ทับ FVG ของ TF ใหญ่", 6);
  else missing.push("htf-fvg");
  if (z.htfFvgConflict) { score -= 8; reasons.push({ code: "htf-fvg-conflict", label: "อยู่ใน FVG ทิศตรงข้ามของ TF ใหญ่", weight: -8 }); }

  if (z.displacement.volMult === null) { missing.push("volume"); unknowns.push("volume=0 — ข้ามคอนฟลูเอนซ์ volume"); }
  else if (z.displacement.volMult >= 1.2) add("volume", `volume ${z.displacement.volMult}× ค่าเฉลี่ย`, 4);
  else missing.push("volume");

  return { score: clamp(Math.round(score), 0, 100), reasons, missing, unknowns };
}

function gradeOf(score, z, scenario, plan, ctx, capsOut = []) {
  const cfg = ctx.cfg;
  const structural = z.postMss || z.postBos;
  const cap = (g, to, why) => {
    if (g && GRADE_ORDER[g] > GRADE_ORDER[to]) { capsOut.push(why); return to; }
    return g;
  };
  let g = null;
  if (
    score >= cfg.gradeAMin && structural && z.htfAligned === true && z.pdAligned !== false &&
    plan.rr >= cfg.minRrGradeA && z.state !== "ce" && !ctx.atrFloored &&
    (scenario !== "fvg-sweep" || z.sweepConfirmed === true)
  ) g = "A";
  else if (score >= cfg.gradeBMin && (structural || z.sourceSweep) && plan.rr >= cfg.minRr) g = "B";
  else if (score >= cfg.gradeCMin) g = "C";

  // Caps — each one is a fact the engine could NOT confirm. They are recorded in
  // `gradeCaps` so a high-scoring setup that lands on C says why, instead of
  // looking like an arithmetic mistake.
  if (ctx.partial) g = cap(g, "C", "ข้อมูลบางส่วน");
  if (ctx.atrFloored) g = cap(g, "C", "ATR ต่ำผิดปกติ");
  if (ctx.bias === "none") g = cap(g, "C", "ยังไม่มี bias โครงสร้าง");
  if (scenario === "fvg-sweep" && z.sweepConfirmed !== true) g = cap(g, "C", "sweep ยังไม่ยืนยัน");
  if (z.htfAligned === false && ["uptrend-bos", "downtrend-bos", "post-mss"].includes(scenario))
    g = cap(g, "C", "TF ใหญ่สวนทาง");
  if (scenario === "range-edge") {
    if (z.edgeProvisional) {
      const to = g === "A" ? "B" : g === "B" ? "C" : g;
      if (to !== g) { capsOut.push("ขอบกรอบยังไม่ถูกทดสอบ"); g = to; }
    }
    if (ctx.volState === "high") g = cap(g, "C", "ความผันผวนสูง");
  }
  return g;
}

/* --------------------------------------------------------------- analyze */

function analyze(rawCandles, rawHtfCandles, opts = {}) {
  const cfg = { ...CFG, ...(opts.cfg || {}) };
  const tf = opts.tf || cfg.entryTf;
  const htfTf = opts.htfTf || cfg.htfTf;
  const tfMsVal = opts.tfMs || tfMs(tf);
  const htfMsVal = opts.htfMs || tfMs(htfTf);
  const warnings = [], unknowns = [];

  const norm = normalizeCandles(rawCandles);
  if (norm.rawLen && norm.malformedDropped / norm.rawLen > cfg.malformedMaxFrac)
    return { ok: false, msg: `ข้อมูลผิดรูปมากเกินไป (${norm.malformedDropped}/${norm.rawLen})` };

  const sealed = sealCandles(norm.candles, opts.nowMs);
  const candles = sealed.closed;
  if (candles.length < cfg.minBarsPartial)
    return { ok: false, msg: `แท่งไม่พอ (ต้อง ≥ ${cfg.minBarsPartial} แท่งที่ปิดแล้ว, ได้ ${candles.length})` };

  const partial = candles.length < cfg.minBars;
  if (partial) warnings.push(`ข้อมูลบางส่วน (${candles.length} แท่ง) — จำกัดเกรดสูงสุดที่ C`);
  if (norm.malformedDropped) warnings.push(`ตัดแท่งผิดรูป ${norm.malformedDropped} แท่ง`);

  const core = coreAnalyze(candles, cfg, tfMsVal);
  if (core.gapSkipped) warnings.push(`ข้ามช่องว่างปลอมจากข้อมูลขาด ${core.gapSkipped} จุด`);
  if (core.atrFloored) warnings.push("ATR ต่ำผิดปกติ (ใช้ค่าพื้น) — จำกัดเกรดสูงสุดที่ C");
  if (core.ambiguous.length) warnings.push(`break กำกวม ${core.ambiguous.length} จุด`);
  if (core.bias === "none") warnings.push("ยังไม่พบ swing ที่ยืนยันพอจะตั้ง bias");
  if (core.adx === null) unknowns.push("ADX ยังคำนวณไม่ได้ — ปิดการหา setup แบบ range");
  if (Number.isFinite(opts.nowMs) && tfMsVal &&
      opts.nowMs - core.lastClosedTs > cfg.staleDataTfMult * tfMsVal)
    warnings.push("ข้อมูลอาจไม่สด");

  // The plateau rule makes our swing set a superset of the desk's strict one, so
  // a divergence is expected and not worth a warning. Finding FEWER pivots than
  // the strict rule would mean the detector is broken — that is worth one.
  const fs = fractalsStrict(candles, cfg.wing);
  const strictCount = fs.highs.length + fs.lows.length;
  if (core.sw.length < strictCount)
    warnings.push(`swing set เล็กกว่า fractals ของ desk (${core.sw.length} < ${strictCount}) — ผิดปกติ`);

  // ---- HTF ----
  let htf = null, htfTrend = "unknown";
  const htfNorm = normalizeCandles(rawHtfCandles);
  const htfSealed = sealCandles(htfNorm.candles, opts.nowMs);
  if (htfSealed.closed.length >= cfg.htfMinBars) {
    htf = coreAnalyze(htfSealed.closed, cfg, htfMsVal);
    htfTrend = htf.trend;
  } else {
    unknowns.push(`TF ใหญ่ (${htfTf}) แท่งไม่พอ — ข้ามการเทียบเทรนด์`);
  }
  // Cross-timeframe causality: an HTF zone is visible only once it has closed
  // within the entry-TF's own timeline. Linking by index instead of timestamp
  // is the subtlest lookahead available here.
  const htfZonesVisible = htf
    ? htf.zones.filter((z) => z.confirmTs <= core.lastClosedTs && z.state !== "invalidated")
    : [];

  // ---- enrich zones with cross-cutting context ----
  const edge = buildEdgeBands(core, cfg);
  for (const z of core.zones) {
    const bull = z.dir === "bull";
    const inWindow = (b) =>
      (bull ? b.dir === "up" : b.dir === "down") &&
      z.confirmIdx - b.j >= 0 && z.confirmIdx - b.j <= cfg.postBreakWindow;
    const mss = core.breaks.find((b) => b.isMss && inWindow(b));
    const bos = core.breaks.find((b) => !b.isMss && inWindow(b));
    z.postMss = !!mss;
    z.mssWeak = mss ? !!mss.weak : false;
    z.postBos = !mss && !!bos;

    const sw0 = core.sweeps.find(
      (s) => (bull ? s.side === "SSL" : s.side === "BSL") &&
             z.confirmIdx - s.j >= 0 && z.confirmIdx - s.j <= cfg.sweepToFvgWindow,
    );
    z.sourceSweep = !!sw0;
    z.sweepExtreme = sw0 ? sw0.extreme : null;
    z.sweepConfirmed = sw0 ? sw0.confirmed : null;

    const tgt = nearestPool(core.pools, z.ce, bull ? "BSL" : "SSL", bull, true);
    z.targetLiquidity =
      tgt && Math.abs(tgt.level - z.ce) <= cfg.nearLiqAtr * core.atrNow
        ? { side: tgt.side, level: tgt.level, strength: tgt.strength, distAtr: r2(Math.abs(tgt.level - z.ce) / core.atrNow) }
        : null;

    const pz = pdZone(z.ce, core.dr, cfg);
    if (pz === null) z.pdAligned = null;
    else if (pz === "equilibrium") z.pdAligned = "partial";
    else z.pdAligned = bull ? pz === "discount" : pz === "premium";
    if (z.pdAligned === true && core.dr.stale) z.pdAligned = "partial";
    if (core.dr.outsideRange && z.pdAligned === true) z.pdAligned = "partial";

    z.htfAligned =
      htfTrend === "unknown" || htfTrend === "range" ? null
        : (htfTrend === "up") === bull ? true : false;

    z.htfOverlap = htfZonesVisible.some((h) => h.dir === z.dir && overlapFrac(z, h) >= 0.25);
    z.htfFvgConflict = htfZonesVisible.some(
      (h) => h.dir !== z.dir && z.ce <= h.top && z.ce >= h.bottom,
    );

    const band = bull ? edge.support : edge.resistance;
    z.inEdgeBand = !!(band && z.ce >= band.lo && z.ce <= band.hi &&
      (bull ? (rangePos(z.ce, core.dr) ?? 1) <= 0.4 : (rangePos(z.ce, core.dr) ?? 0) >= 0.6));
    z.edgeBand = z.inEdgeBand ? band : null;
    z.edgeProvisional = z.inEdgeBand ? band.provisional : false;

    z.actionable = Math.abs(core.price - z.ce) <= cfg.maxDriftAtr * core.atrNow;
  }

  // ---- setups ----
  const ctx = {
    cfg, bias: core.bias, struct: core.struct, pools: core.pools, sw: core.sw,
    unbroken: core.unbroken, price: core.price,
    dr: core.dr, atrNow: core.atrNow, atrFloored: core.atrFloored, isRange: core.isRange,
    volState: core.volState, partial,
    htf: htf ? { pools: htf.pools, sw: htf.sw, unbroken: htf.unbroken } : null,
  };

  const setups = [], watchlist = [];
  const lastIdx = core.n - 1;
  for (const z of core.zones) {
    const { scenario, alsoMatches } = classifyScenario(z, ctx);
    const push = (reject, extra) =>
      watchlist.push({ id: z.id, dir: z.dir, scenario, reject, top: z.top, bottom: z.bottom, state: z.state, ...extra });

    if (!z.quality) { push("not-quality"); continue; }
    if (!["fresh", "tapped", "ce"].includes(z.state)) { push("state-" + z.state); continue; }
    if (scenario === "unclassified") { push("no-structural-story"); continue; }
    if (z.barsSinceForm > cfg.maxAgeBars) { push("too-old"); continue; }
    if (!z.actionable) { push("out-of-reach"); continue; }

    const plan = planTrade(z, scenario, ctx);
    if (plan.reject) { push(plan.reject); continue; }
    if (!(plan.rr >= cfg.minRr)) { push("rr-below-min", { rr: r2(plan.rr) }); continue; }

    const sc = scoreZone(z, scenario, ctx);
    const gradeCaps = [];
    const grade = gradeOf(sc.score, z, scenario, plan, ctx, gradeCaps);
    if (!grade) { push("score-below-min", { score: sc.score, rr: r2(plan.rr) }); continue; }

    // readiness: the whole point. A zone the price has not reached is a PLAN.
    const lc = core.candles[lastIdx];
    const bull = z.dir === "bull";
    const intersects = bull ? lc.low <= z.top && lc.high >= z.bottom : lc.high >= z.bottom && lc.low <= z.top;
    const reacted = bull
      ? lc.low <= z.top && lc.close > z.bottom && lc.close > lc.open && lc.close > z.ce
      : lc.high >= z.bottom && lc.close < z.top && lc.close < lc.open && lc.close < z.ce;
    const readiness = reacted ? "triggered" : intersects ? "armed" : "waiting";

    setups.push({
      id: z.id, scenario, alsoMatches, dir: bull ? "long" : "short",
      grade, score: sc.score, readiness,
      entryType: readiness === "triggered" ? "confirmed-close" : "limit-plan",
      zone: { top: r4(z.top), bottom: r4(z.bottom), ce: r4(z.ce), sizeAtr: z.sizeAtr, state: z.state },
      entry: r4(plan.entry), sl: r4(plan.sl), tp1: r4(plan.tp1), tp2: r4(plan.tp2),
      rr: r2(plan.rr), rr2: r2(plan.rr2), riskAtr: r2(plan.riskAtr),
      tpSource: plan.tpSource, slWidened: plan.slWidened,
      reasons: sc.reasons, missing: sc.missing, gradeCaps,
      invalidation: `close ${bull ? "ต่ำกว่า" : "สูงกว่า"} ${r4(plan.sl)} (${bull ? "ใต้" : "เหนือ"} FVG) → thesis เสีย`,
      barsSinceForm: z.barsSinceForm,
      sweepConfirmed: z.sweepConfirmed,
    });
    for (const u of sc.unknowns) if (!unknowns.includes(u)) unknowns.push(u);
  }

  // Rank, then keep one per nested cluster so a single trade is not reported thrice.
  setups.sort((a, b) => b.score - a.score || a.barsSinceForm - b.barsSinceForm);
  const zoneById = new Map(core.zones.map((z) => [z.id, z]));
  const taken = new Set(), ranked = [];
  for (const s of setups) {
    if (taken.has(s.id)) continue;
    ranked.push(s);
    for (const nid of zoneById.get(s.id).nestedWith) taken.add(nid);
    if (ranked.length >= cfg.maxSetups) break;
  }

  for (const s of core.sweeps)
    if (s.live && s.pending) unknowns.push(`sweep แท่ง ${s.j} ยังไม่ยืนยัน (รออีก ${cfg.sweepConfirmBars - (core.n - 1 - s.j)} แท่ง)`);
  if (cfg.wing > 0) warnings.push(`${cfg.wing} แท่งล่าสุดยังไม่ยืนยัน pivot`);

  const lastBos = [...core.breaks].reverse().find((b) => !b.isMss) || null;
  const lastMss = [...core.breaks].reverse().find((b) => b.isMss) || null;

  return {
    ok: true,
    engine: "smc-radar v0.1.0",
    advisoryOnly: true,
    tf, htfTf,
    asOf: {
      closedBars: core.n, lastClosedTs: core.lastClosedTs,
      droppedUnclosed: sealed.droppedUnclosed, malformedDropped: norm.malformedDropped,
      partial,
    },
    price: r4(core.price), atr: r4(core.atrNow), atrPct: r2(core.atrPct), atrFloored: core.atrFloored,
    structure: {
      bias: core.bias, trend: core.struct.trend,
      adx: core.adx ? r2(core.adx.adx) : null,
      plusDI: core.adx ? r2(core.adx.plusDI) : null,
      minusDI: core.adx ? r2(core.adx.minusDI) : null,
      slopePct: r2(core.slopePct),
      lastHigh: core.struct.lastHigh, prevHigh: core.struct.prevHigh,
      lastLow: core.struct.lastLow, prevLow: core.struct.prevLow,
      swingsConfirmed: core.sw.length, unconfirmedTailBars: cfg.wing,
      agree: core.bias === "none" || core.struct.trend === "range" || core.bias === core.struct.trend,
    },
    breaks: core.breaks.map((b) => ({
      kind: b.kind, j: b.j, ts: b.ts, level: r4(b.level), brokenSwing: b.brokenSwing,
      biasBefore: b.biasBefore, biasAfter: b.biasAfter,
      displacementAtr: b.displacementAtr, weak: b.weak, seed: b.seed, reliable: b.reliable,
    })),
    lastBos, lastMss,
    pd: {
      valid: core.dr.valid, source: core.dr.source,
      rangeLow: r4(core.dr.rangeLow), rangeHigh: r4(core.dr.rangeHigh),
      equilibrium: r4(core.dr.equilibrium),
      rangePos: r2(rangePos(core.price, core.dr)),
      zone: pdZone(core.price, core.dr, cfg),
      anchorIdx: core.dr.anchorIdx, stale: core.dr.stale,
      outsideRange: core.dr.outsideRange, reason: core.dr.reason,
    },
    regime: { isRange: core.isRange, volState: core.volState, trend: core.trend },
    liquidity: {
      pools: core.pools
        .filter((p) => Math.abs(p.level - core.price) <= cfg.poolReportAtr * core.atrNow)
        .map((p) => ({
        side: p.side, level: r4(p.level), bandLo: r4(p.bandLo), bandHi: r4(p.bandHi),
        count: p.count, strength: p.strength, swept: p.swept, sweepIdx: p.sweepIdx,
        distAtr: r2(Math.abs(p.level - core.price) / core.atrNow),
      })),
      sweeps: core.sweeps.map((s) => ({
        type: s.type, j: s.j, ts: s.ts, level: r4(s.level), extreme: r4(s.extreme),
        pierceAtr: s.pierceAtr, wickFrac: s.wickFrac,
        noReclaim: s.noReclaim, displacement: s.displacement,
        confirmed: s.confirmed, pending: s.pending, live: s.live,
      })),
      nearestAbove: fmtPool(nearestPool(core.pools, core.price, "BSL", true, true), core),
      nearestBelow: fmtPool(nearestPool(core.pools, core.price, "SSL", false, true), core),
    },
    range: edge,
    zones: core.zones.map((z) => ({
      id: z.id, dir: z.dir, top: r4(z.top), bottom: r4(z.bottom), ce: r4(z.ce),
      size: r4(z.size), sizePct: z.sizePct, sizeAtr: z.sizeAtr,
      i: z.i, confirmIdx: z.confirmIdx, ts: z.ts, confirmTs: z.confirmTs,
      displacement: z.displacement, quality: z.quality, formGrade: formGrade(z, cfg),
      state: z.state, invalidReason: z.invalidReason, barsSinceForm: z.barsSinceForm,
      firstTouchIdx: z.firstTouchIdx, ceIdx: z.ceIdx, fillIdx: z.fillIdx,
      maxPenetration: z.maxPenetration, reaction: z.reaction,
      actionable: z.actionable, nestedWith: z.nestedWith,
      postBos: z.postBos, postMss: z.postMss, sourceSweep: z.sourceSweep,
      pdAligned: z.pdAligned, htfAligned: z.htfAligned,
    })),
    htf: htf
      ? {
          tf: htfTf, trend: htfTrend, bias: htf.bias,
          adx: htf.adx ? r2(htf.adx.adx) : null, bars: htf.n,
          zones: htfZonesVisible.map((z) => ({
            id: z.id, dir: z.dir, top: r4(z.top), bottom: r4(z.bottom),
            state: z.state, quality: z.quality, ts: z.ts,
          })),
        }
      : { tf: htfTf, trend: "unknown", bias: "none", adx: null, bars: htfSealed.closed.length, zones: [] },
    setups: ranked,
    watchlist,
    warnings,
    unknowns,
  };
}

/**
 * A grade that depends ONLY on data available when the zone formed: the three
 * candles and the breaks up to confirmIdx. Unlike the live setup grade it can
 * never be rewritten by a future bar, which is what the formation-immutability
 * test in Phase 2 pins.
 */
function formGrade(z, cfg) {
  if (!z.quality) return "C";
  const structural = z.postMss || z.postBos;
  const d = z.displacement.score || 0;
  if (structural && d >= 0.7 && z.sizeAtr >= 0.5) return "A";
  if (structural || d >= 0.6) return "B";
  return "C";
}

function fmtPool(p, core) {
  if (!p) return null;
  return {
    side: p.side, level: r4(p.level), strength: p.strength,
    distAtr: r2(Math.abs(p.level - core.price) / core.atrNow),
  };
}

/**
 * Support/resistance bands for the range play. Prefer the liquidity pool near
 * the edge — that is where orders actually sit — over the raw extreme. A band
 * with fewer than `minEdgeTouches` touches is a hypothesis, not a level, so it
 * is marked provisional and costs the setup a grade.
 */
function buildEdgeBands(core, cfg) {
  const { candles, n, dr, atrNow, pools } = core;
  const eb = cfg.edgeBandAtr * atrNow;
  const mk = (level, side) => {
    const pool = pools.find((p) => p.side === side && Math.abs(p.level - level) <= atrNow);
    const lo = pool ? pool.bandLo : level - eb;
    const hi = pool ? pool.bandHi : level + eb;
    let touches = 0, lastTouch = -99;
    for (let j = Math.max(0, n - cfg.rangeLookback); j < n; j++) {
      const hit = side === "BSL" ? candles[j].high >= lo : candles[j].low <= hi;
      if (hit && j - lastTouch > cfg.wing) { touches++; lastTouch = j; }
    }
    return { lo: r4(lo), hi: r4(hi), touches, provisional: touches < cfg.minEdgeTouches, fromPool: !!pool };
  };
  if (!dr.valid) return { support: null, resistance: null };
  return { resistance: mk(dr.rangeHigh, "BSL"), support: mk(dr.rangeLow, "SSL") };
}

/* ------------------------------------------------------------ SL hazard --
 * slHazardDecide — is a proposed stop-loss part of (or within raid reach of)
 * a visible liquidity pool? Observation-only by mandate
 * (liquidity_hazard_2026_07_28): the one measured external dataset on this
 * idea (MiroFish/SMT, n=990) shows marked pools touched LESS than mirrored
 * controls, so this must never gate or move an order — it prices the cheap
 * insurance of not parking a stop inside the crowd's pile, and produces the
 * log that could one day justify more.
 *
 * `pools` uses the REPORTED shape from analyze().liquidity.pools
 * ({side, level, bandLo, bandHi, count, strength, swept}); `atr` is the
 * top-level analyze().atr. unknown ≠ clear: bad inputs must not read as safe.
 */
function slHazardDecide({ side, entry, stop, pools, atr }) {
  const s = String(side || "").toUpperCase();
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(atr) || atr <= 0 ||
      !Array.isArray(pools) || (s !== "BUY" && s !== "SELL"))
    return { hazard: "unknown", reason: "bad-inputs" };
  const long = s === "BUY";
  if (long ? stop >= entry : stop <= entry) return { hazard: "unknown", reason: "stop-wrong-side" };
  // The crowd's stops pile beyond the pool on OUR side of the trade:
  // long stops under SSL (equal lows), short stops over BSL (equal highs).
  // A lone "weak" pivot is not a pile — same realOnly rule as nearestPool
  // (weak-eq/strong = equal touches; major = range extreme, a pile even alone).
  const rel = pools.filter((p) => p && !p.swept && p.strength !== "weak" &&
    p.side === (long ? "SSL" : "BSL") &&
    Number.isFinite(p.level) && Number.isFinite(p.bandLo) && Number.isFinite(p.bandHi) &&
    (long ? p.level < entry : p.level > entry));
  if (!rel.length) return { hazard: "none" };
  const pad = 0.25 * atr;      // band slack — the pile's edge still counts as the pile
  const pierce = CFG.maxPierceAtr * atr; // deepest raid detectSweeps still calls a sweep
  const approach = 1.0 * atr;  // pool just beyond the stop → stop sits on the raid path
  const RANK = { high: 3, mid: 2, clear: 1 };
  let best = null;
  for (const p of rel) {
    // Signed geometry, oriented so "deeper than the pool" is the safe side.
    const beyond = long ? p.bandLo - stop : stop - p.bandHi;   // >0: stop deeper than band
    const before = long ? stop - p.bandHi : p.bandLo - stop;   // >0: stop shallower than band
    let mode, gapAtr;
    if (beyond >= -pad && beyond <= pad && before <= pad) { mode = "in-band"; gapAtr = 0; }
    else if (before > pad) {
      if (before - pad > approach) continue;                   // pool far beyond the stop — irrelevant
      mode = "on-approach"; gapAtr = before / atr;             // raid to the pool runs through our stop
    } else if (beyond > pad && beyond <= pierce) { mode = "pierce-reach"; gapAtr = beyond / atr; }
    else if (beyond > pierce) { mode = "beyond-pierce"; gapAtr = beyond / atr; }
    else { mode = "in-band"; gapAtr = 0; }                     // inside the padded band
    const hazard = mode === "in-band" ? "high" : mode === "beyond-pierce" ? "clear" : "mid";
    const cand = { hazard, mode, gapAtr: r2(gapAtr),
      distPct: r2(Math.abs(stop - p.level) / entry * 100),
      pool: { side: p.side, level: p.level, bandLo: p.bandLo, bandHi: p.bandHi,
              count: p.count, strength: p.strength } };
    if (!best || RANK[hazard] > RANK[best.hazard] ||
        (RANK[hazard] === RANK[best.hazard] && cand.gapAtr < best.gapAtr)) best = cand;
  }
  return best || { hazard: "none" };
}

/** Backtest hook: the analysis exactly as it would have read at bar k. */
function analyzeAsOf(candles, htfCandles, k, opts = {}) {
  const c = (Array.isArray(candles) ? candles : []).slice(0, k + 1);
  const cutoff = c.length ? c[c.length - 1].closeT : 0;
  const h = (Array.isArray(htfCandles) ? htfCandles : []).filter((x) => x && x.closeT <= cutoff);
  return analyze(c, h, { ...opts, nowMs: cutoff });
}

module.exports = {
  analyze,
  analyzeAsOf,
  slHazardDecide,
  _fvg: { findFvgs, updateZoneState, overlapFrac, formGrade },
  _struct: { swings, fractalsStrict, scanBreaks, classifyStructure, dealingRange, rangePos, pdZone },
  _liq: { buildPools, detectSweeps, nearestPool, unbrokenExtremes },
  _setup: { classifyScenario, scoreZone, planTrade, gradeOf, capGrade },
  _ta: { emaSeries, ema, atr, atrSeries, adx, rsi, avgVolAt, median, clamp, trueRanges },
  _util: { normalizeCandles, sealCandles, tfMs, coreAnalyze, buildEdgeBands },
  CFG,
};
