// 📈 Binance Trader — read-only Futures access (testnet by default).
// Zero-dependency: uses only Node built-ins (https, crypto, fs). Trading is
// intentionally absent from this first cut — only status/price/ticker/balance/
// positions. The panel can flip tradeEnabled on later, but no `order` command
// is wired up until a guarded follow-up.
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---- Telegram alert formatter (HTML parse mode, mobile-friendly) ----
// Builds visually clean alert blocks. Each alert has a colored header bar
// (emoji + title), a compact body, and a dim footer. Designed to be scannable
// at a glance on a phone lock screen.
const fmtPrice = (p) => p == null ? "—" : Number(p).toLocaleString("en-US", { maximumFractionDigits: 4 });
const fmtUsd = (v) => (v >= 0 ? "+" : "") + "$" + Math.abs(v).toFixed(2);
// %-of-equity rounding: pct + usd to 2dp, null-safe so a missing risk-at-stop
// (no tracked stop) passes straight through.
const pct2 = (v) => v == null || !isFinite(v) ? null : Math.round(Number(v) * 100) / 100;
const usd2 = (v) => v == null || !isFinite(v) ? null : Math.round(Number(v) * 100) / 100;
// Build a single alert message. kind drives the emoji + color word.
// rows = [{label, value, accent?}] rendered as "label: value" lines.
function tgAlert(opts) {
  const { kind, title, rows, footer } = opts;
  const styles = {
    signal:  { icon: "🔭", tag: "SIGNAL" },
    entry:   { icon: "🤖", tag: "ENTRY" },
    exit:    { icon: "🚪", tag: "EXIT" },
    warn:    { icon: "⚠️", tag: "WARNING" },
    danger:  { icon: "🚨", tag: "ALERT" },
    cool:    { icon: "🧊", tag: "COOLDOWN" },
    open:    { icon: "🟢", tag: "OPENED" },
    close:   { icon: "🔴", tag: "CLOSED" },
  };
  const s = styles[kind] || styles.signal;
  const header = `${s.icon} <b>${s.tag}</b> — ${title}`;
  const body = (rows || []).map((r) =>
    `  ${r.label}: <b>${r.value}</b>${r.accent ? ` <i>${r.accent}</i>` : ""}`
  ).join("\n");
  return [header, body, footer ? `  <i>${footer}</i>` : ""].filter(Boolean).join("\n");
}

// Binance Futures base URLs. The testnet is the default so a freshly-installed
// plugin can never accidentally hit the real money endpoint.
const URLS = {
  testnet: "https://demo-fapi.binance.com",
  mainnet: "https://fapi.binance.com",
};
const DEFAULTS = {
  testnet: true,
  tradeEnabled: false,        // read-only until explicitly opened
  // Per-order notional cap as a % of equity — a pure BACKSTOP, not the sizer.
  // Real size comes from %-risk (qty = equity×riskPct/stopDist); this only stops
  // a pathologically tight stop from blowing size up. notional = qty×price must
  // stay <= equity×maxNotionalPct%. At $5002 base, 100% = ~$5000. By design this
  // does NOT bind a normal setup: a 0.5% stop sizes to exactly ~equity notional,
  // which equals the cap (strict `>`), so it passes. Tighter-than-0.5% stops get
  // trimmed to ~$5000. Bounds BOTH manual orders (tradeGuard) and the auto path.
  maxNotionalPct: 100,        // ~$5000 backstop @ $5002 base (was 60/$3000)
  maxLeverage: 20,            // hard CEILING on leverage (was flat 5x). Effective
                              // leverage is squeezed BELOW this by dynamicLeverage
                              // (Option B) based on stop width — see below.
  leverageDefault: 3,         // desk default leverage (set via `leverage` cmd; cap = maxLeverage)
  // Dynamic leverage guardrail (Option B — replaces the flat 5x cap). Effective
  // leverage is gated by STOP WIDTH so liquidation always sits a safe multiple
  // beyond the stop. The tier table squeezes effective leverage DOWN as the stop
  // widens (auto-cap, never up); maxLeverage above is only the ceiling:
  //   stop ≤3% → 20x · 3–4% → 15x · 4–6% → 10x · >6% → 7x
  // Principle: liquidation distance (≈100/lev %) must stay ≥ liqBufferMult× the
  // stop distance. If even the lowest tier can't clear that buffer (stop too
  // wide), the trade is REJECTED; otherwise leverage is auto-capped to the tier.
  dynamicLeverage: {
    enabled: true,
    liqBufferMult: 1.5,       // liquidation must be ≥ this × stop distance away
    tiers: [                  // first tier whose maxStopPct ≥ stopPct wins
      { maxStopPct: 3, maxLev: 20 },
      { maxStopPct: 4, maxLev: 15 },
      { maxStopPct: 6, maxLev: 10 },
      { maxStopPct: 100, maxLev: 7 },
    ],
  },
  maxConcurrentPositions: 10, // Framework B (accelerate sample): hold up to 10 at once.
                              // Worst-case grade-A %-risk margin = 5.0%/trade (notional
                              // ≤$5002 ÷ effLev 20x), so 10 = 50% worst-case — 30% under
                              // the 80% hard cap. Practical ceiling is ~5 (allowlist size
                              // + no-averaging), so this is generous, margin-safe headroom.
  // Framework B HARD CAP: worst-case total initial margin must stay ≤ this % of
  // the equity base before ANY new order opens. B raises concurrency/trades-per-
  // day to collect samples faster, so unconstrained worst-case margin could climb;
  // this backstop guarantees the book can never touch 80%+ (16 grade-A trades = 80%).
  // Enforced on manual `order` + `autotrade` + auto-signal, fail-closed.
  marginCapPct: 80,
  allowedSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"],
  timeoutMs: 10000,
  // Auto-trade (Phase 7): off by default. When on, the monitoring loop can
  // place orders that pass tradeGuard + autoTradeRules, without a human
  // confirming each one. Still testnet-only + capped + audited.
  autoTrade: false,
  autoTradeRules: {
    maxTradesPerDay: 300,     // Framework B (accelerate sample ~100x) — was 3. Non-binding
                              // headroom: real rate is gated by the daily-loss circuit-
                              // breaker + the 80% margin cap, not this counter.
    requireSetupGrade: "B",   // A or B only
    mandatoryStop: true,
    noAveragingDown: true,
  },
  // Monitoring loop: poll positions + watchlist prices on this interval (ms).
  // 0 = off. Drives trade.fill / trade.alert broadcasts + Telegram relay.
  monitorMs: 60000,
  // Opt-in Copilot gate (Phase 5): when true, autotrade also requires the
  // sibling Copilot decision ≠ NO_GO (read via copilot-link plugin over HTTP).
  // Default false because Copilot may be stale/not installed — agents are
  // already taught to check it in their skills; this is a belt-and-suspenders
  // code-level gate for when you want the plugin itself to enforce it.
  requireCopilotApproval: false,
  // Scalping mode (Ultra-safe survival): tighter risk + loss-streak cooldown +
  // fee-aware sizing + news event gate. When scalping:true the autoTradeGuard
  // applies scalpingRules on top of the base rules (never replaces them).
  scalping: false,
  scalpingRules: {
    riskPct: 0.5,            // % equity risked per scalp trade (vs 2% swing)
    dailyLossPct: 3,         // daily loss circuit-breaker (vs 6% swing)
    cooldownAfterLosses: 3,  // consecutive losses that trigger a cooldown
    cooldownMin: 30,         // cooldown length in minutes
    cooldownWindowMin: 60,   // only count losses within this lookback window
    feePct: 0.04,            // taker fee % per side (Binance futures default)
    feeAware: true,          // include round-trip fee in the R:R / sizing check
    minRrAfterFees: 1.5,     // reject setups whose net R:R (after fees) < this
  },
  // News event gate: block auto-trades around high-impact scheduled news so
  // the desk isn't holding a scalp through a CPI/FOMC spike. Pulse feeds the
  // event cache (workspace/news-cache.json); the plugin reads it here.
  newsGate: {
    enabled: false,
    blockBeforeMin: 5,       // no new auto-trades within N min before an event
    blockAfterMin: 5,        // ...and for N min after, while volatility settles
    highImpactOnly: true,    // only block on high-impact events (CPI/FOMC/NFP)
  },
  // Scanner loop: sweep the watchlist + compute TA in code on this interval.
  // 0 = off. Default 30s — tight enough for scalp signals, gentle on rate limits.
  scanIntervalMs: 30000,
  // Position manager (auto-exit). When a position is tracked in positions.json,
  // the monitor loop checks these on each tick (15s):
  posManage: {
    trailPct: 0.5,           // trail the best price by this %; 0 = off
    timeStopMin: 15,         // auto-close a scalp that goes nowhere after N min; 0 = off
  },
  // CLOSED-LOOP auto-trade: when the scanner finds an A/B-graded signal AND
  // autoTradeSignal is true, the scanner places an autotrade DIRECTLY (still
  // through the full autoTradeGuard — every safety gate still applies). This
  // closes the loop: scan → (gate) → entry → (monitor) → auto-exit.
  // Off by default — requires autoTrade:true too. The pair is the explicit
  // "I want fully autonomous scalping" switch.
  autoTradeSignal: false,
  autoTradeSignalRules: {
    minGrade: "B",          // only auto-trade A or B signals (not C)
    onePositionAtATime: true, // skip new signals while a position is already open
  },
  // REGIME GATE (wires the regime-radar plugin into auto-arm). A breakout/trend
  // auto-signal may ARM only when the market regime CONFIRMS its direction:
  //   LONG (bull) signal  -> requires regime "Trend-Up"
  //   SHORT (bear) signal -> requires regime "Trend-Down"
  //   Range / High-Vol    -> SKIP (breakouts fakeout in range; matches the desk's
  //                          suitability map: Range => avoid chasing breakouts).
  // Regime is pulled from the sibling regime-radar plugin (one deterministic
  // engine, backtestable), NOT recomputed here. FAIL-CLOSED: if the regime can't
  // be read, the signal is skipped (can't confirm the trend => don't arm). Every
  // reject is logged (audit: auto-signal-blocked, reason "regimeGate: ...").
  // mode "aligned" (default) = directional match above. mode "longOnly" = strict
  // reading of "arm only in Trend-Up": only Trend-Up longs arm, everything else
  // (incl. Trend-Down shorts) is skipped. Set enabled:false to disable the gate.
  regimeGate: {
    enabled: true,
    mode: "aligned",        // "aligned" | "longOnly"
    tf: "1h",               // timeframe for the regime label (regime-radar primary TF)
  },
  // Trend-following mode (ACTIVE — replaces scalping). Bigger TF, wait for
  // A-Setup, let winners run, partial TP, hold overnight. Risk/trade is small
  // but R is large. "Trade less. Trade better. Cut losers. Let winners run."
  entryTf: "15m",            // entry timeframe
  contextTf: "1h",           // higher-TF trend filter (must align with entry)
  simulatedEquity: 5002,     // real tradable USDT base ($5002). % risk/notional/loss size off this
  trendRules: {
    riskPct: 0.5,            // default risk/trade = 0.5% = ~$25 from $5002 base
    riskPctMax: 1,           // ceiling for a normal (grade B/C) setup
    riskPctMaxGradeA: 2,     // higher ceiling reserved for grade-A setups only
    atrStopMult: 2,          // stop = 2×ATR (wider than scalp 1.5)
    fixedTargetR: 0,         // 0 = no fixed target, let winners run; >0 = TP at that R
    partialTpR: 2,           // take partial profit at +2R
    partialTpPct: 50,        // close this % of the position on partial TP
    breakevenTriggerR: 1,    // move SL → breakeven when +1R
    trailActivateR: 2,       // start trailing after +2R (after partial taken)
    trailPct: 1.5,           // trail % from peak (wider than scalp 0.5)
    minRr: 2,                // minimum R:R to accept a setup
  },
  dailyLossPct: 2,           // 2% daily loss circuit-breaker = ~$100 from $5002 base
  cooldownAfterLosses: 2,    // 2 consecutive losses → cooldown (was 3 for scalp)
  cooldownMin: 60,           // cooldown length in minutes (was 30)
  // Kill-switch for the read-only dashboard bridge. When tradePaused is true,
  // BOTH tradeGuard (manual orders) and autoTradeGuard (autotrade + scanner
  // auto-signal) refuse to open new positions — the desk goes view-only. This
  // is the single mutation the Office snapshot endpoint exposes to the Copilot
  // dashboard. officePauseToken gates that mutation: empty = pause endpoint
  // refuses all requests (fail-closed). Set both in the panel.
  tradePaused: false,
  officePauseToken: "",     // shared secret; ≥24 chars recommended
};

