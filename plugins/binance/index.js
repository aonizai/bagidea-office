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
  maxOrderUsd: 10,            // cap per order (testnet safety)
  maxLeverage: 5,             // cap on leverage setting (testnet safety)
  allowedSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"],
  timeoutMs: 10000,
  // Auto-trade (Phase 7): off by default. When on, the monitoring loop can
  // place orders that pass tradeGuard + autoTradeRules, without a human
  // confirming each one. Still testnet-only + capped + audited.
  autoTrade: false,
  autoTradeRules: {
    maxTradesPerDay: 5,
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
  // Trend-following mode (ACTIVE — replaces scalping). Bigger TF, wait for
  // A-Setup, let winners run, partial TP, hold overnight. Risk/trade is small
  // but R is large. "Trade less. Trade better. Cut losers. Let winners run."
  entryTf: "15m",            // entry timeframe
  contextTf: "1h",           // higher-TF trend filter (must align with entry)
  simulatedEquity: 2000,     // simulate real capital (testnet has $5001 but size off this)
  trendRules: {
    riskPct: 0.3,            // 0.3%/trade = ~$6 from $2000
    atrStopMult: 2,          // stop = 2×ATR (wider than scalp 1.5)
    fixedTargetR: 0,         // 0 = no fixed target, let winners run; >0 = TP at that R
    partialTpR: 2,           // take partial profit at +2R
    partialTpPct: 50,        // close this % of the position on partial TP
    breakevenTriggerR: 1,    // move SL → breakeven when +1R
    trailActivateR: 2,       // start trailing after +2R (after partial taken)
    trailPct: 1.5,           // trail % from peak (wider than scalp 0.5)
    minRr: 2,                // minimum R:R to accept a setup
  },
  dailyLossPct: 2,           // 2% daily loss circuit-breaker = $40 from $2000
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

module.exports = (ctx) => {
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
  const saveCfg = (patch) => {
    const c = { ...cfg(), ...patch };
    fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2));
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
  async function cancelStopAlgos(symbol, exceptId) {
    for (const o of await listStopAlgos(symbol)) {
      const id = o.algoId || o.algoID;
      if (id && String(id) !== String(exceptId || "")) await req("DELETE", "/fapi/v1/algoOrder", { algoId: String(id) }, true);
    }
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

  // Parse "BTCUSDT BUY 0.001" or "BTCUSDT BUY 0.001 @60000" into a clean object.
  // Tolerates JSON too: {"symbol":"BTCUSDT","side":"buy","qty":0.001,"price":60000}
  function parseOrderArgs(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    if (s.startsWith("{")) {
      try {
        const o = JSON.parse(s);
        if (!o.symbol || !o.side || !o.qty) return null;
        return { symbol: String(o.symbol).toUpperCase(), side: String(o.side).toUpperCase(),
          qty: Number(o.qty), price: o.price ? Number(o.price) : null };
      } catch { return null; }
    }
    // Split on whitespace, but pull an optional "@price" off the end.
    const m = s.match(/^(\S+)\s+(BUY|SELL|buy|sell)\s+([\d.]+)(?:\s*@?\s*([\d.]+))?$/);
    if (!m) return null;
    return { symbol: m[1].toUpperCase(), side: m[2].toUpperCase(), qty: Number(m[3]), price: m[4] ? Number(m[4]) : null };
  }

  // --- Trading guards + audit log -------------------------------------------
  // Append every order attempt to data/orders.json so there's a durable trail
  // (kept under the testnet cap — auto-trimmed to the last 200 entries).
  const auditFile = path.join(ctx.dataDir, "orders.json");
  const audit = (entry) => {
    try {
      let log = [];
      try { log = JSON.parse(fs.readFileSync(auditFile, "utf8")); } catch {}
      log.push({ ts: Date.now(), ...entry });
      fs.writeFileSync(auditFile, JSON.stringify(log.slice(-200), null, 2));
    } catch (e) { ctx.log("binance: audit write failed: " + e.message); }
  };
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
    if (c.maxOrderUsd && o.usdValue && o.usdValue > c.maxOrderUsd)
      return `ขนาด order $${o.usdValue} เกิน cap $${c.maxOrderUsd}`;
    if (o.leverage && c.maxLeverage && o.leverage > c.maxLeverage)
      return `leverage ${o.leverage}x เกิน cap ${c.maxLeverage}x`;
    return null;   // allowed
  }

  // --- Auto-trade guards (Phase 7) -----------------------------------------
  // Count today's executed orders from the audit log (cmd=order + ok, not
  // blocked). Used to enforce maxTradesPerDay.
  function tradesToday() {
    try {
      const log = JSON.parse(fs.readFileSync(auditFile, "utf8"));
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      return log.filter((e) => e.cmd === "order" && e.ok && e.ts >= dayStart.getTime()).length;
    } catch { return 0; }
  }
  // Fetch today's realized PnL (income REALIZED_PNL since midnight) + current
  // unrealized PnL, to check the daily-loss limit. Returns {realized, unreal}.
  async function dailyPnl() {
    let realized = 0, unreal = 0;
    try {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      // Realized: walk income pages for today (same pagination as the income cmd).
      let endTime = Date.now();
      for (let page = 0; page < 5; page++) {
        const r = await req("GET", "/fapi/v1/income",
          { incomeType: "REALIZED_PNL", startTime: String(dayStart.getTime()), endTime: String(endTime), limit: "1000" }, true);
        if (!r.ok) break;
        const rows = Array.isArray(r.json) ? r.json : [];
        realized += rows.reduce((s, x) => s + Number(x.income || 0), 0);
        if (rows.length < 1000) break;
        endTime = rows[0].time - 1;
      }
    } catch {}
    try {
      const pr = await req("GET", "/fapi/v2/positionRisk", null, true);
      if (pr.ok && Array.isArray(pr.json))
        unreal = pr.json.reduce((s, p) => s + Number(p.unRealizedProfit || 0), 0);
    } catch {}
    return { realized: Math.round(realized * 1e6) / 1e6, unreal: Math.round(unreal * 1e6) / 1e6 };
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
  async function recentOutcomes(windowMin) {
    try {
      const since = Date.now() - windowMin * 60000;
      let endTime = Date.now();
      const out = [];
      for (let page = 0; page < 3; page++) {
        const r = await req("GET", "/fapi/v1/income",
          { incomeType: "REALIZED_PNL", startTime: String(since), endTime: String(endTime), limit: "1000" }, true);
        if (!r.ok) break;
        const rows = Array.isArray(r.json) ? r.json : [];
        out.push(...rows);
        if (rows.length < 1000) break;
        endTime = rows[0].time - 1;
      }
      return out.sort((a, b) => b.time - a.time).map((x) => ({ time: x.time, win: Number(x.income) > 0 }));
    } catch { return []; }
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
  function readNewsCache() {
    try {
      const p = path.join(ctx.workspace, "news-cache.json");
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      return Array.isArray(j.events) ? j.events : (Array.isArray(j) ? j : []);
    } catch { return []; }
  }
  // --- Position store (data/positions.json) --------------------------------
  // Tracks active positions for the auto-exit manager: entry/stop/target/
  // trail + the best price seen (maxFavorable) so the trail can lock profit.
  const posFile = path.join(ctx.dataDir, "positions.json");
  const readPos = () => { try { return JSON.parse(fs.readFileSync(posFile, "utf8")); } catch { return []; } };
  const writePos = (arr) => fs.writeFileSync(posFile, JSON.stringify(arr, null, 2));
  const upsertPos = (p) => {
    const arr = readPos().filter((x) => x.symbol !== p.symbol);
    arr.push(p); writePos(arr);
  };
  const removePos = (symbol) => writePos(readPos().filter((x) => x.symbol !== symbol));
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
      maxOrderUsd: c.maxOrderUsd, maxLeverage: c.maxLeverage,
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
      tradeEnabled: !!c.tradeEnabled,
      scalping: !!c.scalping,
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
  async function executeAutoSignal(r) {
    const c = cfg();
    const rules = c.autoTradeSignalRules || {};
    // Grade floor.
    const order = { A: 3, B: 2, C: 1 };
    if ((order[r.grade] || 0) < (order[rules.minGrade || "B"] || 0))
      return { blocked: `signal grade ${r.grade} < ${rules.minGrade || "B"}` };
    // One-position-at-a-time: skip if any tracked position is open.
    if (rules.onePositionAtATime && readPos().length > 0)
      return { blocked: "มี position เปิดอยู่แล้ว — ข้าม signal" };
    // Position size from trend risk%: qty = (equity × riskPct%) / stopDistance.
    // Sizing base is simulatedEquity (real capital $2000) — NOT the testnet
    // balance ($5001) — so numbers match what we'd use on mainnet.
    const equity = c.simulatedEquity || await accountEquity();
    const tr = c.trendRules || {};
    const sr = c.scalping ? (c.scalpingRules || {}) : {};
    const riskPct = c.scalping ? (sr.riskPct || 0.5) : (tr.riskPct || 0.3);
    const riskUsd = equity * riskPct / 100;
    const stopDist = Math.abs(r.entry - r.stop);
    if (stopDist <= 0) return { blocked: "stop distance ศูนย์ — ขนาดไม่ได้" };
    let qty = riskUsd / stopDist;
    // Cap by maxOrderUsd: risk-based sizing can give a notional way over the
    // testnet cap (e.g. $25 risk / $0.53 stop = 47 BNB = $27k notional). The
    // cap is a HARD floor — shrink qty so qty × entry ≤ cap.
    const cap = c.maxOrderUsd || 10;
    const maxQtyByCap = cap / r.entry;
    if (qty > maxQtyByCap) qty = maxQtyByCap;
    // Round qty down to a sane precision (Binance wants stepSize-aligned; we
    // trim to 3 decimals as a coarse floor — the order may still be rejected
    // for precision, in which case the audit log captures it).
    const q = Math.floor(qty * 1e3) / 1e3;
    if (q <= 0) return { blocked: `qty ต่ำเกินไป (${qty}) — equity $${equity.toFixed(2)} risk ${riskPct}% cap $${cap}` };
    const side = r.dir === "bull" ? "BUY" : "SELL";
    // Build the order object the guard expects, then run the FULL gate.
    const o = { symbol: r.symbol, side, qty: q, grade: r.grade,
      stopPrice: r.stop, target: r.target, entry: r.entry, price: null };
    o.usdValue = r.entry * q;
    const block = await autoTradeGuard(o);
    if (block) return { blocked: block };
    // Place MARKET order (scalp = speed) + mandatory stop.
    const or = await req("POST", "/fapi/v1/order",
      { symbol: r.symbol, side, type: "MARKET", quantity: String(q) }, true);
    audit({ cmd: "auto-signal", symbol: r.symbol, side, qty: q, grade: r.grade, price: r.entry, orderOk: or.ok, status: or.status, resp: or.json || or.body });
    if (!or.ok) return { blocked: "order ล้มเหลว: " + ((or.json && or.json.msg) || or.body) };
    // Mandatory stop — conditional order via the Algo Order API (regular endpoint rejects it).
    // If the stop cannot be placed, NEVER leave a naked position: emergency-close immediately.
    const stopSide = side === "BUY" ? "SELL" : "BUY";
    const sl = await placeStopAlgo(r.symbol, stopSide, r.stop);
    if (!sl.ok) {
      await req("POST", "/fapi/v1/order",
        { symbol: r.symbol, side: stopSide, type: "MARKET", quantity: String(q), reduceOnly: "true" }, true);
      audit({ cmd: "emergency-close", symbol: r.symbol, reason: "stop placement failed", resp: sl.resp });
      const emsg = `🚨 ${r.symbol} STOP วางไม่ติด → ปิดไม้ทันที (mandatoryStop, ไม่เปิดไม้เปลือย)`;
      ctx.broadcast({ type: "trade.alert", plugin: "binance", kind: "stop-failed", symbol: r.symbol });
      ctx.feed(emsg, "compass"); try { ctx.relay(emsg); } catch {}
      return { blocked: "stop วางไม่ติด — ปิด position ฉุกเฉินแล้ว" };
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
      const n = tradesToday();
      if (n >= rules.maxTradesPerDay) return `ถึง limit ${rules.maxTradesPerDay} ไม้/วัน แล้ว (วันนี้ ${n} ไม้)`;
    }
    // Daily loss limit. Scalping: scalpingRules.dailyLossPct (3%). Trend: top-level
    // dailyLossPct (2%). Sizing base for % is simulatedEquity (real capital), not
    // the testnet balance.
    const equityBase = c.simulatedEquity || await accountEquity();
    const { realized, unreal } = await dailyPnl();
    const dayPnl = realized + unreal;
    const sr = c.scalping ? (c.scalpingRules || {}) : {};
    const lossPct = c.scalping ? (sr.dailyLossPct || 3) : (c.dailyLossPct || 2);
    const lossLimit = -Math.abs(equityBase * lossPct / 100);
    if (dayPnl <= lossLimit) {
      // Auto-disable autoTrade + alert — a hard daily-stop.
      saveCfg({ autoTrade: false });
      const msg = tgAlert({
        kind: "danger", title: "Daily Loss Limit ถึงแล้ว",
        rows: [
          { label: "PnL วันนี้", value: fmtUsd(dayPnl), accent: "❌ เกิน limit" },
          { label: "Limit", value: `${lossPct}% = $${Math.abs(lossLimit).toFixed(2)}` },
        ],
        footer: "autoTrade ปิดอัตโนมัติ — หยุดเทรดทั้งวัน",
      });
      ctx.broadcast({ type: "trade.alert", plugin: "binance", kind: "daily-loss", pnl: dayPnl, limit: lossLimit });
      ctx.feed(msg, "compass");
      try { ctx.relay(msg); } catch {}
      return msg;
    }
    // Loss-streak cooldown. Scalping: uses scalpingRules (3 losses/30min). Trend:
    // uses top-level cooldownAfterLosses/cooldownMin (2 losses/60min). Either way
    // the goal is the same — stop revenge-trading after a bad run.
    const cdLosses = c.scalping ? (sr.cooldownAfterLosses || 0) : (c.cooldownAfterLosses || 0);
    const cdMin = c.scalping ? (sr.cooldownMin || 30) : (c.cooldownMin || 60);
    const cdWindow = c.scalping ? (sr.cooldownWindowMin || 60) : 120;
    if (cdLosses) {
      const outcomes = await recentOutcomes(cdWindow);
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
    if (c.newsGate && c.newsGate.enabled) {
      const events = readNewsCache();
      const now = Date.now();
      for (const ev of events) {
        if (c.newsGate.highImpactOnly && ev.impact !== "high") continue;
        const minsUntil = ev.at ? Math.round((ev.at - now) / 60000) : null;
        if (minsUntil == null) continue;
        if (minsUntil >= -c.newsGate.blockAfterMin && minsUntil <= c.newsGate.blockBeforeMin) {
          const when = minsUntil >= 0 ? `อีก ${minsUntil} นาที (ก่อนข่าว)` : `${-minsUntil} นาทีที่แล้ว (หลังข่าว)`;
          return `news gate: ${ev.title || "ข่าวใหญ่"} ${when} — รอให้ความผันผวนเคลียร์`;
        }
      }
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
      const was = lastPositions[o.symbol];
      if (was && was.pnl < 0) return `ห้ามเพิ่ม position ขาดทุน — ${o.symbol} กำลังขาดทุน $${was.pnl.toFixed(2)}`;
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
  let lastSignalKey = "";    // dedup: only broadcast a signal once per symbol+grade+dir
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
    if (monitorTimer) clearInterval(monitorTimer);
    const ms = cfg().monitorMs;
    if (!ms || !cfg().apiKey) return;   // off or no key
    monitorTimer = setInterval(async () => {
      const c = cfg();
      if (!c.apiKey) return;
      // Positions: detect open/close transitions.
      try {
        const pr = await req("GET", "/fapi/v2/positionRisk", null, true);
        if (pr.ok && Array.isArray(pr.json)) {
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
            const live = now[tp.symbol];   // may be undefined if Binance closed it (stop hit)
            const mark = live ? live.mark : null;
            // If the position is gone from Binance (stop filled, or manual close),
            // sync the store + log the exit.
            if (!live) {
              removePos(tp.symbol);
              audit({ cmd: "exit", symbol: tp.symbol, kind: "stop-or-manual", entry: tp.entry, exitPrice: tp.maxFavorable });
              ctx.broadcast({ type: "trade.exit", plugin: "binance", symbol: tp.symbol, kind: "stop" });
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
              if (!tp.breakevenMoved && tr3.breakevenTriggerR > 0 && r >= tr3.breakevenTriggerR) {
                const stopSide = isLong ? "SELL" : "BUY";
                const buf = tr3.breakevenBuffer || 0.001;   // tiny buffer above entry to cover fees
                const bePrice = isLong ? tp.entry * (1 + buf) : tp.entry * (1 - buf);
                // Place the breakeven stop FIRST via the Algo Order API, then cancel the wider
                // original — never a gap without a resting stop. If it fails, keep the old stop.
                const beRes = await placeStopAlgo(tp.symbol, stopSide, bePrice);
                if (!beRes.ok) {
                  ctx.feed(`⚠️ ${tp.symbol} BE stop วางไม่ติด (คง stop เดิมไว้) — retry รอบหน้า`, "blitz");
                } else {
                  try { await cancelStopAlgos(tp.symbol, beRes.algoId); } catch {}
                  tp.breakevenMoved = true;
                  tp.stop = bePrice;
                  const beMsg = `🛡️ ${tp.symbol} ย้าย SL → breakeven ($${fmtPrice(bePrice)}) @ +${r.toFixed(1)}R`;
                  ctx.broadcast({ type: "trade.alert", plugin: "binance", kind: "breakeven", symbol: tp.symbol, price: bePrice });
                  ctx.feed(beMsg, "blitz");
                  try { ctx.relay(beMsg); } catch {}
                }
              }
              // 2. Partial TP: close partialTpPct% at +partialTpR (once).
              if (!tp.partialTaken && tr3.partialTpR > 0 && tr3.partialTpPct > 0 && r >= tr3.partialTpR) {
                const closeSide = isLong ? "SELL" : "BUY";
                const partQty = Math.floor(Math.abs(live.size) * (tr3.partialTpPct / 100) * 1e3) / 1e3;
                if (partQty > 0) {
                  const pr = await req("POST", "/fapi/v1/order",
                    { symbol: tp.symbol, side: closeSide, type: "MARKET", quantity: String(partQty), reduceOnly: "true" }, true);
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
                    { symbol: tp.symbol, side: closeSide, type: "MARKET", quantity: String(Math.abs(live.size)) }, true);
                  const pnl = (isLong ? mark - tp.entry : tp.entry - mark) * Math.abs(live.size);
                  audit({ cmd: "exit", symbol: tp.symbol, kind: "trail", entry: tp.entry, exitPrice: mark, pnl: Math.round(pnl * 1e6) / 1e6, ok: cr.ok });
                  removePos(tp.symbol);
                  journalLine(tp, mark, "trail", pnl);
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
                { symbol: tp.symbol, side: closeSide, type: "MARKET", quantity: String(Math.abs(live.size)) }, true);
              const pnl = (isLong ? mark - tp.entry : tp.entry - mark) * Math.abs(live.size);
              audit({ cmd: "exit", symbol: tp.symbol, kind: exitKind, entry: tp.entry, exitPrice: mark, pnl: Math.round(pnl * 1e6) / 1e6, ok: cr.ok });
              removePos(tp.symbol);
              journalLine(tp, mark, exitKind, pnl);
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
      } catch {}
    }, ms);
    ctx.log("binance: monitor loop started (" + ms + "ms)");
  };
  startMonitor();

  // --- Scanner loop (background) -------------------------------------------
  // Sweeps the watchlist on scanIntervalMs, computes TA in CODE, and broadcasts
  // a signal only when a NEW A/B-graded opportunity appears (dedup by
  // symbol+grade+dir). Advisory — never places orders itself.
  const startScanner = () => {
    if (scanTimer) clearInterval(scanTimer);
    const c = cfg();
    const ms = c.scanIntervalMs || 0;
    if (!ms || !c.apiKey) return;
    scanTimer = setInterval(async () => {
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
          if (key === lastSignalKey) continue;   // already announced this exact setup
          lastSignalKey = key;
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
          try { ctx.relay(msg); } catch {}
          // Closed-loop: if the owner enabled autoTradeSignal, place the trade
          // directly from the signal (through the full guard — same as autotrade).
          if (cc.autoTradeSignal) {
            try {
              const res = await executeAutoSignal(r);
              if (res.blocked) {
                const bm = `🚫 signal ${r.symbol} ถูก block: ${res.blocked}`;
                ctx.feed(bm, "compass");
                audit({ cmd: "auto-signal-blocked", symbol: r.symbol, grade: r.grade, blocked: res.blocked });
              }
            } catch (e) { ctx.log("binance: auto-signal error: " + e.message); }
          }
        }
      } catch (e) { ctx.log("binance: scan loop error: " + e.message); }
    }, ms);
    ctx.log("binance: scanner loop started (" + ms + "ms)");
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
        if (typeof p.maxOrderUsd === "number") patch.maxOrderUsd = p.maxOrderUsd;
        if (typeof p.maxLeverage === "number") patch.maxLeverage = p.maxLeverage;
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
          allowedSymbols: c.allowedSymbols, maxOrderUsd: c.maxOrderUsd, maxLeverage: c.maxLeverage,
          monitorMs: c.monitorMs, scanIntervalMs: c.scanIntervalMs, autoTradeRules: c.autoTradeRules });
      }

      if (cmd === "status") {
        const c = cfg();
        const base = c.testnet ? URLS.testnet : URLS.mainnet;
        // Ping the public time endpoint to confirm reachability without keys.
        return req("GET", "/fapi/v1/ping").then((r) => reply({
          ok: r.ok, reachable: r.ok,
          environment: c.testnet ? "TESTNET" : "MAINNET",
          baseUrl: base,
          hasKey: !!c.apiKey, hasSecret: !!c.apiSecret,
          tradeEnabled: c.tradeEnabled, autoTrade: c.autoTrade, autoTradeSignal: c.autoTradeSignal,
          scalping: c.scalping, tradePaused: c.tradePaused, hasPauseToken: !!c.officePauseToken,
          allowedSymbols: c.allowedSymbols,
          maxOrderUsd: c.maxOrderUsd, maxLeverage: c.maxLeverage,
          monitorMs: c.monitorMs, scanIntervalMs: c.scanIntervalMs,
          pingStatus: r.status, pingError: r.error,
        }));
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
        return req("GET", "/fapi/v2/positionRisk", null, true).then((r) => {
          if (!r.ok) return reply({ ok: false, status: r.status, error: r.error || (r.json && r.json.msg) || r.body });
          const rows = (Array.isArray(r.json) ? r.json : []).map(fmtPos).filter((p) => p.size > 0);
          reply({ ok: true, environment: cfg().testnet ? "TESTNET" : "MAINNET", count: rows.length, positions: rows });
        });
      }

      // --- Trading commands. All go through tradeGuard first, then hit the
      // signed /fapi/v1/order endpoint, then audit-log the result. ----------

      // order MARKET:  order BTCUSDT BUY 0.001        (qty in coin units)
      // order LIMIT:   order BTCUSDT BUY 0.001 @60000  (price required)
      // "SELL" opens/closes a SHORT; the same endpoint handles both directions
      // in hedge-off mode (the testnet default).
      if (cmd === "order") {
        const o = parseOrderArgs(args);
        if (!o) return reply({ ok: false, msg: 'usage: order <SYMBOL> <BUY|SELL> <qty> [@price]   เช่น order BTCUSDT BUY 0.001  หรือ  order BTCUSDT BUY 0.001 @60000' });
        // Estimate USD value from the latest price (for the cap check).
        return req("GET", "/fapi/v1/ticker/price", { symbol: o.symbol }).then((pr) => {
          const price = pr.ok ? Number(pr.json.price) : 0;
          const usdValue = price * o.qty;
          const block = tradeGuard({ symbol: o.symbol, usdValue });
          if (block) { audit({ cmd: "order", ...o, usdValue, blocked: block }); return reply({ ok: false, blocked: true, msg: block }); }
          const body = {
            symbol: o.symbol, side: o.side.toUpperCase(),
            type: o.price ? "LIMIT" : "MARKET",
            quantity: String(o.qty),
            ...(o.price ? { price: String(o.price), timeInForce: "GTC" } : {}),
          };
          return req("POST", "/fapi/v1/order", body, true).then((r) => {
            const ok = r.ok;
            audit({ cmd: "order", ...o, usdValue, price, ok, status: r.status, resp: r.json || r.body });
            if (!ok) return reply({ ok: false, status: r.status, error: (r.json && r.json.msg) || r.body });
            const j = r.json;
            reply({
              ok: true, orderId: j.orderId, status: j.status, type: j.type,
              symbol: j.symbol, side: j.side, qty: Number(j.origQty),
              price: j.price ? Number(j.price) : price,
              avgPrice: j.avgPrice ? Number(j.avgPrice) : null,
            });
          });
        });
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
          const block = tradeGuard({ symbol });
          if (block) { audit({ cmd: "close", symbol, side, qty, blocked: block }); return reply({ ok: false, blocked: true, msg: block }); }
          return req("POST", "/fapi/v1/order",
            { symbol, side, type: "MARKET", quantity: String(qty) }, true).then((r) => {
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
          const block = tradeGuard({ symbol });
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
      if (cmd === "newscheck") {
        const ng = cfg().newsGate || {};
        const events = readNewsCache().filter((e) => !ng.highImpactOnly || e.impact === "high");
        const now = Date.now();
        const near = [];
        for (const ev of events) {
          const mins = ev.at ? Math.round((ev.at - now) / 60000) : null;
          if (mins != null && mins >= -(ng.blockAfterMin || 5) && mins <= (ng.blockBeforeMin || 5))
            near.push({ title: ev.title, impact: ev.impact, minutesUntil: mins });
        }
        return reply({
          ok: true, gateEnabled: !!ng.enabled,
          blockBeforeMin: ng.blockBeforeMin || 5, blockAfterMin: ng.blockAfterMin || 5,
          highImpactOnly: ng.highImpactOnly !== false,
          near, safe: near.length === 0,
          msg: near.length ? `🚫 มีข่าวใกล้: ${near.map((n) => n.title + " (" + (n.minutesUntil >= 0 ? "+" : "") + n.minutesUntil + "m)").join(", ")}` : "✓ ไม่มีข่าวใหญ่ใกล้ — เทรดได้",
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
          return req("POST", "/fapi/v1/order",
            { symbol, side: isLong ? "SELL" : "BUY", type: "MARKET", quantity: String(tp.qty) }, true).then((cr) => {
              audit({ cmd: "exit", symbol, kind: "manual", entry: tp.entry, ok: cr.ok, status: cr.status });
              removePos(symbol);
              ctx.broadcast({ type: "trade.exit", plugin: "binance", symbol, kind: "manual" });
              reply({ ok: cr.ok, msg: cr.ok ? `ปิด ${symbol} แล้ว (manual)` : "close ล้มเหลว: " + ((cr.json && cr.json.msg) || cr.body) });
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
        const block = tradeGuard({ symbol });
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
        // Custom parse: autotrade <symbol> <BUY|SELL> <qty> <grade> <stopPrice> [targetPrice] [@entryPrice]
        // targetPrice is optional but needed for the scalping fee-aware R:R check.
        const parts = String(args || "").trim().split(/\s+/);
        const o = { symbol: (parts[0] || "").toUpperCase(), side: (parts[1] || "").toUpperCase(), qty: Number(parts[2]) };
        if (!o.symbol || !o.side || !o.qty) return reply({ ok: false, msg: 'usage: autotrade <symbol> <BUY|SELL> <qty> <grade> <stopPrice> [targetPrice] [@entryPrice]   เช่น autotrade BTCUSDT BUY 0.001 B 59000 61000 @60000' });
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
          o.usdValue = price * o.qty;
          // For the fee-aware R:R check, entry defaults to current price if not given.
          o.entry = o.price || price;
          o.stop = o.stopPrice;
          // Full auto-trade gate.
          const block = await autoTradeGuard(o);
          if (block) {
            audit({ cmd: "autotrade", ...o, price, blocked: block });
            return reply({ ok: false, blocked: true, msg: block });
          }
          // Execute: order (MARKET or LIMIT) + mandatory stop-loss.
          const orderBody = {
            symbol: o.symbol, side: o.side,
            type: o.price ? "LIMIT" : "MARKET", quantity: String(o.qty),
            ...(o.price ? { price: String(o.price), timeInForce: "GTC" } : {}),
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
              await req("POST", "/fapi/v1/order",
                { symbol: o.symbol, side: stopSide, type: "MARKET", quantity: String(o.qty), reduceOnly: "true" }, true);
              audit({ cmd: "emergency-close", symbol: o.symbol, reason: "autotrade stop placement failed", resp: sr.resp });
              const msg = tgAlert({
              kind: "warn", title: `Stop ตั้งไม่ได้ — ปิด position ฉุกเฉินแล้ว`,
              rows: [
                { label: "Symbol", value: o.symbol },
                { label: "การกระทำ", value: "ปิด position ทันที (mandatoryStop) — ไม่เปิดไม้เปลือย", accent: "🚨" },
              ],
              footer: "position ถูกปิดอัตโนมัติ",
            });
              ctx.broadcast({ type: "trade.alert", plugin: "binance", kind: "stop-failed", symbol: o.symbol });
              ctx.feed(msg, "compass");
              try { ctx.relay(msg); } catch {}
              return reply({ ok: false, msg: "stop วางไม่ติด — ปิด position ฉุกเฉินแล้ว (ไม่เปิดไม้เปลือย)" });
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
  };
};