// ---- Pure TA helpers (zero-dependency, deterministic) ----
// Exponential Moving Average over a series of numbers. Returns the full EMA
// series so callers can detect crossovers. period >= 1.
function emaSeries(values, period) {
  if (!values || !values.length || period < 1) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
// Last EMA value of a series (convenience).
const ema = (values, period) => { const s = emaSeries(values, period); return s.length ? s[s.length - 1] : null; };
// Average True Range over the last `period` candles (default 14). Each candle
// is {high, low, close}. Used for stop sizing on scalps.
function atr(candles, period = 14) {
  if (!candles || candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((s, x) => s + x, 0) / slice.length;
}
// Recent swing high/low over the last `lookback` candles — for S/R levels.
function swingHigh(candles, lookback = 20) {
  const slice = (candles || []).slice(-lookback);
  return slice.length ? Math.max(...slice.map((c) => c.high)) : null;
}
function swingLow(candles, lookback = 20) {
  const slice = (candles || []).slice(-lookback);
  return slice.length ? Math.min(...slice.map((c) => c.low)) : null;
}
// Average volume over the last `lookback` candles — for spike detection.
const avgVol = (candles, lookback = 10) => {
  const slice = (candles || []).slice(-lookback - 1, -1);
  return slice.length ? slice.reduce((s, c) => s + c.volume, 0) / slice.length : 0;
};

// ---- Market Structure detection (HH/HL/LH/LL + pullback) ----
// These replace EMA-cross as the primary trend engine. Trend-following
// philosophy: classify structure → wait for pullback → enter with structure
// stop → let the winner run. "ขึ้น→Long, ลง→Short, ไม่ชัด→ไม่ทำอะไร".

// Williams fractal pivots: a bar whose high is the max of n bars each side
// (fractal high), or whose low is the min (fractal low). n=2 → 5-bar fractal.
// Returns { highs:[{i,price}], lows:[{i,price}] } in chronological order.
function fractals(candles, n = 2) {
  const highs = [], lows = [];
  const c = candles || [];
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

// Classify the last 2 swing highs + last 2 swing lows into a trend.
// HH + HL = up (Long only) · LH + LL = down (Short only) · mixed/unclear = range.
function classifyStructure(fr) {
  const { highs, lows } = fr;
  if (highs.length < 2 || lows.length < 2)
    return { trend: "range", lastHigh: null, prevHigh: null, lastLow: null, prevLow: null };
  const h2 = highs.slice(-2), l2 = lows.slice(-2);
  const hh = h2[1].price > h2[0].price, lh = h2[1].price < h2[0].price;
  const hl = l2[1].price > l2[0].price, ll = l2[1].price < l2[0].price;
  let trend = "range";
  if (hh && hl) trend = "up";
  else if (lh && ll) trend = "down";
  return { trend, lastHigh: h2[1], prevHigh: h2[0], lastLow: l2[1], prevLow: l2[0] };
}

// Pullback readiness: did price retrace toward the last opposite swing, hold
// the structure (didn't break HL/LH), and start turning back in trend direction?
// This is the "don't chase, wait for pullback" gate. Returns {ready, pullbackFrac,
// holding, turning, swingLevel}. pullbackFrac: 0 = at extreme (no pullback), 1 = at swing.
function pullbackReady(candles, struct) {
  if (struct.trend === "range" || !struct.lastHigh || !struct.lastLow)
    return { ready: false, pullbackFrac: 0, holding: false, turning: false, swingLevel: null };
  const isUp = struct.trend === "up";
  const swing = isUp ? struct.lastLow.price : struct.lastHigh.price;      // HL (long) / LH (short)
  const oppSwing = isUp ? struct.lastHigh.price : struct.lastLow.price;    // HH (long) / LL (short)
  const range = Math.abs(oppSwing - swing);
  if (range <= 0) return { ready: false, pullbackFrac: 0, holding: false, turning: false, swingLevel: swing };
  const c = candles || [];
  if (c.length < 3) return { ready: false, pullbackFrac: 0, holding: false, turning: false, swingLevel: swing };
  const last = c[c.length - 1], prev = c[c.length - 2];
  const recent = c.slice(-3);
  const recentExtreme = isUp ? Math.min(...recent.map((x) => x.low)) : Math.max(...recent.map((x) => x.high));
  const pullbackFrac = isUp ? (oppSwing - recentExtreme) / range : (recentExtreme - oppSwing) / range;
  const holding = isUp ? recentExtreme > swing : recentExtreme < swing;
  const turning = isUp ? last.close > prev.close : last.close < prev.close;
  const ready = pullbackFrac > 0.3 && holding && turning;
  return { ready, pullbackFrac, holding, turning, swingLevel: swing };
}
// Analyze one symbol: pull entry-TF + context-TF klines, compute the signal set,
// and return a scored candidate (or null if no edge). entryTf/ctxTf default to a
// trend-following profile (15m entry + 1h context); scalping callers pass "3m"/"15m".
// opts { stopMult, fixedTargetR } parameterize the stop/target math (was hardcoded 1.5 ATR / 1.8 R).
async function analyzeSymbol(symbol, req, entryTf = "15m", ctxTf = "1h", opts = {}) {
  const stopMult = opts.stopMult || 1.5;
  const fixedTargetR = typeof opts.fixedTargetR === "number" ? opts.fixedTargetR : 1.8;
  const [k3, k15] = await Promise.all([
    req("GET", "/fapi/v1/klines", { symbol, interval: entryTf, limit: "60" }),
    req("GET", "/fapi/v1/klines", { symbol, interval: ctxTf, limit: "40" }),
  ]);
  if (!k3.ok || !k15.ok || !Array.isArray(k3.json) || k3.json.length < 25) return null;
  const c3 = k3.json.map((k) => ({ t: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
  const c15 = k15.json.map((k) => ({ close: Number(k[4]), high: Number(k[2]), low: Number(k[3]) }));
  const closes3 = c3.map((c) => c.close);

  // ---- Market Structure: the primary trend engine (replaces EMA-cross) ----
  // 1. Fractals + structure on entry-TF (HH/HL = up, LH/LL = down, mixed = range).
  const entryStruct = classifyStructure(fractals(c3, 2));
  // 2. Same on context-TF — the higher TF must agree for a high-conviction entry.
  const ctxStruct = classifyStructure(fractals(c15, 2));
  // 3. dir comes from structure: up→bull, down→bear, range→flat (no trade).
  const dir = entryStruct.trend === "up" ? "bull" : entryStruct.trend === "down" ? "bear" : "flat";
  // 4. alignment: entry structure == context structure (both up or both down).
  const aligned = entryStruct.trend !== "range" && entryStruct.trend === ctxStruct.trend;
  // 5. pullback gate — "don't chase, wait for a pullback that holds structure".
  const pb = pullbackReady(c3, entryStruct);

  // ---- Secondary confirmations (cheap, add confluence — no longer primary) ----
  const a = atr(c3, 14);
  const emaTrend = ema(closes3, 9) > ema(closes3, 21) ? "bull" : "bear";   // EMA agrees with structure?
  const volSpike = c3[c3.length - 1].volume > avgVol(c3, 10) * 1.5;

  // ---- Confluence scoring ----
  const signals = [];
  if (entryStruct.trend === "up") signals.push("HH-HL");
  else if (entryStruct.trend === "down") signals.push("LH-LL");
  if (aligned) signals.push("ctx-aligned");
  if (pb.ready) signals.push("pullback");
  if (pb.turning) signals.push("turn-up");
  if (emaTrend === dir && dir !== "flat") signals.push("ema-confirm");
  if (volSpike) signals.push("volume");
  const score = signals.length;
  // Grade: A = aligned + pullback ready + rich confluence; B = aligned + clear structure
  // (with or without pullback); C = range/no-alignment → wait (NO SETUP = NO TRADE).
  let grade = "C";
  if (aligned && pb.ready && score >= 4) grade = "A";
  else if (aligned && score >= 3) grade = "B";

  // ---- Structure-based entry/stop (replaces ATR-only stop) ----
  // Stop = thesis-wrong point: below the last HL (long) / above the last LH (short),
  // plus a small ATR buffer so noise doesn't stop us out. This is structure-driven,
  // not a fixed ATR multiple — it sits where the trend would be invalidated.
  const price = closes3[closes3.length - 1];
  let entry = null, stop = null, target = null;
  if (grade !== "C") {
    entry = price;
    const buf = a * 0.3;   // 30% ATR buffer beyond the structure level
    if (dir === "bull" && entryStruct.lastLow) stop = entryStruct.lastLow.price - buf;
    else if (dir === "bear" && entryStruct.lastHigh) stop = entryStruct.lastHigh.price + buf;
    else stop = dir === "bull" ? price - a * stopMult : price + a * stopMult;   // ATR fallback
    if (fixedTargetR > 0) {
      const risk = Math.abs(entry - stop);
      target = dir === "bull" ? entry + risk * fixedTargetR : entry - risk * fixedTargetR;
    }
    // target stays null when fixedTargetR === 0 → manager trails the runner
  }
  return {
    symbol, price, dir, trend3m: entryStruct.trend, trend15m: ctxStruct.trend, aligned, score, signals, grade,
    entry, stop, target, atr: Math.round(a * 100) / 100,
    structure: entryStruct.trend,            // NEW: "up"|"down"|"range"
    pullback: pb.ready,                       // NEW: bool — pullback entry confirmed
    pullbackFrac: Math.round((pb.pullbackFrac || 0) * 100) / 100,
    swingHigh: swingHigh(c3, 20), swingLow: swingLow(c3, 20), volSpike,
  };
}

/* ------------------------------------------------------------------------
 * SAFETY DECIDERS — pure, module scope, exported for tests.
 *
 * These hold the decisions that decide whether real money moves. They live
 * out here (rather than inside the factory) for one reason: a 2400-line file
 * that talks to an exchange on every path had zero test coverage, and the only
 * way to test a decision is to be able to call it without a network.
 *
 * House rule for every one of them: when the input needed to make the decision
 * is MISSING, the answer is the safe one, not the convenient one. An exchange
 * outage must tighten the risk envelope, never loosen it.
 * ---------------------------------------------------------------------- */

/** Event times arrive as ISO strings from the news cache and as epoch ms from
 *  some feeds. The old code did `ev.at - now` on a string, got NaN, and every
 *  comparison after it was false — so a gate marked `enabled: true` never once
 *  blocked a trade. Returns epoch ms, or null when it genuinely cannot tell. */
function parseEventAt(ev) {
  const v = ev && ev.at;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** Returns null to allow, or a human reason string to BLOCK.
 *  Fails closed three ways: unparseable event time, unreadable cache, stale
 *  cache. A cached `minutesUntil` is deliberately ignored — it was computed at
 *  fetch time and reusing it just tells the same lie more slowly. */
/** Is this a SCHEDULED event, or a rolling commentary note?
 *
 *  The news cache mixes two things. Calendar releases (FOMC, CPI, NFP) carry
 *  their own fixed timestamp. Running commentary ("no new escalation details
 *  this scan… still no single fixed timestamp") has no time at all, so the
 *  writer stamps it with the scan time — which means it sits inside the ±5 min
 *  block window on EVERY scan, forever.
 *
 *  The discriminator is exact rather than heuristic: a note stamped "now" has
 *  `at` equal to the cache's own `updated` field, to the second. A real event's
 *  timestamp is its own and never coincides with a later write. */
function isScheduledEvent(ev, cacheUpdatedMs, epsilonMs = 2000) {
  const at = parseEventAt(ev);
  if (at == null) return false;
  if (!Number.isFinite(cacheUpdatedMs)) return true;   // cannot tell ⇒ treat as scheduled (blocks)
  return Math.abs(at - cacheUpdatedMs) > epsilonMs;
}

function newsGateDecide({ events, nowMs, gate, cacheOk, cacheMtimeMs, cacheUpdatedMs }) {
  if (!gate || !gate.enabled) return null;
  if (!cacheOk) return "news gate: อ่าน news-cache ไม่ได้ — ประเมินข่าวไม่ได้ (fail-closed)";
  const maxAgeH = gate.maxCacheAgeH == null ? 24 : gate.maxCacheAgeH;
  if (maxAgeH > 0 && Number.isFinite(cacheMtimeMs) && nowMs - cacheMtimeMs > maxAgeH * 3600000)
    return `news gate: news-cache เก่ากว่า ${maxAgeH} ชม. — ประเมินข่าวไม่ได้ (fail-closed)`;
  for (const ev of events || []) {
    if (gate.highImpactOnly && ev.impact !== "high") continue;
    const at = parseEventAt(ev);
    if (at == null)
      return `news gate: อ่านเวลาข่าว "${(ev && ev.title) || "?"}" ไม่ได้ — fail-closed`;
    // Commentary stamped "now" is context, not a scheduled release. Blocking on
    // it would pause the desk permanently while a running story is in the cache.
    if (!isScheduledEvent(ev, cacheUpdatedMs)) continue;
    const mins = Math.round((at - nowMs) / 60000);
    if (mins >= -(gate.blockAfterMin || 0) && mins <= (gate.blockBeforeMin || 0)) {
      const when = mins >= 0 ? `อีก ${mins} นาที (ก่อนข่าว)` : `${-mins} นาทีที่แล้ว (หลังข่าว)`;
      return `news gate: ${(ev && ev.title) || "ข่าวใหญ่"} ${when} — รอให้ความผันผวนเคลียร์`;
    }
  }
  return null;
}

// Entries that are part of the money trail. Everything else (blocked signals,
// dry runs, monitor errors) is noise and gets its own quota so it can never
// crowd real fills out of the ring.
const AUDIT_MONEY_CMDS = new Set([
  "order", "autotrade", "autotrade-stop", "auto-signal", "auto-signal-shadow",
  "exit", "exit-failed", "emergency-close", "close", "stoploss", "pause", "leverage-auto",
]);

function auditTrim(log, { maxMoney = 400, maxOther = 100 } = {}) {
  const money = [], other = [];
  for (const e of Array.isArray(log) ? log : [])
    (AUDIT_MONEY_CMDS.has(e && e.cmd) ? money : other).push(e);
  return money.slice(-maxMoney).concat(other.slice(-maxOther))
    .sort((a, b) => ((a && a.ts) || 0) - ((b && b.ts) || 0));
}

/** Today's executed entries, plus whether that count can be TRUSTED.
 *  The audit log is a ring buffer, so once it has been trimmed past midnight
 *  the count is only a lower bound — and a lower bound is exactly what you
 *  must not compare against a daily cap. `complete:false` ⇒ the caller blocks. */
function tradesTodayDecide(log, nowMs) {
  if (!Array.isArray(log)) return { count: 0, complete: false };
  const d = new Date(nowMs); d.setHours(0, 0, 0, 0);
  const dayStart = d.getTime();
  let count = 0, oldest = Infinity;
  for (const e of log) {
    if (!e || !Number.isFinite(e.ts)) continue;
    if (e.ts < oldest) oldest = e.ts;
    if (e.ts < dayStart) continue;
    if ((e.cmd === "order" && e.ok) ||
        ((e.cmd === "autotrade" || e.cmd === "auto-signal") && e.orderOk)) count++;
  }
  // Nothing on file at all ⇒ nothing was trimmed ⇒ zero is the true count.
  const complete = log.length === 0 ? true : oldest <= dayStart;
  return { count, complete };
}

/** Per-key dedup with a TTL. The old dedup was a single module-scope string, so
 *  with two qualifying signals in one tick the key rotated and both re-fired on
 *  the next tick — the mechanism behind a logged open/emergency-close churn
 *  loop. Dedup can only ever SUPPRESS, so a bug here cannot cause an entry. */
function makeDedup({ ttlMs = 3600000, max = 200 } = {}) {
  const seen = new Map();
  return {
    fresh(key, nowMs) {
      const prev = seen.get(key);
      if (prev != null && nowMs - prev < ttlMs) return false;
      seen.set(key, nowMs);
      if (seen.size > max)
        for (const [k, v] of seen) if (nowMs - v >= ttlMs) seen.delete(k);
      return true;
    },
    size: () => seen.size,
  };
}

/** Did the emergency close actually flatten the position?
 *  `flat:true` requires POSITIVE proof. A rejected close, a failed verification
 *  read, or any remaining quantity all mean the same thing operationally:
 *  assume the position is still open and still naked. unknown ≡ naked. */
function emergencyOutcome({ closeOk, verifyOk, verifyAmt }) {
  if (!closeOk) return { flat: false, reason: "close-rejected" };
  if (!verifyOk) return { flat: false, reason: "verify-failed" };
  if (Math.abs(Number(verifyAmt) || 0) > 0) return { flat: false, reason: "still-open" };
  return { flat: true, reason: null };
}

/** What to do after firing an exit order.
 *  A rejected close must NOT drop tracking and must NOT write a journal row —
 *  the old code did both unconditionally, leaving a live position untracked and
 *  a ledger claiming a realised PnL that never happened. */
function exitOutcome({ orderOk, avgPrice, mark }) {
  if (!orderOk) return { shouldRemove: false, exitPrice: null, pnlSource: null };
  const avg = Number(avgPrice);
  if (Number.isFinite(avg) && avg > 0) return { shouldRemove: true, exitPrice: avg, pnlSource: "fill" };
  return { shouldRemove: true, exitPrice: mark, pnlSource: "estimated-from-mark" };
}

/* --------------------------------------------------------- OWNERSHIP -----
 * The desk shares an account with its owner. Nothing in /fapi/v2/positionRisk
 * says who opened a position, so ownership has to be MADE decidable: the desk
 * tags every order it sends, and a position is ours only if every order that
 * opened it carries our tag. Anything we cannot prove is ours is treated as
 * the owner's and is never touched — only reported.
 * ------------------------------------------------------------------------ */

/** `bd-<src>-<base36 ms>-<rand4>`, inside Binance's ^[.A-Za-z0-9_-]{1,36}$.
 *  src: as=auto-signal at=autotrade mo=manual order xt=trail/target exit
 *       xp=partial xm=manual close xe=emergency close xs=stop re-place */
function makeClientOrderId(src, nowMs, rnd) {
  const s = String(src || "xx").slice(0, 2).toLowerCase().replace(/[^a-z]/g, "x").padEnd(2, "x");
  const t = Math.max(0, Math.floor(Number(nowMs) || 0)).toString(36);
  const r = Math.floor((rnd == null ? Math.random() : rnd) * 1679616).toString(36).padStart(4, "0").slice(-4);
  return `bd-${s}-${t}-${r}`;
}
const isDeskTagged = (id) => /^bd-[a-z]{2}-/.test(String(id || ""));

/**
 * desk | foreign | unknown.
 *
 * `unknown` is treated EXACTLY like `foreign` by every caller — it differs only
 * in the wording of the alert. That is the fail-closed definition: not provably
 * ours ⇒ the owner's ⇒ never touched. Positions opened before tagging existed
 * all land here, which is why tagging must be deployed while the desk is flat.
 */
function classifyPosition({ positionAmt, tracked, orders, taggingSinceMs }) {
  if (tracked) return "desk";
  const target = Math.abs(Number(positionAmt) || 0);
  if (!(target > 0)) return "unknown";
  if (!Array.isArray(orders) || orders.length === 0) return "unknown";
  const openSide = Number(positionAmt) > 0 ? "BUY" : "SELL";
  const filled = orders
    .filter((o) => o && o.status === "FILLED" && o.side === openSide &&
                   !(o.reduceOnly === true || o.reduceOnly === "true"))
    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
  // Walk back from the newest fill until the position size is accounted for.
  const opening = [];
  let acc = 0;
  for (const o of filled) {
    opening.push(o);
    acc += Math.abs(Number(o.executedQty) || 0);
    if (acc >= target * 0.999) break;
  }
  if (!opening.length || acc < target * 0.999) return "unknown";
  if (opening.some((o) => !Number.isFinite(Number(o.time)) || Number(o.time) < Number(taggingSinceMs || Infinity)))
    return "unknown";
  return opening.every((o) => isDeskTagged(o.clientOrderId)) ? "desk" : "foreign";
}

/**
 * Three states, never a boolean — and that distinction IS the safety of this
 * check. `unverified` (the API call failed, or rows arrived in a shape we do
 * not recognise) must never be mistaken for `uncovered`, because only
 * `uncovered` is ever allowed to trigger an action.
 */
function stopCoverage({ positionAmt, algos }) {
  const amt = Number(positionAmt) || 0;
  if (amt === 0) return { covered: true, unverified: false, reason: "flat" };
  if (!Array.isArray(algos)) return { covered: false, unverified: true, reason: "algo-read-failed" };
  if (algos.some((a) => !a || typeof a.side !== "string"))
    return { covered: false, unverified: true, reason: "unrecognised-rows" };
  const need = amt > 0 ? "SELL" : "BUY";
  const hit = algos.find((a) => a.side === need &&
    (a.closePosition === true || a.closePosition === "true" ||
     Math.abs(Number(a.origQty) || 0) >= Math.abs(amt) * 0.999));
  return hit ? { covered: true, unverified: false, reason: null }
             : { covered: false, unverified: false, reason: "no-stop" };
}

/**
 * The reconciliation policy, as a pure function of what we observed.
 *
 * Two rules carry all the weight:
 *   1. A position that is not provably ours produces alerts and NOTHING else —
 *      no orders, ever. (Pinned by a test asserting `replace: []`.)
 *   2. When protection cannot be guaranteed the desk STOPS OPENING; it never
 *      starts closing. Auto-flattening on a false negative would close a
 *      healthy position, and if ownership were ever wrong it would close the
 *      owner's.
 */
function reconcileDecide({
  live, tracked, classes, coverage, state, nowMs,
  uncoveredTicksToAct = 2, unverifiedTicksToAlert = 4, maxReplaceAttempts = 3,
  replaceCooldownMs = 600000, alertCooldownMs = 3600000,
}) {
  const out = { adopt: [], alerts: [], replace: [], pause: null, state: {} };
  const trackedBySym = new Map((tracked || []).map((t) => [t.symbol, t]));
  for (const p of live || []) {
    const sym = p.symbol;
    const cls = (classes || {})[sym] || "unknown";
    const cov = (coverage || {})[sym] || { covered: false, unverified: true, reason: "missing" };
    const prev = (state || {})[sym] || {};
    const st = {
      firstSeen: prev.firstSeen || nowMs, class: cls,
      uncoveredTicks: 0, unverifiedTicks: 0,
      replaceAttempts: prev.replaceAttempts || 0,
      lastReplaceAt: prev.lastReplaceAt || 0, lastAlertAt: prev.lastAlertAt || 0,
    };
    const alert = (kind, extra) => {
      if (nowMs - st.lastAlertAt < alertCooldownMs) return;
      st.lastAlertAt = nowMs;
      out.alerts.push({ symbol: sym, kind, class: cls, ...extra });
    };

    if (cls === "desk" && !trackedBySym.has(sym))
      out.adopt.push({ symbol: sym, positionAmt: p.positionAmt, entryPrice: p.entryPrice });

    if (cov.unverified) st.unverifiedTicks = (prev.unverifiedTicks || 0) + 1;
    else if (!cov.covered) st.uncoveredTicks = (prev.uncoveredTicks || 0) + 1;

    if (st.unverifiedTicks >= unverifiedTicksToAlert) alert("coverage-unverified", { reason: cov.reason });

    if (st.uncoveredTicks > 0) {
      if (cls !== "desk") {
        alert("foreign-naked");                       // report only — never act
      } else {
        const t = trackedBySym.get(sym);
        const knownStop = t && t.stop != null;
        if (!knownStop) {
          out.pause = out.pause || `naked-no-known-stop:${sym}`;
          alert("desk-naked-no-stop");
        } else if (st.replaceAttempts >= maxReplaceAttempts) {
          out.pause = out.pause || `stop-replace-exhausted:${sym}`;
          alert("stop-replace-exhausted", { attempts: st.replaceAttempts });
        } else if (st.uncoveredTicks >= uncoveredTicksToAct &&
                   nowMs - st.lastReplaceAt >= replaceCooldownMs) {
          out.replace.push({
            symbol: sym, stop: t.stop,
            side: Number(p.positionAmt) > 0 ? "SELL" : "BUY",
            qty: Math.abs(Number(p.positionAmt) || 0),
          });
          st.replaceAttempts += 1;
          st.lastReplaceAt = nowMs;
        }
      }
    } else {
      st.replaceAttempts = 0;   // coverage restored — reset the budget
    }
    out.state[sym] = st;
  }
  return out;
}

module.exports = (ctx) => {
  // Live-loop registry. Hung on globalThis so it SURVIVES the require-cache
  // delete that /plugins/reload does — a module-scope counter would reset on
  // every reload and could never detect the leak it exists to detect.
  // Surfaced in the snapshot as health.loops; anything above 1 means a previous
  // instance was never disposed and two engines are racing the same account.
  const LOOPS = (globalThis.__bagideaBinanceLoops =
    globalThis.__bagideaBinanceLoops || { monitor: 0, scanner: 0 });

  // Set by dispose(). clearInterval alone is not enough: a tick is async, so
  // one already in flight survives disposal and would keep placing orders
  // alongside the fresh instance. A disposed instance may finish READING; it
  // must never WRITE. Every order POST inside a loop is gated on this.
  let disposed = false;

  // Liveness counters, surfaced in the snapshot for the out-of-process
  // heartbeat. A desk that is flat and a desk that is dead look identical from
  // a phone unless something publishes "the loop ticked and it was fine".
  const HEALTH = {
    lastOkTickAt: null, lastTickErrorAt: null, lastTickError: null,
    consecutiveTickErrors: 0, lastTickErrorAlertAt: 0, startedAt: Date.now(),
  };

  const cfgFile = path.join(ctx.dataDir, "config.json");
  try {
    fs.mkdirSync(ctx.dataDir, { recursive: true });
    if (!fs.existsSync(cfgFile))
      fs.writeFileSync(cfgFile, JSON.stringify({ ...DEFAULTS }, null, 2));
  } catch (e) { ctx.log("binance: config init failed: " + e.message); }

  // Read config with defaults merged (so new fields appear without a migration).
  const cfg = () => {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch {}
    return { ...DEFAULTS, ...c };
  };
  // Atomic: a crash mid-write used to be able to truncate the money trail, and
  // the same helper protects positions.json and config.json.
  //
  // The mode is carried across explicitly. tmp+rename creates the temp file
  // under the process umask, so a naive atomic write SILENTLY RELAXES the
  // permissions of whatever it replaces — and config.json holds the API key and
  // secret in cleartext at 0600. Defaults to 0600 for a file that does not
  // exist yet, because everything this helper writes is desk-private.
  const writeJsonAtomic = (file, data) => {
    let mode = 0o600;
    try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file → stay private */ }
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
    try { fs.chmodSync(tmp, mode); } catch { /* best effort on odd filesystems */ }
    fs.renameSync(tmp, file);
  };

  const saveCfg = (patch) => {
    const c = { ...cfg(), ...patch };
    // Atomic + mode-preserving: this file carries the API key/secret at 0600,
    // and a torn write here loses every cap at once.
    writeJsonAtomic(cfgFile, c);
    return c;
  };

  // --- Binance REST helpers -------------------------------------------------

  // One low-level request. Returns {ok, status, body, json}. `signed` adds
  // the HMAC-SHA256 signature + apiKey header required by private endpoints.
  function req(method, restPath, query, signed) {
    return new Promise((resolve) => {
      const c = cfg();
      const base = c.testnet ? URLS.testnet : URLS.mainnet;
      const u = new URL(base);
      let qs = query ? new URLSearchParams(query).toString() : "";
      // Binance rejects signed requests whose timestamp drifts > 1s. recvWindow
      // buys a little slack for clock skew.
      if (signed) {
        if (!c.apiKey || !c.apiSecret)
          return resolve({ ok: false, error: "missing API key/secret (set in panel)" });
        const ts = Date.now();
        const full = qs ? `${qs}&timestamp=${ts}&recvWindow=5000` : `timestamp=${ts}&recvWindow=5000`;
        const sig = crypto.createHmac("sha256", c.apiSecret).update(full).digest("hex");
        qs = `${full}&signature=${sig}`;
      }
      const pathQs = restPath + (qs ? "?" + qs : "");
      const r = https.request({
        method, hostname: u.hostname,
        path: pathQs, timeout: c.timeoutMs,
        headers: signed ? { "X-MBX-APIKEY": c.apiKey } : {},
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data, json });
        });
      });
      r.on("error", (e) => resolve({ ok: false, error: e.message }));
      r.on("timeout", () => { r.destroy(); resolve({ ok: false, error: "request timeout" }); });
      r.end();
    });
  }

  // --- Conditional (STOP/TP) protective orders — Algo Order API ------------------------------
  // Binance USDⓈ-M (incl. demo-fapi) REJECTS STOP_MARKET/TAKE_PROFIT_MARKET on the regular
  // /fapi/v1/order endpoint (-4120 "use the Algo Order API endpoints instead"). They live on
  // /fapi/v1/algoOrder with algoType=CONDITIONAL + triggerPrice, in the algoId namespace.
  // Verified on demo-fapi (crypto-copilot track, 2026-07-07).
  // triggerPrice is rounded to 2 decimals (correct for ETH/BTC/BNB; a desk trading cheaper
  // coins needs tickSize-aware rounding).
  async function placeStopAlgo(symbol, side, triggerPrice) {
    const r = await req("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL", symbol, side, type: "STOP_MARKET",
      triggerPrice: Number(triggerPrice).toFixed(2), closePosition: "true", workingType: "MARK_PRICE",
    }, true);
    const algoId = r.json && (r.json.algoId || r.json.algoID);
    return { ok: r.ok && !!algoId, algoId: algoId ? String(algoId) : null, status: r.status, resp: r.json || r.body };
  }
  async function listStopAlgos(symbol) {
    // Resting conditional orders — GET /fapi/v1/openAlgoOrders (verified live on demo-fapi;
    // /fapi/v1/algoOpenOrders is NOT a valid path on this host). Filter by symbol client-side.
    const r = await req("GET", "/fapi/v1/openAlgoOrders", {}, true);
    const arr = (r.ok && Array.isArray(r.json)) ? r.json : [];
    return symbol ? arr.filter((o) => String(o.symbol) === String(symbol)) : arr;
  }
  /** Same call, but reports FAILURE instead of flattening it to []. Coverage
   *  checking needs "could not read" and "read fine, nothing there" to be
   *  different answers — conflating them is how you close a protected position. */
  async function listStopAlgosChecked() {
    try {
      const r = await req("GET", "/fapi/v1/openAlgoOrders", {}, true);
      if (!r.ok || !Array.isArray(r.json)) return null;
      return r.json;
    } catch { return null; }
  }
  async function cancelStopAlgos(symbol, exceptId) {
    for (const o of await listStopAlgos(symbol)) {
      const id = o.algoId || o.algoID;
      if (id && String(id) !== String(exceptId || "")) await req("DELETE", "/fapi/v1/algoOrder", { algoId: String(id) }, true);
    }
  }

  // --- Exchange qty filters (stepSize/minQty/minNotional) --------------------------------
  // The fixed 3-decimal qty floor rejected coarse-precision symbols outright ("Precision is
  // over the maximum", 27 lost entries in the 07-15..17 audit) and zeroed high-price ones.
  // /fapi/v1/exchangeInfo ignores ?symbol= (returns all ~700 symbols, ~0.9MB) so fetch once,
  // cache 12h in memory. Fetch failure -> null -> callers fall back to the legacy floor so an
  // exchangeInfo hiccup never halts the desk.
  let exFilters = { at: 0, map: null };
  async function symbolFilters(symbol) {
    if (!exFilters.map || Date.now() - exFilters.at > 12 * 3600e3) {
      const r = await req("GET", "/fapi/v1/exchangeInfo", null, false);
      if (r.ok && r.json && Array.isArray(r.json.symbols)) {
        const map = {};
        for (const s of r.json.symbols) {
          const f = (t) => (s.filters || []).find((x) => x.filterType === t) || {};
          const lot = f("LOT_SIZE"), mkt = f("MARKET_LOT_SIZE");
          map[s.symbol] = {
            // MARKET entries obey MARKET_LOT_SIZE; take the stricter of both to be safe.
            stepSize: Number(mkt.stepSize || lot.stepSize) || 0,
            minQty: Math.max(Number(mkt.minQty) || 0, Number(lot.minQty) || 0),
            minNotional: Number(f("MIN_NOTIONAL").notional) || 0,
          };
        }
        exFilters = { at: Date.now(), map };
      } else if (!exFilters.map) return null; // never fetched -> legacy behaviour
    }
    return exFilters.map[symbol] || null;
  }
  // Floor qty to the symbol's stepSize. Decimals derived from the stepSize string keep the
  // result exact ("0.001" -> 3 dp, "1" -> whole units) — no float artifacts in the API qty.
  function quantizeQty(qty, stepSize) {
    if (!(stepSize > 0)) return Math.floor(qty * 1e3) / 1e3; // legacy coarse floor
    const dec = (String(stepSize).split(".")[1] || "").length;
    return Number((Math.floor(qty / stepSize + 1e-9) * stepSize).toFixed(dec));
  }

  // Shared %-risk position sizer — the SINGLE sizing equation used by every path
  // that opens size (auto-signal, autotrade, and manual `order` with a stop):
  //   qty = (equity × riskPct%) / stopDistance
  // then trimmed to the notional backstop (equity × maxNotionalPct%) and floored
  // to the symbol's real stepSize, with minQty / minNotional gates enforced.
  // Sizing base = simulatedEquity (locked real capital $5002), NOT the testnet
  // balance, so numbers match what we'd size on mainnet. riskCeil (optional)
  // clamps riskPct — the auto path passes a per-grade ceiling (2% grade-A, 1%
  // otherwise); manual passes the plain trend ceiling. Returns
  // { qty, riskPct, riskUsd, stopDist, notional, notionalCap, capped, equity }
  // or { blocked } with a precise reason.
  async function sizeByRisk({ symbol, entry, stop, riskPct, riskCeil }) {
    const c = cfg();
    const equity = c.simulatedEquity || await accountEquity();
    const tr = c.trendRules || {};
    let rp = riskPct != null ? riskPct : (tr.riskPct || 0.5);
    const ceil = riskCeil != null ? riskCeil : (tr.riskPctMax || 1);
    if (rp > ceil) rp = ceil;
    const riskUsd = equity * rp / 100;
    const stopDist = Math.abs(Number(entry) - Number(stop));
    if (!(stopDist > 0)) return { blocked: "stop distance ศูนย์ — ขนาดไม่ได้ (entry เท่ากับ stop?)" };
    let qty = riskUsd / stopDist;
    // Notional backstop = equity × maxNotionalPct%. Risk sizing can exceed it when
    // the stop is tighter than ~0.5% (e.g. $25 risk / $0.10 stop); the cap is a
    // HARD ceiling — shrink qty so qty×entry <= cap. A normal 0.5% stop sizes to
    // exactly ~equity notional = the cap, so it passes (strict `>`) untrimmed.
    const notionalCap = equity * (c.maxNotionalPct || 100) / 100;
    const maxQtyByCap = notionalCap / entry;
    let capped = false;
    if (qty > maxQtyByCap) { qty = maxQtyByCap; capped = true; }
    // Floor to the symbol's real stepSize (exchangeInfo, cached).
    const flt = await symbolFilters(symbol);
    const q = quantizeQty(qty, flt ? flt.stepSize : 0);
    if (q <= 0 || (flt && q < flt.minQty))
      return { blocked: `qty ต่ำเกินไป (${qty}${flt ? `, ขั้นต่ำ exchange ${flt.minQty}` : ""}) — equity $${equity.toFixed(2)} risk ${rp}% notionalCap $${notionalCap.toFixed(0)}` };
    if (flt && flt.minNotional > 0 && q * entry < flt.minNotional)
      return { blocked: `notional $${(q * entry).toFixed(2)} ต่ำกว่าขั้นต่ำ exchange $${flt.minNotional} (${symbol})` };
    return { qty: q, riskPct: rp, riskUsd, stopDist, notional: q * entry, notionalCap, capped, equity };
  }

  // --- Dynamic leverage guardrail (Option B) --------------------------------
  // Pure computation: given entry+stop, return the effective leverage after the
  // stop-width tier squeeze + the ≥liqBufferMult× liquidation-buffer check.
  // { effLev, tierLev, ceiling, stopPct, liqPct, liqNeededPct, reject, reason,
  //   skipped }. skipped=true when there's no usable stop (can't gate). requested
  // (optional) is the leverage the caller wants; default = ceiling (auto paths
  // pass none → they always run at the tier max, never above it).
  function leverageForStop(stopPct, tiers) {
    for (const t of tiers) if (stopPct <= t.maxStopPct) return t.maxLev;
    return tiers.length ? tiers[tiers.length - 1].maxLev : 0;
  }
  function leverageGuard({ entry, stop, requestedLev }) {
    const c = cfg();
    const dl = c.dynamicLeverage || {};
    const ceiling = c.maxLeverage || 20;
    const e = Number(entry), s = Number(stop);
    if (!(e > 0) || !(s > 0) || !(Math.abs(e - s) > 0))
      return { skipped: true, reject: false, effLev: null };     // no stop → can't gate
    const stopPct = Math.abs(e - s) / e * 100;
    if (dl.enabled === false)
      return { skipped: true, reject: false, stopPct, effLev: null };
    const tiers = Array.isArray(dl.tiers) && dl.tiers.length ? dl.tiers
      : [{ maxStopPct: 3, maxLev: 20 }, { maxStopPct: 4, maxLev: 15 }, { maxStopPct: 6, maxLev: 10 }, { maxStopPct: 100, maxLev: 7 }];
    const tierLev = Math.min(leverageForStop(stopPct, tiers), ceiling);
    const req = requestedLev != null ? Number(requestedLev) : ceiling;
    const effLev = Math.max(1, Math.min(req, tierLev, ceiling));
    const buf = dl.liqBufferMult || 1.5;
    const liqPct = 100 / effLev;               // liquidation distance ≈ 1/lev (initial-margin model)
    const liqNeededPct = buf * stopPct;
    const reject = liqPct < liqNeededPct;      // even the tier floor can't clear the buffer
    const r2 = (x) => Math.round(x * 100) / 100;
    return {
      skipped: false, reject, effLev, tierLev, ceiling, buf,
      stopPct: r2(stopPct), liqPct: r2(liqPct), liqNeededPct: r2(liqNeededPct),
      reason: reject
        ? `leverage guardrail: stop กว้าง ${stopPct.toFixed(2)}% — แม้ที่ ${effLev}x liquidation (~${liqPct.toFixed(1)}%) ยังไม่ห่าง ≥${buf}× stop (${liqNeededPct.toFixed(1)}%) → reject`
        : null,
    };
  }
  // Live variant: run the guard, and if it passes (and a stop exists) SET the
  // symbol's leverage on the exchange to the gated value BEFORE the position
  // opens. Returns { ok, ...guard, applied }. ok=false → the caller must block
  // (either the guard rejected, or we couldn't guarantee the gated leverage).
  async function applyLeverageGuard(symbol, entry, stop, requestedLev) {
    const g = leverageGuard({ entry, stop, requestedLev });
    if (g.skipped) return { ok: true, ...g };
    if (g.reject) return { ok: false, ...g };
    const r = await req("POST", "/fapi/v1/leverage", { symbol, leverage: String(g.effLev) }, true);
    audit({ cmd: "leverage-auto", symbol, effLev: g.effLev, tierLev: g.tierLev, stopPct: g.stopPct, ok: r.ok, status: r.status, resp: r.json || r.body });
    if (!r.ok)
      return { ok: false, ...g, applied: false, reason: `ตั้ง effective leverage ${g.effLev}x (${symbol}) ไม่สำเร็จ — ยกเลิกไม้ ไม่เปิดที่ leverage เกิน guardrail (${(r.json && r.json.msg) || r.body})` };
    return { ok: true, ...g, applied: true };
  }

  // --- Portfolio margin hard cap (Framework B) ------------------------------
  // Framework B accelerates sample collection (more concurrent positions / more
  // trades per day), so unconstrained worst-case total margin could approach
  // 100% of equity. This HARD CAP blocks any new order whose margin would push
  // total initial margin over marginCapPct% of the equity base — the book can
  // never touch 100%. Pure decision below (all inputs explicit, unit-testable);
  // marginGuard() is the live wrapper that reads real exchange margin.
  //   { ok, existingMargin, newMargin, projected, projectedPct, capUsd, capPct, reason }
  function marginDecision({ existingMargin, newMargin, equity, capPct }) {
    const cap = Number(capPct) || 0;
    const eq = Number(equity) || 0;
    const capUsd = eq * cap / 100;
    const existing = Math.max(0, Number(existingMargin) || 0);
    const add = Math.max(0, Number(newMargin) || 0);
    const projected = existing + add;
    const projectedPct = eq > 0 ? projected / eq * 100 : 0;
    const r2 = (x) => Math.round(x * 100) / 100;
    const ok = !cap || projected <= capUsd + 1e-9;
    return {
      ok, capPct: cap, capUsd: r2(capUsd),
      existingMargin: r2(existing), newMargin: r2(add),
      projected: r2(projected), projectedPct: r2(projectedPct),
      reason: ok ? null
        : `total-margin guard: ไม้นี้จะดันมาร์จินรวมเป็น $${r2(projected)} (${r2(projectedPct)}% ของ equity $${r2(eq)}) — เกินเพดาน ${cap}% ($${r2(capUsd)}). ปิดไม้เก่าก่อน หรือลด size`,
    };
  }
  // Live wrapper: read current total initial margin from the exchange (open
  // positions + resting orders), add this order's margin (notional / effective
  // leverage), then apply the cap. Fail-CLOSED: if the account read fails we
  // BLOCK rather than risk an over-margined book. effLev falls back to the desk
  // default (low lev → higher margin estimate → conservative).
  async function marginGuard({ notional, effLev }) {
    const c = cfg();
    const capPct = c.marginCapPct != null ? c.marginCapPct : 80;
    if (!capPct) return { ok: true, capPct: 0, skipped: true, reason: null };
    const equity = c.simulatedEquity || await accountEquity();
    const lev = Math.max(1, Number(effLev) || c.leverageDefault || 3);
    const newMargin = (Number(notional) || 0) / lev;
    const acct = await req("GET", "/fapi/v2/account", null, true);
    if (!acct.ok || !acct.json) {
      return { ok: false, capPct, reason: "อ่านมาร์จินบัญชีไม่ได้ — บล็อกไม้ไว้ก่อน (fail-closed) กันมาร์จินรวมเกินเพดาน" };
    }
    const existingMargin = Number(acct.json.totalInitialMargin || 0);
    return marginDecision({ existingMargin, newMargin, equity, capPct });
  }

  // Pretty-print a single balance row from /fapi/v2/balance.
  const fmtBal = (b) => ({
    asset: b.asset,
    balance: Number(b.balance),
    available: Number(b.availableBalance),
    pnl: Number(b.crossUnPnl || 0),
  });
  // Pretty-print a position row from /fapi/v2/positionRisk.
  const fmtPos = (p) => ({
    symbol: p.symbol,
    side: Number(p.positionAmt) > 0 ? "LONG" : Number(p.positionAmt) < 0 ? "SHORT" : "FLAT",
    size: Math.abs(Number(p.positionAmt)),
    entry: Number(p.entryPrice),
    mark: Number(p.markPrice),
    pnl: Number(p.unRealizedProfit),
    leverage: Number(p.leverage),
  });

  // Parse a manual order line into a clean object. Two sizing modes:
  //   explicit qty:  order BTCUSDT BUY 0.001            (MARKET)
  //                  order BTCUSDT BUY 0.001 @60000     (LIMIT @60000)
  //   %-risk sizing: order BTCUSDT BUY risk 59700       (MARKET, stop 59700 → qty auto)
  //                  order BTCUSDT BUY risk 59700 @60000(LIMIT @60000, stop 59700)
  //                  order BTCUSDT BUY risk=0.5 59700   (override risk% for this order)
  // In %-risk mode qty = equity×riskPct/stopDist (shared sizeByRisk). The stop is
  // the first bare number after the `risk` keyword; @price = entry (default: mark).
  // Tolerates JSON too: {"symbol":"BTCUSDT","side":"buy","qty":0.001,"price":60000}
  // or {"symbol":"BTCUSDT","side":"buy","risk":true,"stop":59700,"riskPct":0.5}.
  // Returns { symbol, side, mode:'explicit'|'risk', qty, price, stop, riskPct }.
  function parseOrderArgs(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    if (s.startsWith("{")) {
      try {
        const o = JSON.parse(s);
        if (!o.symbol || !o.side) return null;
        const base = { symbol: String(o.symbol).toUpperCase(), side: String(o.side).toUpperCase(),
          price: o.price != null ? Number(o.price) : null, dry: !!o.dry };
        if (o.risk || o.mode === "risk") {
          if (o.stop == null) return null;
          return { ...base, mode: "risk", qty: null, stop: Number(o.stop), riskPct: o.riskPct != null ? Number(o.riskPct) : null };
        }
        if (o.qty == null) return null;
        return { ...base, mode: "explicit", qty: Number(o.qty), stop: o.stop != null ? Number(o.stop) : null, riskPct: null };
      } catch { return null; }
    }
    const parts = s.split(/\s+/);
    const symbol = (parts[0] || "").toUpperCase();
    const side = (parts[1] || "").toUpperCase();
    if (!symbol || (side !== "BUY" && side !== "SELL")) return null;
    let mode = "explicit", qty = null, price = null, stop = null, riskPct = null, dry = false;
    const nums = [];   // bare (non-@, non-keyword) numbers, in order
    for (const tok of parts.slice(2)) {
      if (tok.startsWith("@")) { const p = Number(tok.slice(1)); if (Number.isFinite(p)) price = p; continue; }
      // dry / preview: compute + return the sizing WITHOUT placing an order.
      if (/^(?:dry|--dry|preview)$/i.test(tok)) { dry = true; continue; }
      const mRisk = /^risk(?:=([\d.]+))?$/i.exec(tok);
      if (mRisk || tok === "%") { mode = "risk"; if (mRisk && mRisk[1]) riskPct = Number(mRisk[1]); continue; }
      const n = Number(tok);
      if (Number.isFinite(n)) nums.push(n);
    }
    if (mode === "risk") {
      // First bare number = stop price (required). A second bare number, if no @
      // was given, is treated as the entry price.
      if (!nums.length) return null;
      stop = nums[0];
      if (price == null && nums.length > 1) price = nums[1];
      return { symbol, side, mode, qty: null, price, stop, riskPct, dry };
    }
    // explicit: first bare number = qty (required); second = price (legacy @-less form).
    if (!nums.length) return null;
    qty = nums[0];
    if (price == null && nums.length > 1) price = nums[1];
    return { symbol, side, mode, qty, price, stop: null, riskPct: null, dry };
  }

  // --- Trading guards + audit log -------------------------------------------
  // Append every order attempt to data/orders.json so there's a durable trail
  // (kept under the testnet cap — auto-trimmed to the last 200 entries).
  const auditFile = path.join(ctx.dataDir, "orders.json");
  const noiseFile = path.join(ctx.dataDir, "blocked.json");
  const archiveFile = () =>
    path.join(ctx.dataDir, "orders-" + new Date().toISOString().slice(0, 7) + ".jsonl");


  let lastArchivedDay = null;
  const audit = (entry) => {
    try {
      let log = [];
      try { log = JSON.parse(fs.readFileSync(auditFile, "utf8")); } catch {}
      log.push({ ts: Date.now(), ...entry });
      // Trimming used to mean DESTROYING. Append the older tail to a monthly
      // JSONL once a day so the ring stays small without losing history.
      const today = new Date().toISOString().slice(0, 10);
      if (lastArchivedDay !== today) {
        lastArchivedDay = today;
        const cut = new Date(); cut.setHours(0, 0, 0, 0);
        const old = log.filter((e) => e && e.ts < cut.getTime());
        if (old.length) {
          try { fs.appendFileSync(archiveFile(), old.map((e) => JSON.stringify(e)).join("\n") + "\n"); }
          catch (e) { ctx.log("binance: audit archive failed: " + e.message); }
        }
      }
      writeJsonAtomic(auditFile, auditTrim(log));
    } catch (e) { ctx.log("binance: audit write failed: " + e.message); }
  };

  // Blocked signals, dry runs and monitor errors go here instead of competing
  // with real fills for space in the money trail. 79 of the 200 slots in the
  // old single ring were `auto-signal-blocked` — enough to trim a whole day's
  // fills out from under maxTradesPerDay.
  const auditNoise = (entry) => {
    try {
      let log = [];
      try { log = JSON.parse(fs.readFileSync(noiseFile, "utf8")); } catch {}
      log.push({ ts: Date.now(), ...entry });
      writeJsonAtomic(noiseFile, log.slice(-200));
    } catch { /* noise must never break a trading path */ }
  };
  /**
   * Guard for PROTECTIVE operations — close, stoploss, cancel.
   *
   * The rule: pause stops the desk from OPENING; it must never stop it from
   * managing or exiting what is already open. `close` and `stoploss` used to
   * run through tradeGuard, whose first check is tradePaused — so hitting the
   * kill switch also removed the ability to flatten a position or place a
   * protective stop. That deadlock is on record in workspace/notes.md.
   *
   * Deliberately NOT checked here: tradePaused, tradeEnabled, and the symbol
   * allowlist — a symbol removed from the allowlist after a position was opened
   * must still be exitable. What remains is what genuinely must hold: the
   * testnet lock and the presence of keys.
   */
  function protectiveGuard(o) {
    const c = cfg();
    if (!c.testnet) return "ปฏิเสธ: plugin อยู่ในโหมด MAINNET — ใช้ testnet เท่านั้นเพื่อความปลอดภัย";
    if (!c.apiKey || !c.apiSecret) return "missing API key/secret (ตั้งใน panel ก่อน)";
    return null;
  }

  // Multi-layer guard. Returns null if allowed, or an error string explaining
  // why the trade is blocked. Every check is independent so the agent gets a
  // precise reason to act on.
  function tradeGuard(o) {
    const c = cfg();
    if (c.tradePaused) return "trading ถูกพักไว้ (kill-switch) — resume ใน dashboard/panel ก่อน";
    if (!c.tradeEnabled) return "การเทรดยังปิดอยู่ — เปิด tradeEnabled ใน panel ก่อน (⚙️ ตั้งค่า)";
    if (!c.testnet) return "ปฏิเสธ: plugin อยู่ในโหมด MAINNET — ใช้ testnet เท่านั้นเพื่อความปลอดภัย";
    if (!c.apiKey || !c.apiSecret) return "missing API key/secret (ตั้งใน panel ก่อน)";
    const sym = String(o.symbol || "").toUpperCase();
    if (c.allowedSymbols && c.allowedSymbols.length && !c.allowedSymbols.includes(sym))
      return `symbol ${sym} ไม่อยู่ใน allowlist (อนุญาต: ${c.allowedSymbols.join(", ")})`;
    // Notional cap = equity x maxNotionalPct%. equityBase uses simulatedEquity
    // (the locked $5002 real base) so the check stays sync + deterministic.
    const equityBase = c.simulatedEquity || 0;
    const notionalCap = equityBase * (c.maxNotionalPct || 0) / 100;
    if (notionalCap && o.usdValue && o.usdValue > notionalCap)
      return `notional $${Number(o.usdValue).toFixed(2)} เกิน cap $${notionalCap.toFixed(0)} (${c.maxNotionalPct}% ของ equity $${equityBase})`;
    if (o.leverage && c.maxLeverage && o.leverage > c.maxLeverage)
      return `leverage ${o.leverage}x เกิน cap ${c.maxLeverage}x`;
    return null;   // allowed
  }

  // --- Auto-trade guards (Phase 7) -----------------------------------------
  // Count today's executed entries from the audit log across ALL entry paths:
  // manual `order` fills log {cmd:"order", ok}, while autotrade / auto-signal
  // fills log {cmd:"autotrade"|"auto-signal", orderOk} — counting only "order"
  // let auto fills bypass maxTradesPerDay. Blocked attempts never count.
  // Returns {count, complete}. `complete:false` means the count is only a lower
  // bound (unreadable log, or the ring already trimmed past midnight) — the
  // caller must treat that as "cannot prove we are under the cap" and block.
  // The old version returned 0 on any read error, which turned an unreadable
  // audit log into a free pass.
  function tradesToday() {
    let log = null;
    try { log = JSON.parse(fs.readFileSync(auditFile, "utf8")); } catch { log = null; }
    return tradesTodayDecide(log, Date.now());
  }
  // Fetch today's realized PnL (income REALIZED_PNL since midnight) + current
  // unrealized PnL, to check the daily-loss limit. Returns {realized, unreal}.
  // Returns {realized, unreal, complete}. `complete:false` means a page or the
  // position read failed, so the number is NOT a usable measure of today's PnL.
  // The old version swallowed every failure and returned 0 — i.e. an exchange
  // outage read as "flat day" and the daily-loss limit could never trip.
  async function dailyPnl() {
    let realized = 0, unreal = 0, complete = true;
    try {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      // Realized: walk income pages for today (same pagination as the income cmd).
      let endTime = Date.now();
      for (let page = 0; page < 5; page++) {
        const r = await req("GET", "/fapi/v1/income",
          { incomeType: "REALIZED_PNL", startTime: String(dayStart.getTime()), endTime: String(endTime), limit: "1000" }, true);
        if (!r.ok) { complete = false; break; }
        const rows = Array.isArray(r.json) ? r.json : [];
        realized += rows.reduce((s, x) => s + Number(x.income || 0), 0);
        if (rows.length < 1000) break;
        endTime = rows[0].time - 1;
      }
    } catch { complete = false; }
    try {
      const pr = await req("GET", "/fapi/v2/positionRisk", null, true);
      if (pr.ok && Array.isArray(pr.json))
        unreal = pr.json.reduce((s, p) => s + Number(p.unRealizedProfit || 0), 0);
      else complete = false;
    } catch { complete = false; }
    return { realized: Math.round(realized * 1e6) / 1e6, unreal: Math.round(unreal * 1e6) / 1e6, complete };
  }
  /** The one authoritative read of what is actually open on the exchange.
   *  {ok:false} on any failure — callers must block, never assume "nothing
   *  open". Three guards used to each make their own read and each swallow its
   *  own error, so one outage quietly relaxed three limits at once. */
  async function livePositions() {
    try {
      const pr = await req("GET", "/fapi/v2/positionRisk", null, true);
      if (!pr.ok || !Array.isArray(pr.json)) return { ok: false, open: [] };
      return { ok: true, open: pr.json.filter((p) => Math.abs(Number(p.positionAmt || 0)) > 0) };
    } catch { return { ok: false, open: [] }; }
  }

  /**
   * The daily-loss circuit breaker, extracted so it can run from the MONITOR
   * loop as well as from the entry guard.
   *
   * It used to live only inside autoTradeGuard, which meant it fired only when
   * a new entry was attempted. Combined with onePositionAtATime, a single bad
   * runner is exactly the case where no entry is attempted — so the breaker was
   * guaranteed not to run in the one scenario it exists for.
   *
   * Returns {evaluable, tripped, ...}. Callers decide what an unevaluable
   * result means: the entry path blocks (it has a trade to refuse), the monitor
   * path does not (tripping off incomplete data would write config from noise).
   */
  async function dailyLossCheck({ trip = true } = {}) {
    const c = cfg();
    const equityBase = c.simulatedEquity || await accountEquity();
    const { realized, unreal, complete } = await dailyPnl();
    if (!complete) return { evaluable: false, tripped: false };
    const dayPnl = realized + unreal;
    const sr = c.scalping ? (c.scalpingRules || {}) : {};
    const lossPct = c.scalping ? (sr.dailyLossPct || 3) : (c.dailyLossPct || 2);
    const lossLimit = -Math.abs(equityBase * lossPct / 100);
    if (dayPnl > lossLimit) return { evaluable: true, tripped: false, dayPnl, lossLimit };

    const msg = tgAlert({
      kind: "danger", title: "Daily Loss Limit ถึงแล้ว",
      rows: [
        { label: "PnL วันนี้", value: fmtUsd(dayPnl), accent: "❌ เกิน limit" },
        { label: "Limit", value: `${lossPct}% = $${Math.abs(lossLimit).toFixed(2)}` },
      ],
      footer: "autoTrade ปิดอัตโนมัติ — หยุดเทรดทั้งวัน",
    });
    // Only announce on the transition. Once autoTrade is already off the
    // breaker stays tripped silently; the heartbeat is what reminds the owner
    // it is still disabled (there is deliberately no auto re-arm).
    if (trip && c.autoTrade) {
      saveCfg({
        autoTrade: false, autoTradeDisabledBy: "daily-loss",
        autoTradeDisabledAt: Date.now(), autoTradeDisabledPnl: dayPnl,
      });
      ctx.broadcast({ type: "trade.alert", plugin: "binance", kind: "daily-loss", pnl: dayPnl, limit: lossLimit });
      ctx.feed(msg, "compass");
      try { ctx.relay(msg); } catch {}
    }
    return { evaluable: true, tripped: true, msg, dayPnl, lossLimit };
  }

  // Account equity (USDT balance + unrealized PnL) — the base for % limits.
  async function accountEquity() {
    let bal = 0;
    try {
      const r = await req("GET", "/fapi/v2/balance", null, true);
      if (r.ok && Array.isArray(r.json)) {
        const u = r.json.find((b) => b.asset === "USDT");
        if (u) bal = Number(u.balance);
      }
    } catch {}
    const { unreal } = await dailyPnl();
    return bal + unreal;
  }
  // Recent realized-PnL outcomes (win/loss) from income, newest first, within
  // a lookback window. Used by the loss-streak cooldown. Each item is {time, win}.
  // Returns {ok, outcomes}. `ok:false` means the read failed — the old version
  // returned [] on error, which reads as "no recent losses" and hands out
  // permission to keep trading immediately after a bad run.
  async function recentOutcomes(windowMin) {
    let ok = true;
    try {
      const since = Date.now() - windowMin * 60000;
      let endTime = Date.now();
      const out = [];
      for (let page = 0; page < 3; page++) {
        const r = await req("GET", "/fapi/v1/income",
          { incomeType: "REALIZED_PNL", startTime: String(since), endTime: String(endTime), limit: "1000" }, true);
        if (!r.ok) { ok = false; break; }
        const rows = Array.isArray(r.json) ? r.json : [];
        out.push(...rows);
        if (rows.length < 1000) break;
        endTime = rows[0].time - 1;
      }
      return { ok, outcomes: out.sort((a, b) => b.time - a.time).map((x) => ({ time: x.time, win: Number(x.income) > 0 })) };
    } catch { return { ok: false, outcomes: [] }; }
  }
  // Count the current consecutive-loss streak (from the newest outcome backward,
  // stopping at the first win). Returns { streak, lastLossTime }.
  function lossStreak(outcomes) {
    let streak = 0, lastLossTime = null;
    for (const o of outcomes) {
      if (!o.win) { streak++; if (!lastLossTime) lastLossTime = o.time; }
      else break;
    }
    return { streak, lastLossTime };
  }
  // Read the Pulse news cache (workspace/news-cache.json) if present.
  // Returns the events array or []. Schema: [{title, at, impact, minutesUntil}].
  // Freshness of the news cache, for the snapshot/heartbeat. Reported
  // separately from the gate decision so the owner can see a dependency
  // failing BEFORE it silently disarms the auto path.
  function newsCacheAgeH() {
    const nc = readNewsCache();
    if (!nc.ok || !Number.isFinite(nc.mtimeMs)) return null;
    return Math.round(((Date.now() - nc.mtimeMs) / 3600000) * 10) / 10;
  }
  function newsCacheStale() {
    const g = cfg().newsGate || {};
    if (!g.enabled) return false;
    const nc = readNewsCache();
    if (!nc.ok) return true;
    const maxAgeH = g.maxCacheAgeH == null ? 24 : g.maxCacheAgeH;
    if (!(maxAgeH > 0) || !Number.isFinite(nc.mtimeMs)) return false;
    return Date.now() - nc.mtimeMs > maxAgeH * 3600000;
  }

  // Returns {ok, events, mtimeMs}. `ok:false` is NOT the same as "no events" —
  // an unreadable cache while the gate is enabled means we cannot evaluate the
  // news risk at all, and newsGateDecide blocks on it.
  function readNewsCache() {
    try {
      const p = path.join(ctx.workspace, "news-cache.json");
      const raw = fs.readFileSync(p, "utf8");
      const j = JSON.parse(raw);
      const events = Array.isArray(j.events) ? j.events : (Array.isArray(j) ? j : []);
      let mtimeMs = NaN;
      try { mtimeMs = fs.statSync(p).mtimeMs; } catch { /* age unknown → not stale-checked */ }
      // The cache's own write time. Events stamped with exactly this are
      // commentary the writer had no schedule for — see isScheduledEvent.
      const updatedMs = j && j.updated ? Date.parse(j.updated) : NaN;
      return { ok: true, events, mtimeMs, updatedMs };
    } catch { return { ok: false, events: [], mtimeMs: NaN, updatedMs: NaN }; }
  }
  // --- Position store (data/positions.json) --------------------------------
  // Tracks active positions for the auto-exit manager: entry/stop/target/
  // trail + the best price seen (maxFavorable) so the trail can lock profit.
  const posFile = path.join(ctx.dataDir, "positions.json");
  const readPos = () => { try { return JSON.parse(fs.readFileSync(posFile, "utf8")); } catch { return []; } };
  const writePos = (arr) => writeJsonAtomic(posFile, arr);
  const upsertPos = (p) => {
    const arr = readPos().filter((x) => x.symbol !== p.symbol);
    arr.push(p); writePos(arr);
  };
  const removePos = (symbol) => writePos(readPos().filter((x) => x.symbol !== symbol));

  // Shadow ledger — what autoTradeSignal WOULD have opened. Kept in its own
  // file so no order-placing or exit-managing path can ever confuse a shadow
  // entry for a real position.
  const shadowFile = path.join(ctx.dataDir, "positions.shadow.json");
  const shadowPos = () => { try { return JSON.parse(fs.readFileSync(shadowFile, "utf8")); } catch { return []; } };
  const writeShadow = (arr) => { try { writeJsonAtomic(shadowFile, arr); } catch (e) { ctx.log("binance: shadow write failed: " + e.message); } };

  /**
   * An exit order was rejected. Keep the position tracked (the next tick will
   * re-evaluate and try again), write NO journal row, and escalate to a human
   * after a bounded number of attempts rather than looping orders forever.
   *
   * The old behaviour was the opposite on all three counts: it dropped the
   * position from tracking, wrote a journal row claiming a realised PnL that
   * never happened, and left a live position that nothing was managing.
   */
  function recordExitFailure(tp, kind, resp) {
    const attempts = ((tp.exitFailed && tp.exitFailed.attempts) || 0) + 1;
    const err = (resp && resp.json && resp.json.msg) || (resp && resp.body) || "unknown";
    tp.exitFailed = { at: Date.now(), kind, attempts, err };
    try { upsertPos(tp); } catch (e) { ctx.log("binance: exit-failure persist failed: " + e.message); }
    audit({ cmd: "exit-failed", symbol: tp.symbol, kind, attempts, err, status: resp && resp.status });

    // Throttle: one alert per symbol per 10 min, and one hard escalation.
    const lastAlert = (tp.exitFailed && tp.exitFailed.lastAlertAt) || 0;
    if (Date.now() - lastAlert > 600000 || attempts >= 3) {
      tp.exitFailed.lastAlertAt = Date.now();
      try { upsertPos(tp); } catch {}
      const msg = attempts >= 3
        ? `🚨 ${tp.symbol} ปิดไม้ (${kind}) ไม่สำเร็จ ${attempts} ครั้ง — หยุดพยายามแล้ว เดสก์ pause · ต้องจัดการด้วยมือ\n(${err})`
        : `⚠️ ${tp.symbol} ปิดไม้ (${kind}) ไม่สำเร็จ ครั้งที่ ${attempts} — ยังติดตาม position อยู่ จะลองใหม่รอบหน้า\n(${err})`;
      ctx.feed(msg, "compass"); try { ctx.relay(msg); } catch {}
    }
    if (attempts >= 3) {
      try { setPause(true, "auto", `exit-failed:${tp.symbol}:${kind}`); } catch {}
    }
  }
  // --- Trade journal (workspace/trades/) -----------------------------------
  // Append a human-readable + machine-parseable line per closed trade. The
  // position manager calls this on every exit so the journal is always current.
  const tradesDir = path.join(ctx.workspace, "trades");
  const journalLine = (tp, exitPrice, kind, pnl) => {
    try {
      fs.mkdirSync(tradesDir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const f = path.join(tradesDir, day + ".md");
      const tm = new Date().toLocaleTimeString("th-TH", { hour12: false });
      const header = `# Trade Journal — ${day}\n\n| time | symbol | side | qty | entry | exit | kind | pnl | source |\n|---|---|---|---|---|---|---|---|---|\n`;
      let body = "";
      try { body = fs.readFileSync(f, "utf8"); } catch {}
      if (!body.startsWith("# Trade Journal")) body = header + body;
      const row = `| ${tm} | ${tp.symbol} | ${tp.side} | ${tp.qty} | ${tp.entry} | ${exitPrice} | ${kind} | ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} | ${tp.source || "manual"} |`;
      body = body.replace(header, header + row + "\n");
      if (!body.includes(row)) body = (body.startsWith("#") ? "" : header) + row + "\n";
      fs.writeFileSync(f, header + body.replace(header, ""));
    } catch (e) { ctx.log("binance: journal write failed: " + e.message); }
  };
  // --- Performance stats from the audit log --------------------------------
  // Count wins/losses + total PnL from today's realized exits. Used by Sigma
  // and the dashboard performance card.
  function performanceStats(days = 1) {
    let wins = 0, losses = 0, totalPnl = 0, exits = 0;
    try {
      const log = JSON.parse(fs.readFileSync(auditFile, "utf8"));
      const since = Date.now() - days * 86400000;
      for (const e of log) {
        if (e.cmd !== "exit" || !e.ts || e.ts < since) continue;
        exits++;
        if (typeof e.pnl === "number") {
          totalPnl += e.pnl;
          if (e.pnl > 0) wins++; else if (e.pnl < 0) losses++;
        }
      }
    } catch {}
    const total = wins + losses;
    return { days, exits, wins, losses, winRate: total ? Math.round(wins / total * 1000) / 10 : null, totalPnl: Math.round(totalPnl * 1e6) / 1e6 };
  }

  // --- Read-only snapshot + pause (dashboard bridge) -----------------------
  // The Copilot dashboard (port 5188) is VIEW-ONLY by charter. These two are
  // the ONLY Office surface it can reach through the Vite proxy — the "staged
  // read-only replacement" the charter required. snapshot() gathers everything
  // a dashboard needs in one call; pause() is the single mutation exposed and
  // it only *stops* trading (never opens a position).

  // Constant-time string compare so a timing side-channel can't leak the token.
  function tokenMatches(given) {
    const want = cfg().officePauseToken || "";
    if (!want || !given) return false;   // fail-closed: empty token = no pause
    const a = String(given), b = String(want);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // Unified loopback call to the sibling copilot-link plugin. Used by both the
  // snapshot embed (fetchCopilotSummary) and the requireCopilotApproval gate so
  // they share one code path, one schema, one timeout, and one fail-open policy.
  // CRITICAL: must use http.request (NOT https) — this is a loopback plaintext
  // URL. The old requireCopilotApproval call-site used https.request, which
  // throws ERR_INVALID_PROTOCOL synchronously and was swallowed by a silent
  // catch {} — making the gate a no-op. That silent catch is the reason the bug
  // hid for so long; this helper logs a warning instead of failing silently.
  async function callCopilotDecision(timeoutMs = 3000) {
    try {
      return await new Promise((resolve) => {
        const body = JSON.stringify({ cmd: "decision" });
        const r = http.request("http://127.0.0.1:8787/plugin/copilot-link/cmd", {
          method: "POST", timeout: timeoutMs,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        }, (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            try {
              const j = JSON.parse(d);
              resolve(j && j.ok ? {
                decision: j.decision, direction: j.direction, symbol: j.symbol,
                grade: j.grade, decision_id: j.decision_id, generated_at: j.generated_at,
                ageSec: j.ageSec, stale: j.stale,
                // Surface the gate fields the approval gate needs (B3 fix).
                risk_gate: j.risk_gate, execution: j.execution,
              } : null);
            } catch { resolve(null); }
          });
        });
        r.on("error", (e) => { ctx.log("binance: copilot-link unreachable (" + e.message + ") — failing open"); resolve(null); });
        r.on("timeout", () => { r.destroy(); ctx.log("binance: copilot-link timeout — failing open"); resolve(null); });
        r.end(body);
      });
    } catch (e) { ctx.log("binance: copilot-link call failed (" + e.message + ") — failing open"); return null; }
  }

  // Loopback call to the sibling regime-radar plugin — the single deterministic
  // regime engine. Returns { regime, dir, confidence } or null. Same loopback
  // pattern (and fail-open-at-transport) as callCopilotDecision; the CALLER
  // (regimeGateCheck) decides the fail-CLOSED policy on a null.
  async function callRegimeRadar(symbol, tf, timeoutMs = 4000) {
    try {
      return await new Promise((resolve) => {
        const body = JSON.stringify({ cmd: "regime", args: `${symbol} ${tf}` });
        const r = http.request("http://127.0.0.1:8787/plugin/regime-radar/cmd", {
          method: "POST", timeout: timeoutMs,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        }, (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            try {
              const j = JSON.parse(d);
              resolve(j && j.ok ? { regime: j.regime, dir: j.dir, confidence: j.confidence } : null);
            } catch { resolve(null); }
          });
        });
        r.on("error", (e) => { ctx.log("binance: regime-radar unreachable (" + e.message + ")"); resolve(null); });
        r.on("timeout", () => { r.destroy(); ctx.log("binance: regime-radar timeout"); resolve(null); });
        r.end(body);
      });
    } catch (e) { ctx.log("binance: regime-radar call failed (" + e.message + ")"); return null; }
  }

  // Regime gate for breakout/trend auto-arm. Returns null to ALLOW, or a reason
  // string to BLOCK. r.dir is "bull"/"bear". FAIL-CLOSED: a missing regime blocks.
  async function regimeGateCheck(r) {
    const g = cfg().regimeGate || {};
    if (g.enabled === false) return null;
    const rr = await callRegimeRadar(r.symbol, g.tf || "1h");
    if (!rr || !rr.regime) return `regimeGate: regime unavailable for ${r.symbol} (fail-closed) — ข้าม`;
    const want = r.dir === "bull" ? "Trend-Up" : "Trend-Down";
    if ((g.mode || "aligned") === "longOnly") {
      if (r.dir === "bull" && rr.regime === "Trend-Up") return null;
      return `regimeGate(longOnly): ${r.symbol} regime=${rr.regime} — arm เฉพาะ Trend-Up long เท่านั้น, ข้าม`;
    }
    // "aligned": trade direction must match a trending regime; Range/High-Vol skip.
    if (rr.regime === want) return null;
    return `regimeGate: ${r.symbol} ${r.dir} ต้องการ regime=${want} แต่ตอนนี้=${rr.regime} (conf ${rr.confidence}%) — ข้าม (ไม่ arm)`;
  }

  // Snapshot embed: advisory only — stale flag surfaces so the dashboard can warn.
  async function fetchCopilotSummary() {
    return await callCopilotDecision(3000);
  }

  // Build the full read-only snapshot. Reuses every existing helper (req,
  // fmtBal/fmtPos, cfg, readPos, performanceStats). Binance calls race a
  // timeout so a slow exchange returns partial data instead of hanging the
  // dashboard poll.
  async function buildSnapshot() {
    const c = cfg();
    const caps = {
      maxNotionalPct: c.maxNotionalPct, maxLeverage: c.maxLeverage,
      maxTradesPerDay: (c.autoTradeRules || {}).maxTradesPerDay,
      dailyLossPct: c.scalping ? (c.scalpingRules || {}).dailyLossPct : (c.dailyLossPct || 2),
    };
    const base = {
      version: "office-snapshot/v1",
      generatedAt: new Date().toISOString(),
      statusLabel: "snapshot status, not live",
      capabilities: ["snapshot", "pause"],
      environment: c.testnet ? "TESTNET" : "MAINNET",
      paused: !!c.tradePaused,
      autoTrade: !!c.autoTrade,
      autoTradeSignal: !!c.autoTradeSignal,
      tradeEnabled: !!c.tradeEnabled,
      scalping: !!c.scalping,
      // Liveness. loops must be {monitor:1, scanner:1} — anything higher means a
      // previous instance was never disposed and two engines are racing this
      // account. This is the production regression detector for that bug.
      health: {
        loops: { monitor: LOOPS.monitor, scanner: LOOPS.scanner },
        monitorMs: c.monitorMs, startedAt: HEALTH.startedAt,
        lastOkTickAt: HEALTH.lastOkTickAt,
        lastTickErrorAt: HEALTH.lastTickErrorAt, lastTickError: HEALTH.lastTickError,
        consecutiveTickErrors: HEALTH.consecutiveTickErrors,
        autoTradeDisabledBy: c.autoTradeDisabledBy || null,
        autoTradeDisabledAt: c.autoTradeDisabledAt || null,
        pausedReason: c.tradePausedReason || null,
        // News-cache freshness. A stale cache makes the gate fail closed, i.e.
        // the desk quietly stops arming — which is an OPS condition (a
        // dependency is down), not a trading one, so it belongs where the
        // heartbeat can see it. Pulse refreshes this every 15 min.
        newsCacheAgeH: newsCacheAgeH(),
        newsCacheStale: newsCacheStale(),
      },
      caps,
      balance: null,
      positions: [],
      tracked: [],
      recentFills: [],
      performance: performanceStats(1),
      scan: [],
      scanAt: null,
      copilot: null,
    };
    // Binance account data — both signed calls in parallel, each timed.
    if (c.apiKey && c.apiSecret) {
      const timed = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ _timeout: true }), ms))]);
      const [balR, posR] = await Promise.all([
        timed(req("GET", "/fapi/v2/balance", null, true), 8000),
        timed(req("GET", "/fapi/v2/positionRisk", null, true), 8000),
      ]);
      if (balR && !balR._timeout && balR.ok && Array.isArray(balR.json)) {
        const u = balR.json.find((b) => b.asset === "USDT");
        if (u) base.balance = {
          asset: "USDT",
          totalWalletBalance: Number(u.balance),
          availableBalance: Number(u.availableBalance),
          totalUnrealizedProfit: Number(u.crossUnPnl || 0),
        };
      }
      if (posR && !posR._timeout && posR.ok && Array.isArray(posR.json))
        base.positions = posR.json.map(fmtPos).filter((p) => p.size > 0);
    }
    // Tracked positions (target/stop/trail metadata from the auto-exit manager).
    base.tracked = readPos();
    // Recent fills from the audit log (newest first, capped at 15).
    try {
      const log = JSON.parse(fs.readFileSync(auditFile, "utf8"));
      base.recentFills = (Array.isArray(log) ? log : []).slice(-15).reverse();
    } catch {}
    // Last scanner result (in-memory cache; top 5 by score).
    if (lastScan && lastScan.ranked) {
      base.scan = lastScan.ranked.slice(0, 5).map((r) => ({
        symbol: r.symbol, grade: r.grade, dir: r.dir, score: r.score,
        entry: r.entry, stop: r.stop, target: r.target, signals: r.signals,
        structure: r.structure, pullback: r.pullback, pullbackFrac: r.pullbackFrac,
      }));
      base.scanAt = lastScan.at;
    }
    // Copilot gate (optional, fail-soft — never blocks the snapshot). B7 fix:
    // surface the stale flag explicitly so the dashboard can warn the user that
    // the decision may be hours old, instead of presenting it as fresh.
    const cp = await fetchCopilotSummary();
    if (cp && cp.stale === true) {
      base.copilot = { ...cp, advisory: "decision may be old (stale) — treat as advisory only" };
    } else {
      base.copilot = cp;
    }
    return base;
  }

  // The single mutation the dashboard can perform: toggle tradePaused. Writes
  // config, logs to the audit trail, broadcasts an alert, and relays to phone.
  // Returns a versioned receipt. Called by both the /pause route and the
  // `pause` command so behavior is identical from either entry point.
  function setPause(paused, actor, reason) {
    const c = saveCfg({ tradePaused: !!paused });
    audit({ cmd: "pause", paused: !!paused, reason: reason || null, actor: actor || "unknown" });
    const now = new Date().toISOString();
    ctx.broadcast({ type: "trade.alert", plugin: "binance",
      kind: paused ? "paused" : "resumed", actor: actor || "unknown", reason: reason || null });
    const msg = tgAlert({
      kind: paused ? "warn" : "open",
      title: paused ? "TRADING PAUSED" : "TRADING RESUMED",
      rows: [
        { label: "โดย", value: actor || "unknown" },
        { label: "เหตุผล", value: reason || "—" },
      ],
      footer: paused ? "kill-switch เปิด — desk เป็น view-only" : "ปิด kill-switch — เทรดกลับมา (ผ่าน guards)",
    });
    try { ctx.relay(msg); } catch {}
    return { version: "office-pause/v1", paused: !!paused, updatedAt: now, actor: actor || "unknown", reason: reason || null };
  }

  // Minimal body reader fallback (the plugin host always passes readBody, but
  // keep a shim so the route never crashes if the signature changes).
  const readBodyShim = (req, cb) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => cb(d));
    req.on("error", () => cb(""));
  };
  // HTTP route handlers (METHOD-agnostic — reached via plugins.js handleHttp).
  // GET /plugin/binance/snapshot  → versioned read-only state.
  // POST /plugin/binance/pause    → token-gated kill-switch toggle.
  const routes = {
    snapshot(req, res) {
      buildSnapshot()
        .then((snap) => {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store", "x-content-type-options": "nosniff" });
          res.end(JSON.stringify(snap));
        })
        .catch((e) => {
          ctx.log("binance: snapshot error: " + e.message);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "snapshot failed" }));
        });
    },
    pause(req, res, helpers) {
      const rb = (helpers && helpers.readBody) || readBodyShim;
      rb(req, (body) => {
        let p = {}; try { p = JSON.parse(body); } catch {}
        const token = (p.token || "").trim();
        if (!tokenMatches(token)) {
          res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
          return res.end(JSON.stringify({ ok: false, error: "invalid or missing pause token" }));
        }
        const receipt = setPause(!!p.paused, p.actor, p.reason);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(receipt));
      });
    },
  };

  // Closed-loop auto-execution: when a scanner signal qualifies and the owner
  // has enabled autoTradeSignal, place the autotrade DIRECTLY. This reuses the
  // exact same orderBody+guard+stop path as the `autotrade` command — no
  // shortcut around safety. Returns the fill result or a blocked reason.
  /**
   * Last line of defence: the stop could not be placed, so flatten immediately
   * rather than run a naked position.
   *
   * The old code fired this and threw the result away, then returned BEFORE
   * upsertPos — so a close that failed (rate limit, -2022, a timeout) left a
   * position that was naked AND untracked AND reported to the phone as closed.
   * That is the worst reachable state in the system, and it was silent.
   *
   * Now the outcome must be PROVEN: the close is verified with a fresh
   * positionRisk read, and anything short of "confirmed flat" is treated as
   * still-open-and-naked — the position gets tracked so the monitor can see it,
   * the desk pauses so it stops opening more, and the message says what really
   * happened. There is deliberately no retry: re-firing a market order inside a
   * failure path is how you end up double-closed and reversed.
   */
  async function emergencyClose({ symbol, closeSide, qty, source, reason, intendedStop, stopResp }) {
    const cr = await req("POST", "/fapi/v1/order",
      { symbol, side: closeSide, type: "MARKET", quantity: String(qty), reduceOnly: "true", newClientOrderId: makeClientOrderId("xe", Date.now()) }, true);

    let verifyOk = false, verifyAmt = 0;
    const vr = await req("GET", "/fapi/v2/positionRisk", { symbol }, true);
    if (vr.ok && Array.isArray(vr.json)) {
      verifyOk = true;
      verifyAmt = vr.json.reduce((s, p) => s + Math.abs(Number(p.positionAmt) || 0), 0);
    }
    const outcome = emergencyOutcome({ closeOk: cr.ok, verifyOk, verifyAmt });

    audit({
      cmd: "emergency-close", symbol, source, reason,
      closeOk: cr.ok, verified: verifyOk, remainingQty: verifyAmt,
      flat: outcome.flat, outcome: outcome.reason,
      resp: stopResp || (cr.json || cr.body),
    });
    ctx.broadcast({ type: "trade.alert", plugin: "binance", kind: "stop-failed", symbol, flat: outcome.flat });

    if (outcome.flat) {
      const msg = `🚨 ${symbol} STOP วางไม่ติด → ปิดไม้แล้ว (ยืนยัน flat จาก exchange)`;
      ctx.feed(msg, "compass"); try { ctx.relay(msg); } catch {}
      return { flat: true, msg: "stop วางไม่ติด — ปิด position ฉุกเฉินแล้ว (ยืนยันแล้ว)" };
    }

    // Could not prove flat ⇒ assume open and unprotected.
    try {
      upsertPos({
        symbol, side: closeSide === "SELL" ? "BUY" : "SELL", qty: Math.abs(Number(qty)) || 0,
        entry: 0, stop: intendedStop != null ? intendedStop : null, initialStop: intendedStop != null ? intendedStop : null,
        openedAt: Date.now(), maxFavorable: 0, source: "emergency-orphan",
        managed: true, needsAttention: true, emergencyReason: outcome.reason,
      });
    } catch (e) { ctx.log("binance: emergency upsertPos failed: " + e.message); }
    try { setPause(true, "auto", "emergency-close-failed:" + symbol); } catch {}
    const msg = `🚨🚨 ${symbol} ปิดไม้ฉุกเฉิน "${outcome.reason}" — ยืนยันไม่ได้ว่าปิดแล้ว\n` +
      `position อาจยังเปิดอยู่และไม่มี stop · เดสก์ถูก pause อัตโนมัติ · ต้องเช็คด้วยตาเดี๋ยวนี้`;
    ctx.feed(msg, "compass"); try { ctx.relay(msg); } catch {}
    return { flat: false, reason: outcome.reason, msg: "ปิดไม้ฉุกเฉินไม่สำเร็จ/ยืนยันไม่ได้ — เดสก์ pause แล้ว เช็คด่วน" };
  }

  // Per-symbol reconciliation state (alert dedup, replace budget). Deliberately
  // a SEPARATE file from positions.json: positions the desk does not own must
  // never appear in the store that the exit manager reads, so "never touch the
  // owner's book" is enforced by structure rather than by discipline.
  const reconFile = path.join(ctx.dataDir, "reconcile-state.json");
  const readRecon = () => { try { return JSON.parse(fs.readFileSync(reconFile, "utf8")); } catch { return {}; } };
  const writeRecon = (o) => { try { writeJsonAtomic(reconFile, o); } catch { /* never break the tick */ } };

  /**
   * Runs once per monitor tick, right after the positions read.
   *
   * Answers two questions nothing in this plugin could answer before:
   *   - is every open position actually covered by a live stop on the exchange?
   *   - is this position even ours?
   * and then does the least dangerous thing that follows from the answer.
   */
  async function reconcile(livePos) {
    const c = cfg();
    if (!Array.isArray(livePos) || livePos.length === 0) {
      if (Object.keys(readRecon()).length) writeRecon({});   // nothing open ⇒ nothing to remember
      return;
    }
    const algos = await listStopAlgosChecked();      // ONE account-wide call
    const tracked = readPos();
    const trackedSyms = new Set(tracked.map((t) => t.symbol));
    const classes = {}, coverage = {};
    for (const p of livePos) {
      coverage[p.symbol] = stopCoverage({
        positionAmt: p.positionAmt,
        algos: algos == null ? null : algos.filter((a) => String(a.symbol) === String(p.symbol)),
      });
      if (trackedSyms.has(p.symbol)) { classes[p.symbol] = "desk"; continue; }
      const ao = await req("GET", "/fapi/v1/allOrders", { symbol: p.symbol, limit: "50" }, true);
      classes[p.symbol] = classifyPosition({
        positionAmt: p.positionAmt, tracked: false,
        orders: ao.ok && Array.isArray(ao.json) ? ao.json : null,
        taggingSinceMs: c.taggingSinceMs || Infinity,
      });
    }

    const d = reconcileDecide({
      live: livePos, tracked, classes, coverage, state: readRecon(), nowMs: Date.now(),
    });
    writeRecon(d.state);

    for (const a of d.adopt) {
      // Adopted = WATCHED, not managed. managed:false makes the exit manager
      // skip it entirely: the desk has no idea what the human intended for a
      // position it did not plan, so it reports and counts it, nothing more.
      upsertPos({
        symbol: a.symbol, side: Number(a.positionAmt) > 0 ? "BUY" : "SELL",
        qty: Math.abs(Number(a.positionAmt) || 0), entry: Number(a.entryPrice) || 0,
        stop: null, initialStop: null, openedAt: Date.now(),
        maxFavorable: Number(a.entryPrice) || 0, source: "adopted", managed: false,
      });
      audit({ cmd: "adopted", symbol: a.symbol, qty: a.positionAmt, managed: false });
    }

    for (const rp of d.replace) {
      const sr = await placeStopAlgo(rp.symbol, rp.side, rp.stop);
      audit({ cmd: "stop-replace", symbol: rp.symbol, stop: rp.stop, ok: sr.ok, resp: sr.resp });
      const m = sr.ok ? `🛡️ ${rp.symbol} stop หายไป — วางใหม่ที่ ${rp.stop} แล้ว`
                      : `⚠️ ${rp.symbol} stop หายไป และวางใหม่ไม่สำเร็จ`;
      ctx.feed(m, "compass"); try { ctx.relay(m); } catch {}
    }

    const WORDS = {
      "foreign-naked": (s, k) => `⚠️ ${s} เปิดอยู่และไม่มี stop — เป็นไม้ที่เดสก์ไม่ได้เปิด (${k}) จึงไม่แตะ แจ้งให้ทราบเท่านั้น`,
      "desk-naked-no-stop": (s) => `🚨 ${s} เป็นไม้ของเดสก์ ไม่มี stop และไม่รู้ราคา stop เดิม — pause แล้ว ต้องจัดการด้วยมือ`,
      "stop-replace-exhausted": (s) => `🚨 ${s} วาง stop ใหม่ไม่สำเร็จครบจำนวนครั้ง — หยุดพยายาม pause แล้ว`,
      "coverage-unverified": (s) => `⚠️ ${s} ตรวจ stop coverage ไม่ได้หลายรอบติด — ไม่ได้แปลว่าไม่มี stop แต่ยืนยันไม่ได้`,
    };
    for (const al of d.alerts) {
      const m = (WORDS[al.kind] || ((s, k) => `${s}: ${k}`))(al.symbol, al.class);
      audit({ cmd: "reconcile-alert", symbol: al.symbol, kind: al.kind, class: al.class });
      ctx.feed(m, "compass"); try { ctx.relay(m); } catch {}
    }
    if (d.pause && !c.tradePaused) {
      try { setPause(true, "auto", "reconcile:" + d.pause); } catch {}
    }
  }

  async function executeAutoSignal(r) {
    if (disposed) return { blocked: "instance disposed" };
    const c = cfg();
    const rules = c.autoTradeSignalRules || {};
    // Grade floor.
    const order = { A: 3, B: 2, C: 1 };
    if ((order[r.grade] || 0) < (order[rules.minGrade || "B"] || 0))
      return { blocked: `signal grade ${r.grade} < ${rules.minGrade || "B"}` };
    // REGIME GATE — breakout/trend arm only when the regime confirms direction
    // (LONG⇒Trend-Up, SHORT⇒Trend-Down; Range/High-Vol⇒skip). Fail-closed. The
    // scanner loop logs the returned reason to the audit trail (auto-signal-blocked).
    const regimeBlock = await regimeGateCheck(r);
    if (regimeBlock) return { blocked: regimeBlock };
    // One-position-at-a-time: skip if any tracked position is open.
    if (rules.onePositionAtATime && readPos().length > 0)
      return { blocked: "มี position เปิดอยู่แล้ว — ข้าม signal" };
    // Position size via the shared %-risk sizer (same equation as manual `order`
    // + autotrade). Grade risk ceiling: 2% reserved for grade-A, 1% otherwise —
    // the default 0.5% sits under both, so it only bites if riskPct is raised.
    const tr = c.trendRules || {};
    const sr = c.scalping ? (c.scalpingRules || {}) : {};
    const riskPct0 = c.scalping ? (sr.riskPct || 0.5) : (tr.riskPct || 0.5);
    const riskCeil = r.grade === "A" ? (tr.riskPctMaxGradeA || 2) : (tr.riskPctMax || 1);
    const sized = await sizeByRisk({ symbol: r.symbol, entry: r.entry, stop: r.stop, riskPct: riskPct0, riskCeil });
    if (sized.blocked) return { blocked: sized.blocked };
    const q = sized.qty;
    const side = r.dir === "bull" ? "BUY" : "SELL";
    // Build the order object the guard expects, then run the FULL gate.
    const o = { symbol: r.symbol, side, qty: q, grade: r.grade,
      stopPrice: r.stop, target: r.target, entry: r.entry, price: null };
    o.usdValue = r.entry * q;
    const block = await autoTradeGuard(o);
    if (block) return { blocked: block };
    // Dynamic leverage guardrail (Option B): gate effective leverage by stop
    // width before opening. Reject only if even the lowest tier fails the buffer.
    const lg = await applyLeverageGuard(r.symbol, r.entry, r.stop, null);
    if (!lg.ok) { auditNoise({ cmd: "auto-signal-blocked", symbol: r.symbol, grade: r.grade, blocked: lg.reason }); return { blocked: lg.reason }; }
    // Last gate before real money: a reload may have disposed this instance
    // during the awaits above, and a disposed engine must never place an order
    // alongside its replacement.
    if (disposed) return { blocked: "instance disposed" };

    // ---- SHADOW MODE ------------------------------------------------------
    // Everything above this line is the real decision path: the same
    // analyzeSymbol, the same dedup, the same regime gate, the same
    // autoTradeGuard, the same sizing. Only the order send is replaced.
    //
    // The point is to learn what the SYSTEM does rather than what the rules
    // say — how often the chain actually fires, which gate does the blocking,
    // whether regime-radar answers in time — without committing capital and
    // without a second copy of the logic that could drift.
    if (c.autoTradeSignalShadow && !c.autoTradeSignal) {
      const sq = shadowPos();
      sq.push({
        symbol: r.symbol, side, qty: q, entry: r.entry, stop: r.stop, target: r.target,
        grade: r.grade, score: r.score, signals: r.signals, dir: r.dir,
        openedAt: Date.now(), maxFavorable: r.entry,
        partialTaken: false, breakevenMoved: false, source: "auto-signal-shadow",
      });
      writeShadow(sq);
      audit({
        cmd: "auto-signal-shadow", symbol: r.symbol, side, qty: q, grade: r.grade,
        entry: r.entry, stop: r.stop, score: r.score, signals: r.signals,
      });
      ctx.feed(`👻 SHADOW ${r.symbol} ${side} grade ${r.grade} @ ${fmtPrice(r.entry)} stop ${fmtPrice(r.stop)} — ไม่ได้ยิงจริง`, "sigma");
      return { shadow: true, symbol: r.symbol, side, qty: q, grade: r.grade };
    }

    // Place MARKET order (scalp = speed) + mandatory stop.
    const or = await req("POST", "/fapi/v1/order",
      { symbol: r.symbol, side, type: "MARKET", quantity: String(q), newClientOrderId: makeClientOrderId("as", Date.now()) }, true);
    audit({ cmd: "auto-signal", symbol: r.symbol, side, qty: q, grade: r.grade, price: r.entry, orderOk: or.ok, status: or.status, resp: or.json || or.body });
    if (!or.ok) return { blocked: "order ล้มเหลว: " + ((or.json && or.json.msg) || or.body) };
    // Mandatory stop — conditional order via the Algo Order API (regular endpoint rejects it).
    // If the stop cannot be placed, NEVER leave a naked position: emergency-close immediately.
    const stopSide = side === "BUY" ? "SELL" : "BUY";
    const sl = await placeStopAlgo(r.symbol, stopSide, r.stop);
    if (!sl.ok) {
      const ec = await emergencyClose({
        symbol: r.symbol, closeSide: stopSide, qty: q, source: "auto-signal",
        reason: "stop placement failed", intendedStop: r.stop, stopResp: sl.resp,
      });
      return { blocked: ec.msg, naked: !ec.flat };
    }
    // entry=0 fix: a MARKET response carries price:"0" (truthy) — guard >0 so tp.entry is real.
    const fillPrice = Number(or.json.avgPrice) > 0 ? Number(or.json.avgPrice)
                    : Number(or.json.price) > 0 ? Number(or.json.price) : r.entry;
    // Track for the auto-exit manager. initialStop is preserved so the R-multiple
    // logic can compute risk distance even after breakeven moves the live stop.
    const pm = c.posManage || {};
    const tr2 = c.trendRules || {};
    upsertPos({
      symbol: r.symbol, side, qty: q, entry: fillPrice,
      stop: r.stop, target: r.target, initialStop: r.stop,
      trailPct: c.scalping ? (pm.trailPct || 0) : (tr2.trailPct || 0),
      openedAt: Date.now(), maxFavorable: fillPrice,
      partialTaken: false, breakevenMoved: false,
      source: "auto-signal",
    });
    const targetLabel = r.target ? "$" + fmtPrice(r.target) : "ปล่อยวิ่ง (runner)";
    const msg = tgAlert({
      kind: "entry", title: `${side === "BUY" ? "LONG 📈" : "SHORT 📉"} ${r.symbol}`,
      rows: [
        { label: "Qty", value: q },
        { label: "Entry", value: "$" + fmtPrice(fillPrice) },
        { label: "Stop", value: "$" + fmtPrice(r.stop) },
        { label: "Target", value: targetLabel },
        { label: "Grade", value: r.grade },
      ],
      footer: `auto-signal · testnet`,
    });
    ctx.broadcast({ type: "trade.fill", plugin: "binance", symbol: r.symbol, side, size: q, entry: fillPrice, auto: true, grade: r.grade, source: "signal" });
    ctx.feed(msg, "blitz");
    try { ctx.relay(msg); } catch {}
    return { ok: true, fillPrice, qty: q };
  }
  // The full auto-trade gate. Returns null if allowed, or a reason string.
  // Checks: autoTrade on + base tradeGuard + daily trade cap + daily loss +
  // setup grade + mandatory stop + no averaging down.
  async function autoTradeGuard(o) {
    const c = cfg();
    if (c.tradePaused) return "trading ถูกพักไว้ (kill-switch) — resume ใน dashboard/panel ก่อน";
    if (!c.autoTrade) return "auto-trade ปิดอยู่ — เปิด autoTrade ใน panel ก่อน";
    const base = tradeGuard(o);
    if (base) return base;
    const rules = c.autoTradeRules || {};
    // Daily trade cap.
    if (rules.maxTradesPerDay) {
      const { count, complete } = tradesToday();
      // Fail closed: an unreadable or already-trimmed audit log means we cannot
      // prove we are under the cap, so we treat ourselves as AT the cap.
      if (!complete)
        return `นับไม้วันนี้ไม่ครบ (audit log อ่านไม่ได้/ถูกตัดข้ามเที่ยงคืน) — ถือว่าถึง limit ${rules.maxTradesPerDay} ไม้/วัน`;
      if (count >= rules.maxTradesPerDay)
        return `ถึง limit ${rules.maxTradesPerDay} ไม้/วัน แล้ว (วันนี้ ${count} ไม้)`;
    }
    // ONE authoritative read of live exchange positions, shared by every guard
    // below that needs to know what is open. Three separate guards used to make
    // their own read (or worse, consult in-memory state) and each swallowed its
    // own failure — so a Binance outage LOOSENED the risk envelope instead of
    // tightening it. Now: one call, one failure mode, and that failure blocks.
    const live = await livePositions();
    if (!live.ok)
      return "อ่าน position จาก exchange ไม่ได้ — ประเมินความเสี่ยงไม่ได้ จึงไม่เปิดไม้ (fail-closed)";

    // Max concurrent open positions — engine-wide exposure cap. Counts LIVE
    // exchange positions (authoritative), so it also respects the CEO's own
    // manual books (e.g. an open ETH SHORT). Adding to a symbol that's already
    // open isn't a new book, so only a brand-new symbol at the cap is blocked.
    const maxConc = c.maxConcurrentPositions || 0;
    if (maxConc) {
      const already = live.open.some((p) => p.symbol === o.symbol);
      if (!already && live.open.length >= maxConc)
        return `ถึงเพดาน ${maxConc} position พร้อมกัน (เปิดอยู่ ${live.open.length}: ${live.open.map((p) => p.symbol).join(", ")}) — ปิดไม้เก่าก่อน`;
    }
    // Portfolio margin HARD CAP (Framework B) — worst-case total margin must
    // stay ≤ marginCapPct% of equity. Effective leverage is gated by stop width
    // (same tier table applyLeverageGuard will set before opening), so the margin
    // estimate here matches what the exchange will actually lock.
    {
      const lg = leverageGuard({ entry: o.entry, stop: o.stopPrice, requestedLev: null });
      const mLev = lg.skipped ? (c.leverageDefault || 3) : lg.effLev;
      const mchk = await marginGuard({ notional: o.usdValue, effLev: mLev });
      if (!mchk.ok) return mchk.reason;
    }
    // Daily loss limit. Scalping: scalpingRules.dailyLossPct (3%). Trend: top-level
    // dailyLossPct (2%). Sizing base for % is simulatedEquity (real capital), not
    // the testnet balance.
    // Entry side of the daily-loss breaker. `evaluable:false` means the PnL data
    // was incomplete — on the ENTRY path that blocks, because we have a trade in
    // hand to refuse. (The monitor side of the same check deliberately does NOT
    // trip on incomplete data; see dailyLossCheck.)
    const dl = await dailyLossCheck({ trip: true });
    if (!dl.evaluable)
      return "อ่าน PnL วันนี้ไม่ครบ — ประเมิน daily-loss limit ไม่ได้ จึงไม่เปิดไม้ (fail-closed)";
    if (dl.tripped) return dl.msg;
    // Loss-streak cooldown. Scalping: uses scalpingRules (3 losses/30min). Trend:
    // uses top-level cooldownAfterLosses/cooldownMin (2 losses/60min). Either way
    // the goal is the same — stop revenge-trading after a bad run.
    const cdLosses = c.scalping ? (sr.cooldownAfterLosses || 0) : (c.cooldownAfterLosses || 0);
    const cdMin = c.scalping ? (sr.cooldownMin || 30) : (c.cooldownMin || 60);
    const cdWindow = c.scalping ? (sr.cooldownWindowMin || 60) : 120;
    if (cdLosses) {
      const oc = await recentOutcomes(cdWindow);
      // recentOutcomes used to swallow read errors into [] — a streak of zero,
      // i.e. permission to keep trading right after a bad run.
      if (!oc.ok)
        return "อ่านผลไม้ล่าสุดไม่ได้ — ประเมิน loss-streak cooldown ไม่ได้ จึงไม่เปิดไม้ (fail-closed)";
      const outcomes = oc.outcomes;
      const { streak, lastLossTime } = lossStreak(outcomes);
      if (streak >= cdLosses && lastLossTime) {
        const cooledAt = lastLossTime + cdMin * 60000;
        if (Date.now() < cooledAt) {
          const waitMin = Math.ceil((cooledAt - Date.now()) / 60000);
          const msg = tgAlert({
            kind: "cool", title: `Loss Streak Cooldown`,
            rows: [
              { label: "ขาดทุนติด", value: streak + " ไม้", accent: "🧊" },
              { label: "รออีก", value: waitMin + " นาที" },
            ],
            footer: "ระบบหยุด auto-trade ชั่วคราว — survival mode",
          });
          ctx.broadcast({ type: "trade.alert", plugin: "binance", kind: "cooldown", streak, waitMin });
          // The desk going quiet for up to an hour used to be broadcast-only —
          // indistinguishable from "no setups" on the phone.
          ctx.feed(msg, "compass"); try { ctx.relay(msg); } catch {}
          return msg;
        }
      }
    }
    // Fee-aware R:R check. Scalping: round-trip taker fee eats the edge (tight).
    // Trend: min R:R floor from trendRules.minRr (rewards patience — must risk
    // less than the reward). For trend with no fixed target (fixedTargetR:0),
    // the R:R is implied by the minRr floor on the stop distance alone.
    if (c.scalping && sr.feeAware && o.entry && o.stop && o.target) {
      const feePct = (sr.feePct || 0.04) / 100;
      const roundTripFee = Math.abs(o.entry) * feePct * 2;
      const grossR = Math.abs(o.target - o.entry);
      const netR = grossR - roundTripFee;
      const risk = Math.abs(o.entry - o.stop);
      const netRr = risk > 0 ? netR / risk : 0;
      if (netRr < (sr.minRrAfterFees || 1.5))
        return `fee-aware reject: net R:R ${netRr.toFixed(2)} < ${sr.minRrAfterFees} หลังหัก fee $${roundTripFee.toFixed(2)} (กำไร $${grossR.toFixed(2)} - fee)`;
    }
    if (!c.scalping && o.entry && o.stop) {
      const tr4 = c.trendRules || {};
      const risk = Math.abs(o.entry - o.stop);
      // If there's a target, check R:R ≥ minRr. If no target (runner), the
      // stop just needs to be sane (risk > 0) — the trend manager handles upside.
      if (o.target && risk > 0) {
        const rr = Math.abs(o.target - o.entry) / risk;
        if (rr < (tr4.minRr || 2))
          return `trend reject: R:R ${rr.toFixed(2)} < ${tr4.minRr || 2} — trend ต้องได้มากกว่าเสี่ยง`;
      }
    }
    // News event gate: block around high-impact scheduled events so the desk
    // isn't holding a scalp through a CPI/FOMC spike. Pulse feeds the cache.
    {
      const nc = readNewsCache();
      const newsBlock = newsGateDecide({
        events: nc.events, nowMs: Date.now(), gate: c.newsGate,
        cacheOk: nc.ok, cacheMtimeMs: nc.mtimeMs, cacheUpdatedMs: nc.updatedMs,
      });
      if (newsBlock) return newsBlock;
    }
    // Setup grade: only A/B.
    if (rules.requireSetupGrade && o.grade) {
      const min = rules.requireSetupGrade;
      const order = { A: 3, B: 2, C: 1 };
      if ((order[o.grade] || 0) < (order[min] || 0))
        return `setup grade ${o.grade} ต่ำกว่าที่กำหนด (ต้อง ≥ ${min})`;
    }
    // No averaging down: if there's already a position on this symbol in the
    // same direction and it's losing, block adding to it.
    if (rules.noAveragingDown && o.symbol) {
      // Reads the authoritative exchange state. It used to read the monitor
      // loop's in-memory cache, which is EMPTY until the first tick after every
      // restart — so this guard was a silent no-op exactly when a restart had
      // just lost the desk its context.
      const cur = live.open.find((p) => p.symbol === o.symbol);
      const upnl = cur ? Number(cur.unRealizedProfit || 0) : 0;
      if (cur && upnl < 0) return `ห้ามเพิ่ม position ขาดทุน — ${o.symbol} กำลังขาดทุน $${upnl.toFixed(2)}`;
    }
    // Opt-in Copilot gate (requireCopilotApproval). Uses the unified
    // callCopilotDecision helper (correct http protocol — the old code had a
    // latent https-for-http bug that made this gate a silent no-op). Now that
    // the helper is fixed, the gate actually fires when the flag is on.
    //
    // BLOCK POLICY (เงื่อนไข #2 — option a): only a VALIDATED + FRESH NO_GO
    // blocks. A NO_GO from a placeholder/stale decision (e.g. STRATEGY_NOT_PROMOTABLE
    // or ageSec > maxAgeSec) is advisory — returned to the caller as a warning,
    // not a hard block. This prevents a permanently-broken Copilot strategy from
    // freezing the desk. Compass still reviews in the agent flow.
    // Fail-open if Copilot is unreachable (design intent — agents check in skills).
    if (c.requireCopilotApproval) {
      const co = await callCopilotDecision(4000);
      if (co && co.decision === "NO_GO") {
        const stale = co.stale === true;
        const validated = co.execution && (co.execution.capability_status === "READY" || co.execution.dispatch_available === true);
        if (!stale && validated) {
          return `Copilot NO_GO (validated + fresh · decision_id: ${co.decision_id || "?"}) — Compass ต้อง review ก่อน override`;
        }
        // Stale or placeholder NO_GO: advisory only — log + continue (don't block).
        ctx.log("binance: Copilot NO_GO advisory (stale=" + stale + ", validated=" + validated + ") — not blocking");
      }
    }
    return null;   // allowed
  }

  // --- Monitoring loop (Phase 4) -------------------------------------------
  // Polls open positions + watchlist prices on monitorMs interval. Emits
  // trade.fill when a position opens/closes, and trade.alert when unrealized
  // PnL crosses a threshold. Also relays to Telegram if a channel is up.
  // Only runs when keys are set + monitorMs > 0. State is kept in-memory
  // (a daemon restart forgets the baseline — first tick re-baselines).
  let lastPositions = {};   // symbol -> size  (sign = direction)
  let monitorTimer = null;
  let lastScan = null;       // {at, entryTf, ranked[]} — cached scan result
  let scanTimer = null;      // background scanner loop handle
  // Dedup per symbol+grade+dir, with a TTL. This used to be a SINGLE string, so
  // with two qualifying signals in one tick the key rotated and both re-fired
  // on the next tick — the mechanism behind a logged open-then-emergency-close
  // churn loop. Bounded by the allowlist size.
  const signalDedup = makeDedup({ ttlMs: 3600000 });
  // R-multiple helper: how many R is the position currently up (or down)?
  // R = favorable excursion / initial risk (entry - initialStop). Uses
  // initialStop (never the live/moved stop) so the R count is stable.
  function currentR(tp, mark) {
    if (tp.initialStop == null && tp.stop != null) tp.initialStop = tp.stop;
    const risk = Math.abs(tp.entry - (tp.initialStop != null ? tp.initialStop : tp.stop));
    if (!risk) return 0;
    const isLong = tp.side === "BUY" || tp.side === "LONG";
    const gain = isLong ? mark - tp.entry : tp.entry - mark;
    return gain / risk;
  }

  const startMonitor = () => {
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; LOOPS.monitor--; }
    const ms = cfg().monitorMs;
    if (!ms || !cfg().apiKey) return;   // off or no key
    const beInFlight = new Set();   // per-symbol BE-transition lock (no naked interleave)
    monitorTimer = setInterval(async () => {
      if (disposed) return;
      const c = cfg();
      if (!c.apiKey) return;
      // Positions: detect open/close transitions.
      try {
        const pr = await req("GET", "/fapi/v2/positionRisk", null, true);
        if (pr.ok && Array.isArray(pr.json)) {
          // Stop-coverage + ownership reconciliation. Skipped entirely when
          // nothing is open, so a flat desk pays no extra API calls.
          const openNow = pr.json.filter((p) => Math.abs(Number(p.positionAmt) || 0) > 0);
          try { await reconcile(openNow); }
          catch (e) { ctx.log("binance: reconcile failed: " + e.message); }
          const now = {};
          for (const p of pr.json) {
            const amt = Number(p.positionAmt);
            if (amt === 0) continue;
            const sym = p.symbol;
            now[sym] = { size: amt, entry: Number(p.entryPrice), mark: Number(p.markPrice),
              pnl: Number(p.unRealizedProfit) };
            const was = lastPositions[sym];
            if (!was) {
              // Newly opened.
              const side = amt > 0 ? "LONG" : "SHORT";
              const msg = tgAlert({
                kind: "open", title: `${sym} · ${side} ${Math.abs(amt)}`,
                rows: [
                  { label: "Entry", value: "$" + fmtPrice(Number(p.entryPrice)) },
                  { label: "PnL", value: fmtUsd(Number(p.unRealizedProfit)) },
                ],
                footer: "position opened · testnet",
              });
              ctx.broadcast({ type: "trade.fill", plugin: "binance", symbol: sym, side, size: Math.abs(amt), entry: Number(p.entryPrice) });
              ctx.feed(msg, "blitz");
              try { ctx.relay(msg); } catch {}
            }
          }
          // Detect closes: symbols that were open but are gone now.
          for (const [sym, was] of Object.entries(lastPositions)) {
            if (!now[sym] && was.size) {
              const msg = tgAlert({
                kind: "close", title: `${sym} · Position Closed`,
                rows: [
                  { label: "เคย", value: `${was.size > 0 ? "LONG" : "SHORT"} ${Math.abs(was.size)}` },
                ],
                footer: "closed on exchange · testnet",
              });
              ctx.broadcast({ type: "trade.fill", plugin: "binance", symbol: sym, closed: true });
              ctx.feed(msg, "blitz");
              try { ctx.relay(msg); } catch {}
            }
          }
          lastPositions = now;

          // --- Position manager: auto-exit (scalping) or trend management. ---
          // Scalping path: target → trail (from tick 1) → time-stop (flat close).
          // Trend path: breakeven@1R → partial TP@2R → trail (after activate) →
          //   full close on trail hit. The Binance STOP_MARKET handles the initial
          //   stop-loss; this layer manages the upside (breakeven, partials, trailing).
          const pm = c.posManage || {};
          const tr3 = c.trendRules || {};
          const tracked = readPos();
          for (const tp of tracked) {
            // Re-checked per position, not just per tick: dispose() can land
            // between two positions' awaits, and everything below this line
            // (breakeven re-place, partial TP, trail close) writes real orders.
            if (disposed) break;
            // Adopted positions are WATCHED, never managed. The desk did not
            // plan them, so it has no stop, no target and no idea what the
            // human intended — it only checks their coverage and reports.
            if (tp.managed === false) continue;
            const live = now[tp.symbol];   // may be undefined if Binance closed it (stop hit)
            const mark = live ? live.mark : null;
            // If the position is gone from Binance (stop filled, or manual close),
            // sync the store + log the exit.
            if (!live) {
              removePos(tp.symbol);
              audit({ cmd: "exit", symbol: tp.symbol, kind: "stop-or-manual", entry: tp.entry, exitPrice: tp.maxFavorable });
              ctx.broadcast({ type: "trade.exit", plugin: "binance", symbol: tp.symbol, kind: "stop" });
              // Alert on close: this path (stop hit / external close) previously only hit the
              // dashboard and skipped Telegram — the gap behind "no phone alert on exit".
              const xmsg = tgAlert({
                kind: "close", title: `${tp.symbol} · Position Closed`,
                rows: [
                  { label: "Side", value: (tp.side === "BUY" || tp.side === "LONG") ? "LONG" : "SHORT" },
                  { label: "Entry", value: "$" + fmtPrice(tp.entry) },
                ],
                footer: "ปิดที่ exchange (stop/manual) · testnet",
              });
              ctx.feed(xmsg.replace(/<[^>]+>/g, ""), "blitz");
              try { ctx.relay(xmsg); } catch {}
              continue;
            }
            const isLong = tp.side === "BUY" || tp.side === "LONG";
            // Update maxFavorable (the best price since entry) for trailing.
            const favorable = isLong ? mark > tp.maxFavorable : mark < tp.maxFavorable;
            if (favorable) tp.maxFavorable = mark;

            // ---- TREND path: breakeven + partial + trailing ----
            if (!c.scalping && tr3.riskPct != null) {
              const r = currentR(tp, mark);
              // 1. Breakeven: move the exchange STOP_MARKET to entry+buffer at +1R (once).
              if (!tp.breakevenMoved && tr3.breakevenTriggerR > 0 && r >= tr3.breakevenTriggerR && !beInFlight.has(tp.symbol)) {
                beInFlight.add(tp.symbol);
                try {
                const stopSide = isLong ? "SELL" : "BUY";
                const buf = tr3.breakevenBuffer || 0.001;   // tiny buffer above entry to cover fees
                const bePrice = isLong ? tp.entry * (1 + buf) : tp.entry * (1 - buf);
                // closePosition stops can't coexist on the same symbol/direction (demo-fapi -4130),
                // so cancel the existing stop FIRST, then place the breakeven stop. If placement
                // fails, re-place the ORIGINAL so the position is never left unprotected.
                try { await cancelStopAlgos(tp.symbol); } catch {}
                const beRes = await placeStopAlgo(tp.symbol, stopSide, bePrice);
                if (!beRes.ok) {
                  if (!tp._beFailLogged) { tp._beFailLogged = true; try { console.log(`[BE-FAIL] ${tp.symbol} side=${stopSide} trigger=${Number(bePrice).toFixed(2)} status=${beRes.status} resp=${JSON.stringify(beRes.resp)}`); } catch {} }
                  // Re-place the original stop. A -4130 here means the original was never cancelled →
                  // the position is STILL protected (not naked), so don't cry wolf.
                  const canRestore = typeof tp.stop === "number" && isFinite(tp.stop);
                  const restore = canRestore ? await placeStopAlgo(tp.symbol, stopSide, tp.stop) : { ok: false, resp: { code: 0 } };
                  const stillProtected = restore.ok || (restore.resp && restore.resp.code === -4130);
                  if (!tp._beAlerted) {
                    tp._beAlerted = true;
                    if (stillProtected) {
                      ctx.feed(`⚠️ ${tp.symbol} BE stop วางไม่ติด — stop เดิมยังคุ้มครองอยู่ (retry รอบหน้า)`, "blitz");
                    } else {
                      const emsg = `🚨 ${tp.symbol} BE ล้ม + stop เดิมหลุด — position อาจไม่มี stop, ตรวจด่วน`;
                      ctx.feed(emsg, "compass");
                      try { ctx.relay(emsg); } catch {}
                    }
                  }
                } else {
                  tp._beFailLogged = false; tp._beAlerted = false;
                  tp.breakevenMoved = true;
                  tp.stop = bePrice;
                  const beMsg = `🛡️ ${tp.symbol} ย้าย SL → breakeven ($${fmtPrice(bePrice)}) @ +${r.toFixed(1)}R`;
                  ctx.broadcast({ type: "trade.alert", plugin: "binance", kind: "breakeven", symbol: tp.symbol, price: bePrice });
                  ctx.feed(beMsg, "blitz");
                  try { ctx.relay(beMsg); } catch {}
                }
                } finally { beInFlight.delete(tp.symbol); }
              }
              // 2. Partial TP: close partialTpPct% at +partialTpR (once).
              if (!tp.partialTaken && tr3.partialTpR > 0 && tr3.partialTpPct > 0 && r >= tr3.partialTpR) {
                const closeSide = isLong ? "SELL" : "BUY";
                // stepSize-aware floor (same fix as entry sizing). reduceOnly closes skip the
                // minNotional check — only enforce minQty so a sub-minimum partial is skipped
                // (position stays whole; trail/stop layers still manage it).
                const pFlt = await symbolFilters(tp.symbol);
                const partQty = quantizeQty(Math.abs(live.size) * (tr3.partialTpPct / 100), pFlt ? pFlt.stepSize : 0);
                if (partQty > 0 && !(pFlt && partQty < pFlt.minQty)) {
                  const pr = await req("POST", "/fapi/v1/order",
                    { symbol: tp.symbol, side: closeSide, type: "MARKET", quantity: String(partQty), reduceOnly: "true", newClientOrderId: makeClientOrderId("xp", Date.now()) }, true);
                  if (pr.ok) {
                    tp.partialTaken = true;
                    const partialPnl = (isLong ? mark - tp.entry : tp.entry - mark) * partQty;
                    audit({ cmd: "exit", symbol: tp.symbol, kind: "partial", entry: tp.entry, exitPrice: mark, pnl: Math.round(partialPnl * 1e6) / 1e6, qty: partQty, ok: true });
                    journalLine({ ...tp, qty: partQty }, mark, "partial", partialPnl);
                    ctx.broadcast({ type: "trade.exit", plugin: "binance", symbol: tp.symbol, kind: "partial", price: mark, pnl: partialPnl, qty: partQty });
                    const pmsg = tgAlert({
                      kind: "exit", title: `${tp.symbol} · 🎯 Partial TP`,
                      rows: [
                        { label: "ปิด", value: `${partQty} (${tr3.partialTpPct}%)` },
                        { label: "@", value: `+${r.toFixed(1)}R · $${fmtPrice(mark)}` },
                        { label: "PnL", value: fmtUsd(partialPnl), accent: "✅" },
                      ],
                      footer: `ที่เหลือปล่อยวิ่ง · trail ${tr3.trailPct}%`,
                    });
                    ctx.feed(pmsg.replace(/<[^>]+>/g, ""), "blitz");
                    try { ctx.relay(pmsg); } catch {}
                  }
                }
              }
              // 3. Trailing: only after trailActivateR reached. Trail trailPct% off
              //    the peak, but never below breakeven (lock profit).
              if (r >= (tr3.trailActivateR || 0) && tr3.trailPct > 0) {
                const trailStop = isLong
                  ? tp.maxFavorable * (1 - tr3.trailPct / 100)
                  : tp.maxFavorable * (1 + tr3.trailPct / 100);
                // Enforce: trail stop ≥ breakeven (if moved).
                const floor = tp.breakevenMoved ? tp.stop : null;
                const effStop = (floor != null)
                  ? (isLong ? Math.max(trailStop, floor) : Math.min(trailStop, floor))
                  : trailStop;
                if ((isLong && mark <= effStop) || (!isLong && mark >= effStop)) {
                  // Trail hit → close the runner.
                  const closeSide = isLong ? "SELL" : "BUY";
                  const cr = await req("POST", "/fapi/v1/order",
                    { symbol: tp.symbol, side: closeSide, type: "MARKET", quantity: String(Math.abs(live.size)), reduceOnly: "true", newClientOrderId: makeClientOrderId("xt", Date.now()) }, true);
                  const out = exitOutcome({ orderOk: cr.ok, avgPrice: cr.json && cr.json.avgPrice, mark });
                  if (!out.shouldRemove) { recordExitFailure(tp, "trail", cr); continue; }
                  const exitPx = out.exitPrice;
                  const pnl = (isLong ? exitPx - tp.entry : tp.entry - exitPx) * Math.abs(live.size);
                  audit({ cmd: "exit", symbol: tp.symbol, kind: "trail", entry: tp.entry, exitPrice: exitPx, pnl: Math.round(pnl * 1e6) / 1e6, ok: true, pnlSource: out.pnlSource });
                  removePos(tp.symbol);
                  journalLine(tp, exitPx, "trail", pnl);
                  const tmsg = tgAlert({
                    kind: "exit", title: `${tp.symbol} · 🔁 Trailing Stop`,
                    rows: [
                      { label: "Side", value: isLong ? "LONG" : "SHORT" },
                      { label: "Entry", value: "$" + fmtPrice(tp.entry) },
                      { label: "Exit", value: "$" + fmtPrice(mark) },
                      { label: "PnL", value: fmtUsd(pnl), accent: pnl >= 0 ? "✅ กำไร" : "❌ ขาดทุน" },
                    ],
                    footer: `trail · peak $${fmtPrice(tp.maxFavorable)} · qty ${tp.qty}`,
                  });
                  ctx.broadcast({ type: "trade.exit", plugin: "binance", symbol: tp.symbol, kind: "trail", price: mark, pnl });
                  ctx.feed(tmsg.replace(/<[^>]+>/g, ""), "blitz");
                  try { ctx.relay(tmsg); } catch {}
                  continue;
                }
              }
              // No exit this tick — persist updated state (breakevenMoved, partialTaken, maxFavorable).
              upsertPos(tp);
              continue;
            }

            // ---- SCALPING path (original): target → trail → time-stop ----
            let exitKind = null;
            // 1. Target hit → take profit.
            if (tp.target) {
              if ((isLong && mark >= tp.target) || (!isLong && mark <= tp.target)) exitKind = "target";
            }
            // 2. Trailing stop: price gave back trailPct% from the best.
            if (!exitKind && tp.trailPct > 0) {
              const trailStop = isLong
                ? tp.maxFavorable * (1 - tp.trailPct / 100)
                : tp.maxFavorable * (1 + tp.trailPct / 100);
              if ((isLong && mark <= trailStop) || (!isLong && mark >= trailStop)) exitKind = "trail";
            }
            // 3. Time-stop: scalp went nowhere past the limit.
            if (!exitKind && pm.timeStopMin > 0) {
              const ageMin = (Date.now() - tp.openedAt) / 60000;
              if (ageMin >= pm.timeStopMin) exitKind = "time";
            }
            if (exitKind) {
              // Close at market (opposite side).
              const closeSide = isLong ? "SELL" : "BUY";
              const cr = await req("POST", "/fapi/v1/order",
                { symbol: tp.symbol, side: closeSide, type: "MARKET", quantity: String(Math.abs(live.size)), reduceOnly: "true", newClientOrderId: makeClientOrderId("xt", Date.now()) }, true);
              const out = exitOutcome({ orderOk: cr.ok, avgPrice: cr.json && cr.json.avgPrice, mark });
              if (!out.shouldRemove) { recordExitFailure(tp, exitKind, cr); continue; }
              const exitPx = out.exitPrice;
              const pnl = (isLong ? exitPx - tp.entry : tp.entry - exitPx) * Math.abs(live.size);
              audit({ cmd: "exit", symbol: tp.symbol, kind: exitKind, entry: tp.entry, exitPrice: exitPx, pnl: Math.round(pnl * 1e6) / 1e6, ok: true, pnlSource: out.pnlSource });
              removePos(tp.symbol);
              journalLine(tp, exitPx, exitKind, pnl);
              const exitKindLabel = { target: "🎯 Take Profit", trail: "🔁 Trailing Stop", time: "⏰ Time Stop", manual: "✋ Manual" }[exitKind] || exitKind;
              const msg = tgAlert({
                kind: "exit", title: `${tp.symbol} · ${exitKindLabel}`,
                rows: [
                  { label: "Side", value: (tp.side === "BUY" || tp.side === "LONG") ? "LONG" : "SHORT" },
                  { label: "Entry", value: "$" + fmtPrice(tp.entry) },
                  { label: "Exit", value: "$" + fmtPrice(mark) },
                  { label: "PnL", value: fmtUsd(pnl), accent: pnl >= 0 ? "✅ กำไร" : "❌ ขาดทุน" },
                ],
                footer: `${exitKind} · qty ${tp.qty} · ${tp.source || "manual"}`,
              });
              ctx.broadcast({ type: "trade.exit", plugin: "binance", symbol: tp.symbol, kind: exitKind, price: mark, pnl });
              ctx.feed(msg, "blitz");
              try { ctx.relay(msg); } catch {}
            } else {
              // Persist the updated maxFavorable.
              upsertPos(tp);
            }
          }
        }
        // Shadow ledger resolution. One un-symboled premiumIndex call covers
        // every shadow position at once, and it is skipped entirely when the
        // ledger is empty — so this costs nothing until shadow mode is on and
        // has actually fired.
        try {
          const sq = shadowPos();
          const openShadow = sq.filter((x) => !x.closedAt);
          if (openShadow.length) {
            const mk = await req("GET", "/fapi/v1/premiumIndex", null, false);
            const marks = {};
            if (mk.ok && Array.isArray(mk.json))
              for (const m of mk.json) marks[m.symbol] = Number(m.markPrice);
            let dirty = false;
            for (const sp of openShadow) {
              const mark = marks[sp.symbol];
              if (!(mark > 0)) continue;
              const isLong = sp.side === "BUY";
              const fav = isLong ? mark > sp.maxFavorable : mark < sp.maxFavorable;
              if (fav) { sp.maxFavorable = mark; dirty = true; }
              const stopHit = isLong ? mark <= sp.stop : mark >= sp.stop;
              const targetHit = sp.target ? (isLong ? mark >= sp.target : mark <= sp.target) : false;
              if (stopHit || targetHit) {
                sp.closedAt = Date.now();
                sp.exitPrice = mark;
                sp.exitKind = stopHit ? "stop" : "target";
                const risk = Math.abs(sp.entry - sp.stop);
                sp.pnlR = risk > 0 ? ((isLong ? mark - sp.entry : sp.entry - mark) / risk) : null;
                dirty = true;
                audit({ cmd: "auto-signal-shadow-exit", symbol: sp.symbol, kind: sp.exitKind,
                        entry: sp.entry, exitPrice: mark, pnlR: sp.pnlR, grade: sp.grade });
                ctx.feed(`👻 SHADOW ปิด ${sp.symbol} ${sp.exitKind} @ ${fmtPrice(mark)} = ${sp.pnlR == null ? "?" : sp.pnlR.toFixed(2)}R`, "sigma");
              }
            }
            if (dirty) writeShadow(sq);
          }
        } catch (e) { ctx.log("binance: shadow resolve failed: " + e.message); }

        // Drawdown breaker, evaluated on every tick — not only when a new entry
        // is attempted. An open runner can bleed straight through the limit
        // while the entry-side check never runs, because no entry is attempted.
        try {
          const dl = await dailyLossCheck({ trip: true });
          if (!dl.evaluable) {
            HEALTH.dailyLossUnevaluable = (HEALTH.dailyLossUnevaluable || 0) + 1;
            if (HEALTH.dailyLossUnevaluable === 10) {
              const m = "⚠️ ประเมิน daily-loss limit ไม่ได้ 10 รอบติด (อ่าน PnL จาก exchange ไม่สำเร็จ) — เบรกเกอร์ตาบอดอยู่";
              ctx.feed(m, "compass"); try { ctx.relay(m); } catch {}
            }
          } else HEALTH.dailyLossUnevaluable = 0;
        } catch (e) { ctx.log("binance: dailyLossCheck in monitor failed: " + e.message); }

        // Only a FULLY successful tick counts as alive. Setting this at the top
        // would make a loop that throws every single tick look healthy.
        HEALTH.lastOkTickAt = Date.now();
        HEALTH.consecutiveTickErrors = 0;
      } catch (e) {
        // This used to be a bare `catch {}` — a persistent throw was completely
        // silent and looked exactly like a quiet market.
        HEALTH.consecutiveTickErrors++;
        HEALTH.lastTickErrorAt = Date.now();
        HEALTH.lastTickError = e && e.message ? e.message : String(e);
        ctx.log("binance: monitor tick error (#" + HEALTH.consecutiveTickErrors + "): " + HEALTH.lastTickError);
        auditNoise({ cmd: "monitor-error", err: HEALTH.lastTickError, streak: HEALTH.consecutiveTickErrors });
        // Page once at 3 in a row, then hourly — enough to notice, not enough to mute.
        if (HEALTH.consecutiveTickErrors === 3 || (HEALTH.consecutiveTickErrors > 3 &&
            Date.now() - (HEALTH.lastTickErrorAlertAt || 0) > 3600000)) {
          HEALTH.lastTickErrorAlertAt = Date.now();
          const m = `🚨 monitor loop พังต่อเนื่อง ${HEALTH.consecutiveTickErrors} รอบ — ไม้ที่เปิดอยู่ไม่ถูกจัดการ\n(${HEALTH.lastTickError})`;
          ctx.feed(m, "compass"); try { ctx.relay(m); } catch {}
        }
      }
    }, ms);
    LOOPS.monitor++;
    ctx.log("binance: monitor loop started (" + ms + "ms, live loops: " + LOOPS.monitor + ")");
  };
  startMonitor();

  // --- Scanner loop (background) -------------------------------------------
  // Sweeps the watchlist on scanIntervalMs, computes TA in CODE, and broadcasts
  // a signal only when a NEW A/B-graded opportunity appears (dedup by
  // symbol+grade+dir). Advisory — never places orders itself.
  const startScanner = () => {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; LOOPS.scanner--; }
    const c = cfg();
    const ms = c.scanIntervalMs || 0;
    if (!ms || !c.apiKey) return;
    scanTimer = setInterval(async () => {
      if (disposed) return;
      try {
        const cc = cfg();
        if (!cc.apiKey) return;
        const entryTf = cc.entryTf || (cc.scalping ? "3m" : "1h");
        const ctxTf = cc.contextTf || "15m";
        const trS = cc.trendRules || {};
        const taOpts = cc.scalping
          ? { stopMult: (cc.scalpingRules || {}).atrStopMult || 1.5, fixedTargetR: 1.8 }
          : { stopMult: trS.atrStopMult || 2, fixedTargetR: trS.fixedTargetR || 0 };
        const syms = cc.allowedSymbols || ["BTCUSDT"];
        const results = await Promise.all(syms.map((s) => analyzeSymbol(s, req, entryTf, ctxTf, taOpts).catch(() => null)));
        const ranked = results.filter(Boolean).sort((a, b) => b.score - a.score);
        lastScan = { at: Date.now(), entryTf, ranked };
        // Broadcast new A/B signals (dedup so the same setup isn't spammed).
        for (const r of ranked) {
          if (r.grade !== "A" && r.grade !== "B") continue;
          const key = `${r.symbol}:${r.grade}:${r.dir}`;
          if (!signalDedup.fresh(key, Date.now())) continue;   // already announced this exact setup
          const dirArrows = r.dir === "bull" ? "LONG 📈" : "SHORT 📉";
          const targetLabel = r.target ? "$" + fmtPrice(r.target) : "ปล่อยวิ่ง";
          const msg = tgAlert({
            kind: "signal", title: `${r.symbol} · Grade ${r.grade}`,
            rows: [
              { label: "ทิศทาง", value: dirArrows },
              { label: "Entry", value: "$" + fmtPrice(r.entry) },
              { label: "Stop", value: "$" + fmtPrice(r.stop) },
              { label: "Target", value: targetLabel },
              { label: "Signal", value: r.signals.join(", ") || "—" },
            ],
            footer: `grade ${r.grade} · score ${r.score} · ${entryTf} ${cc.scalping ? "scalp" : "trend"}`,
          });
          ctx.broadcast({ type: "scan.signal", plugin: "binance", symbol: r.symbol, grade: r.grade, dir: r.dir,
            entry: r.entry, stop: r.stop, target: r.target, signals: r.signals });
          ctx.feed(msg.replace(/<[^>]+>/g, ""), "scout");
          // scan signals stay on the overlay/dashboard only — NOT relayed to Telegram
          // (was phone spam every scan as price drifts, and it buried real trade alerts).
          // Closed-loop: if the owner enabled autoTradeSignal, place the trade
          // directly from the signal (through the full guard — same as autotrade).
          if (cc.autoTradeSignal || cc.autoTradeSignalShadow) {
            try {
              const res = await executeAutoSignal(r);
              if (res.blocked) {
                const bm = `🚫 signal ${r.symbol} ถูก block: ${res.blocked}`;
                ctx.feed(bm, "compass");
                auditNoise({ cmd: "auto-signal-blocked", symbol: r.symbol, grade: r.grade, blocked: res.blocked });
              }
            } catch (e) { ctx.log("binance: auto-signal error: " + e.message); }
          }
        }
      } catch (e) { ctx.log("binance: scan loop error: " + e.message); }
    }, ms);
    LOOPS.scanner++;
    ctx.log("binance: scanner loop started (" + ms + "ms, live loops: " + LOOPS.scanner + ")");
  };
  startScanner();

  return {
    onCommand(cmd, args, reply, payload) {
      // Panel-only config command (not advertised to agents): write keys +
      // settings. Agents never see this because it's not in manifest.commands.
      if (cmd === "setkeys") {
        const p = payload || {};
        const patch = {};
        if (typeof p.apiKey === "string") patch.apiKey = p.apiKey.trim();
        if (typeof p.apiSecret === "string") patch.apiSecret = p.apiSecret.trim();
        if (typeof p.testnet === "boolean") patch.testnet = p.testnet;
        if (Array.isArray(p.allowedSymbols)) patch.allowedSymbols = p.allowedSymbols;
        if (typeof p.tradeEnabled === "boolean") patch.tradeEnabled = p.tradeEnabled;
        if (typeof p.maxNotionalPct === "number") patch.maxNotionalPct = p.maxNotionalPct;
        if (typeof p.maxLeverage === "number") patch.maxLeverage = p.maxLeverage;
        if (typeof p.leverageDefault === "number") patch.leverageDefault = p.leverageDefault;
        if (typeof p.maxConcurrentPositions === "number") patch.maxConcurrentPositions = p.maxConcurrentPositions;
        if (typeof p.marginCapPct === "number") patch.marginCapPct = p.marginCapPct;
        if (typeof p.dailyLossPct === "number") patch.dailyLossPct = p.dailyLossPct;
        if (typeof p.autoTrade === "boolean") patch.autoTrade = p.autoTrade;
        if (typeof p.autoTradeSignal === "boolean") patch.autoTradeSignal = p.autoTradeSignal;
        if (typeof p.tradePaused === "boolean") patch.tradePaused = p.tradePaused;
        if (typeof p.officePauseToken === "string") patch.officePauseToken = p.officePauseToken.trim();
        if (typeof p.monitorMs === "number") patch.monitorMs = p.monitorMs;
        if (p.autoTradeRules && typeof p.autoTradeRules === "object") patch.autoTradeRules = p.autoTradeRules;
        const c = saveCfg(patch);
        // Restart the monitor loop if its interval changed.
        if (typeof p.monitorMs === "number") startMonitor();
        ctx.broadcast({ type: "plugin.event", plugin: "binance", event: "config" });
        // Never echo the secret back.
        return reply({ ok: true, testnet: c.testnet, hasKey: !!c.apiKey, hasSecret: !!c.apiSecret,
          tradeEnabled: c.tradeEnabled, autoTrade: c.autoTrade, autoTradeSignal: c.autoTradeSignal,
          scalping: c.scalping, tradePaused: c.tradePaused, hasPauseToken: !!c.officePauseToken,
          allowedSymbols: c.allowedSymbols, maxNotionalPct: c.maxNotionalPct, maxLeverage: c.maxLeverage,
          monitorMs: c.monitorMs, scanIntervalMs: c.scanIntervalMs, autoTradeRules: c.autoTradeRules });
      }

      if (cmd === "status") {
        const c = cfg();
        const base = c.testnet ? URLS.testnet : URLS.mainnet;
        return (async () => {
          // Ping the public time endpoint to confirm reachability without keys.
          const r = await req("GET", "/fapi/v1/ping");
          const tr = c.trendRules || {};
          const equity = c.simulatedEquity || await accountEquity();
          const notionalCap = equity * (c.maxNotionalPct || 0) / 100;
          // Day PnL% off the same equity base (best-effort — needs keys).
          let dayPnlUsd = null, dayPnlPct = null;
          try { const { realized, unreal } = await dailyPnl(); dayPnlUsd = usd2(realized + unreal); dayPnlPct = pct2((realized + unreal) / equity * 100); } catch {}
          const lossPct = c.scalping ? (c.scalpingRules || {}).dailyLossPct : (c.dailyLossPct || 2);
          reply({
            ok: r.ok, reachable: r.ok,
            environment: c.testnet ? "TESTNET" : "MAINNET",
            baseUrl: base,
            hasKey: !!c.apiKey, hasSecret: !!c.apiSecret,
            tradeEnabled: c.tradeEnabled, autoTrade: c.autoTrade, autoTradeSignal: c.autoTradeSignal,
            scalping: c.scalping, tradePaused: c.tradePaused, hasPauseToken: !!c.officePauseToken,
            allowedSymbols: c.allowedSymbols,
            maxNotionalPct: c.maxNotionalPct, notionalCapUsd: usd2(notionalCap), equityBase: usd2(equity),
            riskPct: tr.riskPct, riskPctMax: tr.riskPctMax, riskPctMaxGradeA: tr.riskPctMaxGradeA,
            maxLeverage: c.maxLeverage, dynamicLeverage: c.dynamicLeverage, dailyLossPct: lossPct, dayPnlUsd, dayPnlPct,
            monitorMs: c.monitorMs, scanIntervalMs: c.scanIntervalMs,
            pingStatus: r.status, pingError: r.error,
          });
        })().catch((e) => reply({ ok: false, msg: "status error: " + e.message }));
      }

      // pause [on|off] [reason] — toggle the kill-switch from the office panel
      // or chat. No token needed (the panel is already trusted); the token gate
      // only applies to the HTTP /pause route used by the external dashboard.
      if (cmd === "pause") {
        const parts = String(args || "").trim().split(/\s+/);
        const c = cfg();
        let paused;
        if (parts[0] === "on") paused = true;
        else if (parts[0] === "off") paused = false;
        else paused = !c.tradePaused;   // bare "pause" = toggle
        const reason = parts.slice(parts[0] === "on" || parts[0] === "off" ? 1 : 0).join(" ") || "manual toggle";
        return reply(setPause(paused, "office-panel", reason));
      }

      if (cmd === "price") {
        const symbol = String(args || "").trim().toUpperCase();
        if (!symbol) return reply({ ok: false, msg: "usage: price <symbol>  เช่น price BTCUSDT" });
        return req("GET", "/fapi/v1/ticker/price", { symbol }).then((r) => {
          if (!r.ok) return reply({ ok: false, status: r.status, error: r.json && r.json.msg ? r.json.msg : r.body });
          reply({ ok: true, symbol: r.json.symbol, price: Number(r.json.price) });
        });
      }

      if (cmd === "ticker") {
        const symbol = String(args || "").trim().toUpperCase();
        if (!symbol) return reply({ ok: false, msg: "usage: ticker <symbol>  เช่น ticker BTCUSDT" });
        return req("GET", "/fapi/v1/ticker/24hr", { symbol }).then((r) => {
          if (!r.ok) return reply({ ok: false, status: r.status, error: r.json && r.json.msg ? r.json.msg : r.body });
          const t = r.json;
          reply({
            ok: true, symbol: t.symbol,
            last: Number(t.lastPrice), changePct: Number(t.priceChangePercent),
            high: Number(t.highPrice), low: Number(t.lowPrice),
            volume: Number(t.volume), quoteVolume: Number(t.quoteVolume),
          });
        });
      }

      if (cmd === "balance") {
        return req("GET", "/fapi/v2/balance", null, true).then((r) => {
          if (!r.ok) return reply({ ok: false, status: r.status, error: r.error || (r.json && r.json.msg) || r.body });
          // Only show assets with a non-zero balance — testnet has many dust rows.
          const rows = (Array.isArray(r.json) ? r.json : []).map(fmtBal).filter((b) => b.balance !== 0);
          reply({ ok: true, environment: cfg().testnet ? "TESTNET" : "MAINNET", count: rows.length, balances: rows });
        });
      }

      if (cmd === "positions") {
        return (async () => {
          const c = cfg();
          const r = await req("GET", "/fapi/v2/positionRisk", null, true);
          if (!r.ok) return reply({ ok: false, status: r.status, error: r.error || (r.json && r.json.msg) || r.body });
          const equity = c.simulatedEquity || await accountEquity();
          const tracked = readPos();
          const rows = (Array.isArray(r.json) ? r.json : []).map(fmtPos).filter((p) => p.size > 0).map((p) => {
            const notional = p.size * p.mark;
            // Risk-at-stop% needs a stop; positionRisk carries none, so join with
            // the tracked position. Null when the position isn't tracked w/ a stop.
            const t = tracked.find((x) => x.symbol === p.symbol);
            const stop = t ? (t.stop != null ? t.stop : t.initialStop) : null;
            const riskUsd = stop != null ? Math.abs(p.entry - stop) * p.size : null;
            return {
              ...p,
              uPnlPct: pct2(p.pnl / equity * 100),
              exposurePct: pct2(notional / equity * 100),
              riskAtStopPct: riskUsd != null ? pct2(riskUsd / equity * 100) : null,
            };
          });
          let dayPnlUsd = null, dayPnlPct = null;
          try { const { realized, unreal } = await dailyPnl(); dayPnlUsd = usd2(realized + unreal); dayPnlPct = pct2((realized + unreal) / equity * 100); } catch {}
          reply({
            ok: true, environment: c.testnet ? "TESTNET" : "MAINNET",
            equityBase: usd2(equity), count: rows.length, positions: rows,
            exposurePctTotal: pct2(rows.reduce((s, p) => s + (p.exposurePct || 0), 0)),
            uPnlPctTotal: pct2(rows.reduce((s, p) => s + (p.uPnlPct || 0), 0)),
            dayPnlUsd, dayPnlPct,
          });
        })().catch((e) => reply({ ok: false, msg: "positions error: " + e.message }));
      }

      // --- Trading commands. All go through tradeGuard first, then hit the
      // signed /fapi/v1/order endpoint, then audit-log the result. ----------

      // order MARKET:  order BTCUSDT BUY 0.001         (explicit qty)
      // order LIMIT:   order BTCUSDT BUY 0.001 @60000  (explicit qty @price)
      // %-risk MARKET: order BTCUSDT BUY risk 59700    (qty auto from 0.5% risk / stop)
      // %-risk LIMIT:  order BTCUSDT BUY risk 59700 @60000
      // "SELL" opens/closes a SHORT; the same endpoint handles both directions
      // in hedge-off mode (the testnet default).
      if (cmd === "order") {
        const o = parseOrderArgs(args);
        if (!o) return reply({ ok: false, msg: 'usage: order <SYMBOL> <BUY|SELL> <qty> [@price]  หรือ  order <SYMBOL> <BUY|SELL> risk <stopPrice> [@entryPrice]   เช่น order BTCUSDT BUY 0.001  |  order BTCUSDT BUY risk 59700' });
        return (async () => {
          // Latest price for the cap check + as the default entry for %-sizing.
          const pr = await req("GET", "/fapi/v1/ticker/price", { symbol: o.symbol });
          const price = pr.ok ? Number(pr.json.price) : 0;
          let qty = o.qty, sizing = null;
          if (o.mode === "risk") {
            // Same equation as autotrade/auto-signal: qty = equity×risk%/stopDist,
            // trimmed to the notional backstop, floored to stepSize, gates enforced.
            if (!price) return reply({ ok: false, msg: "ดึงราคาไม่ได้ — ยกเลิก order (ต้องมีราคาไว้คำนวณ %-size)" });
            const entry = o.price || price;
            const sized = await sizeByRisk({ symbol: o.symbol, entry, stop: o.stop, riskPct: o.riskPct });
            if (sized.blocked) { audit({ cmd: "order", ...o, blocked: sized.blocked }); return reply({ ok: false, blocked: true, msg: sized.blocked }); }
            qty = sized.qty;
            sizing = { mode: "risk", riskPct: sized.riskPct, riskUsd: usd2(sized.riskUsd), stopDist: sized.stopDist,
              entry, notional: usd2(sized.notional), notionalCap: usd2(sized.notionalCap), capped: sized.capped, equity: usd2(sized.equity) };
          }
          const usdValue = (o.price || price) * qty;
          const block = tradeGuard({ symbol: o.symbol, usdValue });
          if (block) { audit({ cmd: "order", ...o, qty, usdValue, blocked: block }); return reply({ ok: false, blocked: true, msg: block }); }
          // Dynamic leverage guardrail preview (Option B) — only when a stop is
          // known (explicit-qty orders with no stop can't be gated by stop width).
          const entryForLev = o.price || price;
          const levPreview = leverageGuard({ entry: entryForLev, stop: o.stop, requestedLev: null });
          // Portfolio margin HARD CAP (Framework B): worst-case total margin must
          // stay ≤ marginCapPct% of equity — the book can never touch 100%. Same
          // effective leverage the exchange will lock (from the tier table above).
          const mLevManual = levPreview.skipped ? (cfg().leverageDefault || 3) : levPreview.effLev;
          const marginChk = await marginGuard({ notional: usdValue, effLev: mLevManual });
          // dry / preview: return the computed sizing + leverage + margin WITHOUT
          // placing. Passes through the same price + sizeByRisk + tradeGuard path.
          if (o.dry) {
            auditNoise({ cmd: "order-dry", symbol: o.symbol, side: o.side, qty, usdValue, sizing, leverage: levPreview, margin: marginChk });
            const levMsg = levPreview.skipped ? "" : levPreview.reject
              ? ` — ⛔ ${levPreview.reason}`
              : ` — lev ${levPreview.effLev}x (stop ${levPreview.stopPct}% → tier ${levPreview.tierLev}x, liq ~${levPreview.liqPct}% ≥ ${levPreview.liqNeededPct}%)`;
            const marginMsg = marginChk.skipped ? ""
              : marginChk.ok
                ? ` — margin ✓ รวม $${marginChk.projected} (${marginChk.projectedPct}% ≤ ${marginChk.capPct}%)`
                : ` — ⛔ ${marginChk.reason}`;
            return reply({ ok: true, dry: true, symbol: o.symbol, side: o.side,
              type: o.price ? "LIMIT" : "MARKET", qty, entry: entryForLev,
              notional: usd2(usdValue), sizing, leverage: levPreview, margin: marginChk,
              msg: `DRY (ไม่ส่ง order จริง): ${o.side} ${qty} ${o.symbol}${sizing ? ` — risk $${sizing.riskUsd} (${sizing.riskPct}%), notional $${usd2(usdValue)}${sizing.capped ? " [capped ที่ backstop]" : ""}` : `, notional $${usd2(usdValue)}`}${levMsg}${marginMsg}` });
          }
          // Live: enforce the margin hard cap BEFORE any leverage side-effect.
          if (!marginChk.ok) { audit({ cmd: "order", ...o, qty, usdValue, blocked: marginChk.reason }); return reply({ ok: false, blocked: true, msg: marginChk.reason, margin: marginChk }); }
          // Live: enforce the guardrail — set gated leverage on the exchange, or
          // block if even the lowest tier can't clear the liquidation buffer.
          // SAFETY GUARD (v0.8.1): only auto-set leverage when this is a genuinely
          // NEW position. If a position is already open on this symbol, changing
          // leverage under it retunes the margin/liquidation of the LIVE trade —
          // never touch an open position's leverage. Skip the guard (leave the
          // existing exchange leverage untouched) and record it in the audit log.
          // Auto paths (autotrade / auto-signal) don't need this — no-averaging
          // already blocks a second entry on a symbol that's already open.
          if (o.stop != null) {
            let posOpen = false;
            const prc = await req("GET", "/fapi/v2/positionRisk", { symbol: o.symbol }, true);
            if (prc.ok && Array.isArray(prc.json)) {
              const pos = prc.json.find((p) => p.symbol === o.symbol);
              posOpen = pos && Math.abs(Number(pos.positionAmt || 0)) > 0;
            }
            if (posOpen) {
              audit({ cmd: "leverage-auto", symbol: o.symbol, skipped: "position-open", note: "manual order on symbol with open position — leverage left untouched" });
            } else {
              const lg = await applyLeverageGuard(o.symbol, entryForLev, o.stop, null);
              if (!lg.ok) { audit({ cmd: "order", ...o, qty, usdValue, blocked: lg.reason }); return reply({ ok: false, blocked: true, msg: lg.reason, leverage: lg }); }
            }
          }
          const body = {
            symbol: o.symbol, side: o.side.toUpperCase(),
            type: o.price ? "LIMIT" : "MARKET",
            quantity: String(qty),
            ...(o.price ? { price: String(o.price), timeInForce: "GTC" } : {}),
            newClientOrderId: makeClientOrderId("mo", Date.now()),
          };
          const r = await req("POST", "/fapi/v1/order", body, true);
          const ok = r.ok;
          audit({ cmd: "order", ...o, qty, usdValue, price, sizing, ok, status: r.status, resp: r.json || r.body });
          if (!ok) return reply({ ok: false, status: r.status, error: (r.json && r.json.msg) || r.body });
          const j = r.json;
          reply({
            ok: true, orderId: j.orderId, status: j.status, type: j.type,
            symbol: j.symbol, side: j.side, qty: Number(j.origQty),
            price: j.price ? Number(j.price) : price,
            avgPrice: j.avgPrice ? Number(j.avgPrice) : null,
            sizing,
          });
        })().catch((e) => reply({ ok: false, msg: "order error: " + e.message }));
      }

      // close <SYMBOL>: flatten any open position on that symbol by placing a
      // market order in the opposite direction for the full position size.
      if (cmd === "close") {
        const symbol = String(args || "").trim().toUpperCase().split(/\s+/)[0];
        if (!symbol) return reply({ ok: false, msg: "usage: close <SYMBOL>   เช่น close BTCUSDT" });
        // Find the live position to know size + direction.
        return req("GET", "/fapi/v2/positionRisk", { symbol }, true).then((pr) => {
          if (!pr.ok) return reply({ ok: false, status: pr.status, error: (pr.json && pr.json.msg) || pr.body });
          const pos = (Array.isArray(pr.json) ? pr.json : [])[0];
          const amt = Number((pos && pos.positionAmt) || 0);
          if (amt === 0) return reply({ ok: false, msg: `ไม่มีสถานะเปิด ${symbol} ที่จะปิด` });
          const side = amt > 0 ? "SELL" : "BUY";   // opposite of the position
          const qty = Math.abs(amt);
          // protectiveGuard, not tradeGuard: pausing the desk must never take
          // away its ability to flatten a position.
          const block = protectiveGuard({ symbol });
          if (block) { audit({ cmd: "close", symbol, side, qty, blocked: block }); return reply({ ok: false, blocked: true, msg: block }); }
          return req("POST", "/fapi/v1/order",
            { symbol, side, type: "MARKET", quantity: String(qty), reduceOnly: "true",
              newClientOrderId: makeClientOrderId("xm", Date.now()) }, true).then((r) => {
              audit({ cmd: "close", symbol, side, qty, ok: r.ok, status: r.status, resp: r.json || r.body });
              if (!r.ok) return reply({ ok: false, status: r.status, error: (r.json && r.json.msg) || r.body });
              reply({ ok: true, orderId: r.json.orderId, status: r.json.status, msg: `ปิดสถานะ ${symbol} แล้ว (${qty} @ market)` });
            });
        });
      }

      // stoploss <SYMBOL> <triggerPrice>: place a STOP-MARKET that closes the
      // position if price crosses the trigger. Auto-detects the position side.
      // Take-profit is the same command used in the opposite direction.
      if (cmd === "stoploss") {
        const parts = String(args || "").trim().split(/\s+/);
        const symbol = (parts[0] || "").toUpperCase();
        const trigger = Number(parts[1]);
        if (!symbol || !trigger) return reply({ ok: false, msg: "usage: stoploss <SYMBOL> <triggerPrice>   เช่น stoploss BTCUSDT 60000" });
        return req("GET", "/fapi/v2/positionRisk", { symbol }, true).then((pr) => {
          if (!pr.ok) return reply({ ok: false, status: pr.status, error: (pr.json && pr.json.msg) || pr.body });
          const pos = (Array.isArray(pr.json) ? pr.json : [])[0];
          const amt = Number((pos && pos.positionAmt) || 0);
          if (amt === 0) return reply({ ok: false, msg: `ไม่มีสถานะเปิด ${symbol} — ตั้ง stop ไม่ได้` });
          const side = amt > 0 ? "SELL" : "BUY";   // stop closes the position
          // protectiveGuard: a paused desk must still be able to PROTECT an
          // open position. This was the sharpest edge of the pause deadlock.
          const block = protectiveGuard({ symbol });
          if (block) { audit({ cmd: "stoploss", symbol, trigger, blocked: block }); return reply({ ok: false, blocked: true, msg: block }); }
          return placeStopAlgo(symbol, side, trigger).then((sl) => {
            audit({ cmd: "stoploss", symbol, trigger, side, ok: sl.ok, status: sl.status, resp: sl.resp });
            if (!sl.ok) return reply({ ok: false, status: sl.status, error: (sl.resp && sl.resp.msg) || JSON.stringify(sl.resp) });
            reply({ ok: true, algoId: sl.algoId, status: "NEW", type: "STOP_MARKET",
              msg: `ตั้ง STOP-MARKET ${symbol} @ ${trigger} (ปิด ${side === "SELL" ? "LONG" : "SHORT"})` });
          });
        });
      }

      // audit: show the recent order history (panel + agents).
      if (cmd === "audit") {
        let log = [];
        try { log = JSON.parse(fs.readFileSync(auditFile, "utf8")); } catch {}
        return reply({ ok: true, count: log.length, recent: log.slice(-20).reverse() });
      }

      // newscheck — read the Pulse news cache and report whether a high-impact
      // event is near (the news gate uses the same cache). Lets agents/panel
      // see "is it safe to trade right now" without re-running the gate.
      if (cmd === "shadow") {
        // What autoTradeSignal WOULD have done. Reports the fire rate and the
        // block-reason histogram — the two things that tell the owner whether
        // unattended trading is even a big decision, before any expectancy math.
        const sq = shadowPos();
        const open = sq.filter((x) => !x.closedAt), closed = sq.filter((x) => x.closedAt);
        let blocked = [];
        try { blocked = JSON.parse(fs.readFileSync(noiseFile, "utf8")); } catch {}
        const hist = {};
        for (const b of blocked) {
          if (b.cmd !== "auto-signal-blocked") continue;
          const key = String(b.blocked || "?").split(/[:(]/)[0].trim().slice(0, 60);
          hist[key] = (hist[key] || 0) + 1;
        }
        const rs = closed.map((x) => x.pnlR).filter((v) => typeof v === "number");
        const expectancy = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
        const c2 = cfg();
        return reply({
          ok: true,
          mode: c2.autoTradeSignal ? "LIVE" : (c2.autoTradeSignalShadow ? "SHADOW" : "OFF"),
          fired: sq.length, open: open.length, closed: closed.length,
          wins: rs.filter((v) => v > 0).length, losses: rs.filter((v) => v <= 0).length,
          expectancyR: expectancy == null ? null : Math.round(expectancy * 1000) / 1000,
          note: rs.length < 30 ? `n=${rs.length} — เล็กเกินกว่าจะสรุป expectancy ได้` : null,
          blockedHistogram: hist,
          positions: sq.slice(-20),
          text: `👻 shadow: mode=${c2.autoTradeSignal ? "LIVE" : (c2.autoTradeSignalShadow ? "SHADOW" : "OFF")} · ยิงไปแล้ว ${sq.length} (เปิด ${open.length} / ปิด ${closed.length})` +
            (rs.length ? ` · expectancy ${(expectancy).toFixed(3)}R จาก n=${rs.length}` + (rs.length < 30 ? " (n เล็กเกินไป ยังสรุปไม่ได้)" : "") : " · ยังไม่มีไม้ปิด") +
            `\nถูกบล็อกบ่อยสุด: ${Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => k + " ×" + v).join(" · ") || "—"}`,
        });
      }

      if (cmd === "newscheck") {
        // Uses the SAME decider as the live gate, so what this command reports
        // is exactly what the gate will do. The old version had the same
        // ISO-string NaN bug and cheerfully answered "safe to trade" minutes
        // before an event — it must now be able to say "cannot evaluate".
        const ng = cfg().newsGate || {};
        const nc = readNewsCache();
        const now = Date.now();
        const block = newsGateDecide({
          events: nc.events, nowMs: now, gate: { ...ng, enabled: true },
          cacheOk: nc.ok, cacheMtimeMs: nc.mtimeMs, cacheUpdatedMs: nc.updatedMs,
        });
        const evaluable = nc.ok && nc.events.every((e) => parseEventAt(e) != null);
        const near = [];
        const commentary = [];
        for (const ev of nc.events) {
          if (ng.highImpactOnly && ev.impact !== "high") continue;
          const at = parseEventAt(ev);
          if (at == null) continue;
          if (!isScheduledEvent(ev, nc.updatedMs)) { commentary.push(ev.title); continue; }
          const mins = Math.round((at - now) / 60000);
          if (mins >= -(ng.blockAfterMin || 5) && mins <= (ng.blockBeforeMin || 5))
            near.push({ title: ev.title, impact: ev.impact, minutesUntil: mins });
        }
        const upcoming = nc.events
          .map((e) => ({ title: e.title, impact: e.impact, at: parseEventAt(e) }))
          .filter((e) => e.at != null && e.at > now && Math.abs(e.at - nc.updatedMs) > 2000)
          .sort((a, b) => a.at - b.at)
          .slice(0, 3)
          .map((e) => ({ ...e, inMin: Math.round((e.at - now) / 60000) }));
        return reply({
          ok: true, gateEnabled: !!ng.enabled, evaluable,
          cacheOk: nc.ok, cacheAgeH: Number.isFinite(nc.mtimeMs) ? Math.round((now - nc.mtimeMs) / 3600000) : null,
          blockBeforeMin: ng.blockBeforeMin || 5, blockAfterMin: ng.blockAfterMin || 5,
          highImpactOnly: ng.highImpactOnly !== false,
          near, upcoming,
          commentaryIgnored: commentary.length,
          safe: !block,
          blocked: block,
          msg: block ? `🚫 ${block}`
            : evaluable ? `✓ ไม่มีข่าวใหญ่ใกล้ — เทรดได้${upcoming.length ? ` (ถัดไป: ${upcoming[0].title} อีก ${upcoming[0].inMin} นาที)` : ""}`
            : "⚠️ ประเมินข่าวไม่ได้ — อย่าถือว่าปลอดภัย",
        });
      }

      // scan — scan the whole watchlist for opportunities. Pure CODE TA
      // (EMA/volume/momentum), not an LLM job. Returns a ranked list; the
      // background scanner loop calls the same analyzeSymbol() and broadcasts
      // new A/B grades. Advisory only — does not place orders.
      if (cmd === "scan") {
        const c = cfg();
        const entryTf = c.entryTf || (c.scalping ? "3m" : "1h");
        const ctxTf = c.contextTf || "15m";
        const trSc = c.trendRules || {};
        const taOpts = c.scalping
          ? { stopMult: (c.scalpingRules || {}).atrStopMult || 1.5, fixedTargetR: 1.8 }
          : { stopMult: trSc.atrStopMult || 2, fixedTargetR: trSc.fixedTargetR || 0 };
        const syms = c.allowedSymbols || ["BTCUSDT"];
        return (async () => {
          const results = await Promise.all(syms.map((s) => analyzeSymbol(s, req, entryTf, ctxTf, taOpts).catch(() => null)));
          const ranked = results.filter(Boolean).sort((a, b) => b.score - a.score);
          const actionable = ranked.filter((r) => r.grade === "A" || r.grade === "B");
          lastScan = { at: Date.now(), entryTf, ranked };
          reply({
            ok: true, entryTf, scanned: ranked.length,
            actionable: actionable.length,
            signals: ranked,
            msg: actionable.length
              ? `🔭 เจอ ${actionable.length} โอกาส: ${actionable.map((r) => r.symbol + "(" + r.grade + ")").join(", ")}`
              : "望远 — ไม่มีโอกาส grade A/B ตอนนี้",
          });
        })().catch((e) => reply({ ok: false, msg: "scan error: " + e.message }));
      }

      // positions-manage — manual control over the auto-exit manager.
      //   positions-manage            → status of tracked positions
      //   positions-manage close X    → manual close (bypass target/trail)
      //   positions-manage target X P → set/update the target for symbol X
      //   positions-manage trail X P  → set/update the trailPct for symbol X
      if (cmd === "positions-manage" || cmd === "pm") {
        const sub = String(args || "").trim().split(/\s+/);
        const tracked = readPos();
        if (sub[0] === "status" || !sub[0]) {
          return reply({ ok: true, count: tracked.length, positions: tracked });
        }
        if (sub[0] === "target") {
          const symbol = (sub[1] || "").toUpperCase(), target = Number(sub[2]);
          const tp = tracked.find((x) => x.symbol === symbol);
          if (!tp || !target) return reply({ ok: false, msg: "usage: positions-manage target <symbol> <price>" });
          tp.target = target; upsertPos(tp);
          return reply({ ok: true, msg: `${symbol} target = ${target}` });
        }
        if (sub[0] === "trail") {
          const symbol = (sub[1] || "").toUpperCase(), trail = Number(sub[2]);
          const tp = tracked.find((x) => x.symbol === symbol);
          if (!tp) return reply({ ok: false, msg: "usage: positions-manage trail <symbol> <pct>" });
          tp.trailPct = trail; upsertPos(tp);
          return reply({ ok: true, msg: `${symbol} trailPct = ${trail}%` });
        }
        if (sub[0] === "close") {
          const symbol = (sub[1] || "").toUpperCase();
          const tp = tracked.find((x) => x.symbol === symbol);
          if (!tp) return reply({ ok: false, msg: `ไม่มี ${symbol} ใน position store` });
          const isLong = tp.side === "BUY" || tp.side === "LONG";
          // This path had no guard at all. It gets the protective one — still
          // exitable while paused, still refuses to touch a mainnet account.
          const pmBlock = protectiveGuard({ symbol });
          if (pmBlock) return reply({ ok: false, blocked: true, msg: pmBlock });
          return req("POST", "/fapi/v1/order",
            { symbol, side: isLong ? "SELL" : "BUY", type: "MARKET", quantity: String(tp.qty), reduceOnly: "true", newClientOrderId: makeClientOrderId("xm", Date.now()) }, true).then((cr) => {
              // A rejected close must NOT drop tracking — the old code removed it
              // regardless, leaving a live position that nothing managed.
              const out = exitOutcome({ orderOk: cr.ok, avgPrice: cr.json && cr.json.avgPrice, mark: null });
              if (!out.shouldRemove) {
                recordExitFailure(tp, "manual", cr);
                return reply({ ok: false, msg: "close ล้มเหลว — ยังติดตาม position อยู่: " + ((cr.json && cr.json.msg) || cr.body) });
              }
              audit({ cmd: "exit", symbol, kind: "manual", entry: tp.entry, exitPrice: out.exitPrice, ok: true, status: cr.status, pnlSource: out.pnlSource });
              removePos(symbol);
              ctx.broadcast({ type: "trade.exit", plugin: "binance", symbol, kind: "manual" });
              reply({ ok: true, msg: `ปิด ${symbol} แล้ว (manual)` });
            });
        }
        return reply({ ok: false, msg: "usage: positions-manage [status|close <sym>|target <sym> <price>|trail <sym> <pct>]" });
      }



      // --- Market data + account queries (Phase 4) -------------------------

      // klines <sym> [interval] [limit] — candlestick history for TA.
      // interval default 1h, limit default 100. Public, no key.
      if (cmd === "klines") {
        const parts = String(args || "").trim().split(/\s+/);
        const symbol = (parts[0] || "").toUpperCase();
        if (!symbol) return reply({ ok: false, msg: "usage: klines <symbol> [interval] [limit]   เช่น klines BTCUSDT 1h 100" });
        const interval = (parts[1] || "1h").toLowerCase();
        const limit = Math.min(1000, Math.max(1, Number(parts[2]) || 100));
        return req("GET", "/fapi/v1/klines", { symbol, interval, limit }).then((r) => {
          if (!r.ok) return reply({ ok: false, status: r.status, error: (r.json && r.json.msg) || r.body });
          // Each kline: [openTime, open, high, low, close, volume, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, ignore]
          const candles = (Array.isArray(r.json) ? r.json : []).map((k) => ({
            t: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
            close: Number(k[4]), volume: Number(k[5]), closeT: Number(k[6]),
          }));
          reply({ ok: true, symbol, interval, count: candles.length, candles });
        });
      }

      // funding <sym> — mark price + funding rate (premiumIndex). Public.
      if (cmd === "funding") {
        const symbol = String(args || "").trim().toUpperCase().split(/\s+/)[0];
        if (!symbol) return reply({ ok: false, msg: "usage: funding <symbol>   เช่น funding BTCUSDT" });
        return req("GET", "/fapi/v1/premiumIndex", { symbol }).then((r) => {
          if (!r.ok) return reply({ ok: false, status: r.status, error: (r.json && r.json.msg) || r.body });
          reply({ ok: true, symbol: r.json.symbol, markPrice: Number(r.json.markPrice),
            fundingRate: Number(r.json.fundingRate), nextFundingT: Number(r.json.nextFundingTime) });
        });
      }

      // leverage <sym> <lev> — set initial leverage (guarded by maxLeverage).
      if (cmd === "leverage") {
        const parts = String(args || "").trim().split(/\s+/);
        const symbol = (parts[0] || "").toUpperCase();
        const lev = Number(parts[1]);
        if (!symbol || !lev) return reply({ ok: false, msg: "usage: leverage <symbol> <lev>   เช่น leverage BTCUSDT 3" });
        const block = tradeGuard({ symbol, leverage: lev });
        if (block) { audit({ cmd: "leverage", symbol, leverage: lev, blocked: block }); return reply({ ok: false, blocked: true, msg: block }); }
        return req("POST", "/fapi/v1/leverage", { symbol, leverage: String(lev) }, true).then((r) => {
          audit({ cmd: "leverage", symbol, leverage: lev, ok: r.ok, status: r.status, resp: r.json || r.body });
          if (!r.ok) return reply({ ok: false, status: r.status, error: (r.json && r.json.msg) || r.body });
          reply({ ok: true, symbol, leverage: r.json.leverage, maxNotionalValue: Number(r.json.maxNotionalValue),
            msg: `ตั้ง leverage ${symbol} = ${r.json.leverage}x` });
        });
      }

      // openorders [sym] — currently resting orders. Signed.
      if (cmd === "openorders") {
        const symbol = String(args || "").trim().toUpperCase().split(/\s+/)[0];
        const q = symbol ? { symbol } : {};
        return req("GET", "/fapi/v1/openOrders", q, true).then((r) => {
          if (!r.ok) return reply({ ok: false, status: r.status, error: (r.json && r.json.msg) || r.body });
          const rows = (Array.isArray(r.json) ? r.json : []).map((o) => ({
            orderId: o.orderId, symbol: o.symbol, side: o.side, type: o.type,
            status: o.status, qty: Number(o.origQty), price: o.price ? Number(o.price) : null,
            stopPrice: o.stopPrice ? Number(o.stopPrice) : null, time: Number(o.time),
          }));
          reply({ ok: true, count: rows.length, orders: rows });
        });
      }

      // trades <sym> [limit] — recent fill history (userTrades). Signed.
      if (cmd === "trades") {
        const parts = String(args || "").trim().split(/\s+/);
        const symbol = (parts[0] || "").toUpperCase();
        if (!symbol) return reply({ ok: false, msg: "usage: trades <symbol> [limit]   เช่น trades BTCUSDT 50" });
        const limit = Math.min(1000, Math.max(1, Number(parts[1]) || 50));
        return req("GET", "/fapi/v1/userTrades", { symbol, limit: String(limit) }, true).then((r) => {
          if (!r.ok) return reply({ ok: false, status: r.status, error: (r.json && r.json.msg) || r.body });
          const rows = (Array.isArray(r.json) ? r.json : []).map((t) => ({
            id: t.id, orderId: t.orderId, symbol: t.symbol, side: t.side,
            price: Number(t.price), qty: Number(t.qty), realizedPnl: Number(t.realizedPnl),
            time: Number(t.time), maker: t.maker,
          }));
          reply({ ok: true, symbol, count: rows.length, trades: rows });
        });
      }

      // income [type] [limit] — funding/realized PnL income. Paginates by
      // walking endTime backward when a full page is returned, so a busy
      // testnet day isn't silently truncated (per crypto-copilot review).
      if (cmd === "income") {
        const parts = String(args || "").trim().split(/\s+/);
        const itype = parts[0] || "";   // REALIZED_PNL | FUNDING_FEE | COMMISSION | "" (all)
        const wantLimit = Math.min(1000, Math.max(1, Number(parts[1]) || 100));
        const c = cfg();
        // Today's start, to scope to "today" for the daily-loss check.
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
        const collect = async () => {
          const out = [];
          let endTime = Date.now();
          for (let page = 0; page < 5; page++) {   // cap at 5 pages to avoid runaway
            const q = { limit: String(Math.min(1000, wantLimit)) };
            if (itype) q.incomeType = itype;
            if (endTime) q.endTime = String(endTime);
            q.startTime = String(dayStart.getTime());
            const r = await req("GET", "/fapi/v1/income", q, true);
            if (!r.ok) return { ok: false, status: r.status, error: (r.json && r.json.msg) || r.body };
            const rows = Array.isArray(r.json) ? r.json : [];
            out.push(...rows);
            if (rows.length < 1000) break;          // last page reached
            endTime = rows[0].time - 1;             // walk back from oldest in page
          }
          return { ok: true, rows: out };
        };
        return collect().then((res) => {
          if (!res.ok) return reply(res);
          const rows = res.rows.map((i) => ({
            symbol: i.symbol, incomeType: i.incomeType, income: Number(i.income),
            asset: i.asset, time: Number(i.time),
          }));
          const total = rows.reduce((s, r) => s + r.income, 0);
          reply({ ok: true, environment: c.testnet ? "TESTNET" : "MAINNET",
            since: dayStart.toISOString(), count: rows.length, totalIncome: Math.round(total * 1e6) / 1e6, income: rows });
        });
      }

      // cancel <orderId> <sym> — cancel a resting order. Signed.
      if (cmd === "cancel") {
        const parts = String(args || "").trim().split(/\s+/);
        const orderId = parts[0], symbol = (parts[1] || "").toUpperCase();
        if (!orderId || !symbol) return reply({ ok: false, msg: "usage: cancel <orderId> <symbol>" });
        const block = protectiveGuard({ symbol });
        if (block) return reply({ ok: false, blocked: true, msg: block });
        return req("DELETE", "/fapi/v1/order", { orderId, symbol }, true).then((r) => {
          audit({ cmd: "cancel", orderId, symbol, ok: r.ok, status: r.status });
          if (!r.ok) return reply({ ok: false, status: r.status, error: (r.json && r.json.msg) || r.body });
          reply({ ok: true, orderId: r.json.orderId, status: r.json.status, msg: `ยกเลิก order ${orderId} ${symbol} แล้ว` });
        });
      }

      // autotrade — the gated auto-execution entry point (Phase 7).
      // An agent (Shino/Blitz) calls this with a vetted setup; the plugin
      // runs the full autoTradeGuard (autoTrade on + tradeGuard + daily cap
      // + daily loss + grade + no-averaging-down) and ONLY THEN places the
      // order + mandatory stop. Every step is audited + alerted.
      // Usage: autotrade <symbol> <BUY|SELL> <qty> <grade> <stopPrice> [@entryPrice] [target]
      if (cmd === "autotrade") {
        // Custom parse: autotrade <symbol> <BUY|SELL> <qty|risk[=pct]> <grade> <stopPrice> [targetPrice] [@entryPrice]
        // qty slot accepts `risk` (or `risk=0.5`) to size from %-risk instead of a
        // fixed qty — same equation as manual order / auto-signal. targetPrice is
        // optional but needed for the scalping fee-aware R:R check.
        const parts = String(args || "").trim().split(/\s+/);
        const qtyTok = parts[2] || "";
        const mRisk = /^(?:risk|auto|%)(?:=([\d.]+))?$/i.exec(qtyTok);
        const o = { symbol: (parts[0] || "").toUpperCase(), side: (parts[1] || "").toUpperCase(),
          mode: mRisk ? "risk" : "explicit", qty: mRisk ? null : Number(qtyTok),
          riskPct: mRisk && mRisk[1] ? Number(mRisk[1]) : null };
        if (!o.symbol || !o.side || (o.mode === "explicit" && !o.qty)) return reply({ ok: false, msg: 'usage: autotrade <symbol> <BUY|SELL> <qty|risk> <grade> <stopPrice> [targetPrice] [@entryPrice]   เช่น autotrade BTCUSDT BUY 0.001 B 59000  หรือ  autotrade BTCUSDT BUY risk B 59000' });
        // grade (A/B/C) + stop price + optional target (numbers after grade).
        const gradeIdx = parts.findIndex((x) => /^[ABC]$/.test(x.toUpperCase()));
        o.grade = gradeIdx >= 0 ? parts[gradeIdx].toUpperCase() : null;
        o.stopPrice = gradeIdx >= 0 && parts[gradeIdx + 1] ? Number(parts[gradeIdx + 1]) : null;
        o.target = gradeIdx >= 0 && parts[gradeIdx + 2] && !parts[gradeIdx + 2].startsWith("@") ? Number(parts[gradeIdx + 2]) : null;
        // Optional @entryPrice anywhere after qty.
        const atIdx = parts.findIndex((x) => x.startsWith("@"));
        o.price = atIdx >= 0 ? Number(parts[atIdx].slice(1)) : null;
        if (!o.grade) return reply({ ok: false, msg: "autotrade ต้องระบุ setup grade (A/B/C)" });
        if (!o.stopPrice) return reply({ ok: false, msg: "autotrade ต้องระบุ stop price (บังคับ)" });
        // Run the async gate → execute chain as a promise (onCommand is sync).
        return (async () => {
          // Get current price for the cap check + market order + fee-aware entry.
          const pr = await req("GET", "/fapi/v1/ticker/price", { symbol: o.symbol });
          if (!pr.ok) return reply({ ok: false, msg: "ดึงราคาไม่ได้ — ยกเลิก autotrade" });
          const price = Number(pr.json.price);
          // For the fee-aware R:R check, entry defaults to current price if not given.
          o.entry = o.price || price;
          o.stop = o.stopPrice;
          // %-risk sizing (same equation as manual order / auto-signal). Grade
          // ceiling: 2% grade-A, 1% otherwise; default 0.5% sits under both.
          if (o.mode === "risk") {
            const tr = cfg().trendRules || {};
            const riskCeil = o.grade === "A" ? (tr.riskPctMaxGradeA || 2) : (tr.riskPctMax || 1);
            const sized = await sizeByRisk({ symbol: o.symbol, entry: o.entry, stop: o.stop, riskPct: o.riskPct, riskCeil });
            if (sized.blocked) { audit({ cmd: "autotrade", ...o, blocked: sized.blocked }); return reply({ ok: false, blocked: true, msg: sized.blocked }); }
            o.qty = sized.qty;
            o.sizing = { riskPct: sized.riskPct, riskUsd: usd2(sized.riskUsd), notional: usd2(sized.notional), capped: sized.capped };
          }
          o.usdValue = price * o.qty;
          // Full auto-trade gate.
          const block = await autoTradeGuard(o);
          if (block) {
            audit({ cmd: "autotrade", ...o, price, blocked: block });
            return reply({ ok: false, blocked: true, msg: block });
          }
          // Dynamic leverage guardrail (Option B): set gated leverage by stop
          // width before opening, or block if even the lowest tier fails buffer.
          const lg = await applyLeverageGuard(o.symbol, o.entry, o.stop, null);
          if (!lg.ok) {
            audit({ cmd: "autotrade", ...o, price, blocked: lg.reason });
            return reply({ ok: false, blocked: true, msg: lg.reason, leverage: lg });
          }
          // Execute: order (MARKET or LIMIT) + mandatory stop-loss.
          const orderBody = {
            symbol: o.symbol, side: o.side,
            type: o.price ? "LIMIT" : "MARKET", quantity: String(o.qty),
            ...(o.price ? { price: String(o.price), timeInForce: "GTC" } : {}),
            newClientOrderId: makeClientOrderId("at", Date.now()),
          };
          const or = await req("POST", "/fapi/v1/order", orderBody, true);
          audit({ cmd: "autotrade", ...o, price, orderOk: or.ok, orderStatus: or.status, orderResp: or.json || or.body });
          if (!or.ok) return reply({ ok: false, msg: "ส่ง order ไม่สำเร็จ — ยกเลิก (ไม่ได้ตั้ง stop)", error: (or.json && or.json.msg) || or.body });
          // Mandatory stop-loss (autoTradeRules.mandatoryStop defaults true).
          const rules = cfg().autoTradeRules || {};
          if (rules.mandatoryStop !== false) {
            const stopSide = o.side === "BUY" ? "SELL" : "BUY";
            const sr = await placeStopAlgo(o.symbol, stopSide, o.stopPrice);
            audit({ cmd: "autotrade-stop", symbol: o.symbol, stopPrice: o.stopPrice, side: stopSide, ok: sr.ok, status: sr.status, resp: sr.resp });
            if (!sr.ok) {
              // mandatoryStop: never leave a naked position — emergency-close now.
              // Shared with the auto-signal path so both verify the close.
              const ec = await emergencyClose({
                symbol: o.symbol, closeSide: stopSide, qty: o.qty, source: "autotrade",
                reason: "autotrade stop placement failed", intendedStop: o.stopPrice, stopResp: sr.resp,
              });
              return reply({ ok: false, naked: !ec.flat, msg: ec.msg });
            }
          }
          // Success: broadcast + alert.
          const fillPrice = Number(or.json.avgPrice) > 0 ? Number(or.json.avgPrice) : Number(or.json.price) > 0 ? Number(or.json.price) : price;
          const msg = tgAlert({
            kind: "entry", title: `${o.side === "BUY" ? "LONG 📈" : "SHORT 📉"} ${o.symbol}`,
            rows: [
              { label: "Qty", value: o.qty },
              { label: "Entry", value: "$" + fmtPrice(fillPrice) },
              { label: "Stop", value: "$" + fmtPrice(o.stopPrice) },
              { label: "Grade", value: o.grade },
            ],
            footer: `auto-trade · testnet`,
          });
          ctx.broadcast({ type: "trade.fill", plugin: "binance", symbol: o.symbol, side: o.side, size: o.qty, entry: fillPrice, auto: true, grade: o.grade });
          ctx.feed(msg.replace(/<[^>]+>/g, ""), "blitz");
          try { ctx.relay(msg); } catch {}
          // Track the position for the auto-exit manager (target/trail/time-stop).
          const pm = cfg().posManage || {};
          upsertPos({
            symbol: o.symbol, side: o.side, qty: o.qty, entry: fillPrice,
            stop: o.stopPrice, target: o.target || null, trailPct: pm.trailPct || 0,
            openedAt: Date.now(), maxFavorable: fillPrice, source: "autotrade",
          });
          reply({ ok: true, auto: true, orderId: or.json.orderId, status: or.json.status,
            symbol: o.symbol, side: o.side, qty: o.qty, fillPrice, stopPrice: o.stopPrice, grade: o.grade });
        })().catch((e) => reply({ ok: false, msg: "autotrade error: " + e.message }));
      }

      // performance [days] — win/loss/PnL stats from the exit audit log.
      if (cmd === "performance") {
        const days = Math.min(90, Math.max(1, Number(args) || 1));
        return reply({ ok: true, ...performanceStats(days) });
      }

      // journal [days] — read the trade journal markdown for a given day.
      if (cmd === "journal") {
        const day = String(args || "").trim() || new Date().toISOString().slice(0, 10);
        try {
          const body = fs.readFileSync(path.join(tradesDir, day + ".md"), "utf8");
          return reply({ ok: true, day, body });
        } catch { return reply({ ok: false, msg: `ไม่มี journal วันที่ ${day}` }); }
      }

      return reply({ ok: false, msg: "unknown command (status | price | ticker | balance | positions | order | close | stoploss | klines | funding | leverage | openorders | trades | income | cancel | autotrade | pause | audit | newscheck | scan | positions-manage | performance | journal)" });
    },
    // HTTP routes for the read-only dashboard bridge. See buildSnapshot/setPause.
    routes,
    // Plugin lifecycle (daemon/plugins.js calls this before a reload rebuilds
    // the map). Synchronous by contract. Without it every /plugins/reload left
    // the previous generation's monitor + scanner ticking forever, racing this
    // one on the same account with its own dedup state and its own locks.
    dispose() {
      disposed = true;
      if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; LOOPS.monitor--; }
      if (scanTimer) { clearInterval(scanTimer); scanTimer = null; LOOPS.scanner--; }
      ctx.log("binance: disposed (live loops: monitor " + LOOPS.monitor + ", scanner " + LOOPS.scanner + ")");
    },
  };
};

// Exported for offline unit tests (daemon/tests/binance-safety.test.js).
// Attaching to the factory function is inert — daemon/plugins.js only ever
// calls factory({...ctx}); it never reads these. Same pattern as regime-radar.
// Exported for the edge-validation harness (workspace/edge-validation/).
// This is the ONLY honest way to backtest the live signal: the study must
// replay the exact bytes the desk executes, not a re-implementation that can
// drift. `analyzeSymbol` already takes `req` as a parameter, so the harness
// injects a replay transport and nothing here touches the network.
//
// Safe to attach: lines 1-386 are pure module scope (every setInterval and fs
// write lives inside the factory), and daemon/plugins.js only ever calls
// factory({...ctx}) — it never reads these. Same pattern as regime-radar.
module.exports.__research = {
  analyzeSymbol, fractals, classifyStructure, pullbackReady,
  atr, ema, emaSeries, avgVol, swingHigh, swingLow, DEFAULTS,
};

module.exports.__safety = {
  parseEventAt, newsGateDecide, auditTrim, tradesTodayDecide,
  makeDedup, emergencyOutcome, exitOutcome, AUDIT_MONEY_CMDS, isScheduledEvent,
  makeClientOrderId, isDeskTagged, classifyPosition, stopCoverage, reconcileDecide,
};
