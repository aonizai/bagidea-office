// Market Regime Radar — server-side engine.
//
// One job: classify a symbol's *market regime* (Trend-Up / Trend-Down / Range /
// High-Vol) from klines, deterministically, so the label is reproducible and
// backtestable. No chart-reading, no discretion — every output is a pure
// function of the candles. Data (klines + funding) is pulled through the
// binance plugin, never straight from Binance, so keys/rate-limits stay in one
// place. Advisory only: this plugin never places an order.
//
// TA helpers here mirror the desk's binance plugin (ema/atr/fractals/
// classifyStructure) on purpose, so a signal computed here lines up with the
// scanner and can feed the same backtests.

const http = require("http");

// ---- tunable thresholds (deterministic knobs; keep in sync with SPEC.md) ----
const CFG = {
  regimeTf: "1h", regimeLimit: 200,   // primary timeframe for the label
  ctxTf: "4h", ctxLimit: 120,         // higher-TF context (confidence only)
  emaFast: 20, emaSlow: 50,
  emaSlopeLookback: 10,               // bars back to measure EMA50 slope
  adxPeriod: 14, rsiPeriod: 14, atrPeriod: 14,
  adxTrendMin: 22,                    // ADX >= this => trending (else range)
  adxStrongMin: 32,                   // ADX >= this => strong trend
  hvAtrPctAbs: 3.0,                   // ATR% (of price) => elevated vol
  hvAtrPctHigh: 4.5,                  // ATR% => high vol
  hvMedianMult: 1.8,                  // ATR% >= this x its own median => spiking
  slopeEps: 0.05,                     // |slope%| below this = flat
  rsiBull: 55, rsiBear: 45,
  port: Number(process.env.BAGIDEA_PORT) || 8787,
};

// ---- Pure TA helpers (zero-dependency, deterministic) ----
function emaSeries(values, period) {
  if (!values || !values.length || period < 1) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
const ema = (values, period) => { const s = emaSeries(values, period); return s.length ? s[s.length - 1] : null; };

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

// Wilder RSI(period). Returns 0..100 or null if not enough data.
function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

// Wilder ADX(period) with last +DI/-DI. The regime engine's trend-vs-range gate.
// Returns { adx, plusDI, minusDI } or null if not enough data.
function adx(candles, period = 14) {
  if (!candles || candles.length < period * 2 + 1) return null;
  const trs = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high, down = p.low - c.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  // Wilder smoothing: seed = sum of first `period`, then s = s - s/period + x.
  const smooth = (arr) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
    return out;
  };
  const trS = smooth(trs), pdS = smooth(plusDM), mdS = smooth(minusDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    if (trS[i] === 0) { dx.push(0); continue; }
    const pdi = 100 * pdS[i] / trS[i], mdi = 100 * mdS[i] / trS[i];
    const denom = pdi + mdi;
    dx.push(denom === 0 ? 0 : 100 * Math.abs(pdi - mdi) / denom);
  }
  if (dx.length < period) return null;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adxVal = (adxVal * (period - 1) + dx[i]) / period;
  const li = trS.length - 1;
  return {
    adx: adxVal,
    plusDI: trS[li] ? 100 * pdS[li] / trS[li] : 0,
    minusDI: trS[li] ? 100 * mdS[li] / trS[li] : 0,
  };
}

// Williams fractal pivots (mirrors the binance plugin). n=2 => 5-bar fractal.
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

// Last 2 swing highs + lows => up (HH+HL) / down (LH+LL) / range (mirrors desk).
function classifyStructure(fr) {
  const { highs, lows } = fr;
  if (highs.length < 2 || lows.length < 2) return { trend: "range" };
  const h2 = highs.slice(-2), l2 = lows.slice(-2);
  const hh = h2[1].price > h2[0].price, lh = h2[1].price < h2[0].price;
  const hl = l2[1].price > l2[0].price, ll = l2[1].price < l2[0].price;
  if (hh && hl) return { trend: "up" };
  if (lh && ll) return { trend: "down" };
  return { trend: "range" };
}

const median = (arr) => {
  const s = (arr || []).filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---- The regime engine (pure function — testable & backtestable) ----
// candles/ctxCandles: [{open,high,low,close,volume}] ; funding: {fundingRate} | null.
function computeRegime(candles, ctxCandles, funding, tf) {
  if (!candles || candles.length < 60) return { ok: false, msg: "not enough candles" };
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];

  const emaF = ema(closes, CFG.emaFast);
  const emaS = ema(closes, CFG.emaSlow);
  const emaSerS = emaSeries(closes, CFG.emaSlow);
  const ref = emaSerS[emaSerS.length - 1 - CFG.emaSlopeLookback];
  const slopePct = ref ? (emaSerS[emaSerS.length - 1] - ref) / ref * 100 : 0;
  const r = rsi(closes, CFG.rsiPeriod);
  const dm = adx(candles, CFG.adxPeriod);
  const adxVal = dm ? dm.adx : null;
  const a = atr(candles, CFG.atrPeriod);
  const atrPct = price ? a / price * 100 : 0;

  // Volatility baseline: median per-bar TR% over the window.
  const trPct = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (c.close) trPct.push(tr / c.close * 100);
  }
  const baseVol = median(trPct.slice(-100));
  // Flag high vol on EITHER an absolute ATR% ceiling OR a spike vs the series' own
  // median (so a uniformly-wild tape still reads high, not "normal for itself").
  const volState =
    (atrPct >= CFG.hvAtrPctHigh || atrPct >= baseVol * CFG.hvMedianMult) ? "high"
      : (atrPct >= CFG.hvAtrPctAbs || atrPct >= baseVol * 1.3) ? "elevated" : "normal";

  const structDir = classifyStructure(fractals(candles, 2)).trend;
  const ctxTrend = ctxCandles && ctxCandles.length >= 30
    ? classifyStructure(fractals(ctxCandles, 2)).trend : "n/a";

  // Directional vote (0..5 per side): EMA cross, slope, structure, DI, RSI.
  let up = 0, down = 0;
  if (emaF > emaS) up++; else if (emaF < emaS) down++;
  if (slopePct > CFG.slopeEps) up++; else if (slopePct < -CFG.slopeEps) down++;
  if (structDir === "up") up++; else if (structDir === "down") down++;
  if (dm) { if (dm.plusDI > dm.minusDI) up++; else down++; }
  if (r != null) { if (r >= CFG.rsiBull) up++; else if (r <= CFG.rsiBear) down++; }

  const trending = adxVal != null && adxVal >= CFG.adxTrendMin;
  const dominance = Math.abs(up - down);

  // Regime decision. Trend requires ADX gate + a directional winner; a directionless
  // tape with a vol spike is High-Vol (chop), otherwise Range.
  let regime;
  if (trending && up > down) regime = "Trend-Up";
  else if (trending && down > up) regime = "Trend-Down";
  else regime = volState === "high" ? "High-Vol" : "Range";
  const dir = regime === "Trend-Up" ? "up" : regime === "Trend-Down" ? "down" : "range";

  // Funding bias (nudge only; testnet => null => ignored).
  const fr = funding && Number.isFinite(funding.fundingRate) ? funding.fundingRate : null;
  const fundingBias = fr == null ? "n/a" : fr > 0.0001 ? "long-heavy" : fr < -0.0001 ? "short-heavy" : "flat";

  // ---- Confidence (5..95), per-regime, deterministic ----
  let confidence;
  const adxStrength = clamp(((adxVal ?? 0) - 15) / (40 - 15), 0, 1);
  if (regime === "Trend-Up" || regime === "Trend-Down") {
    let c = 40 + (dominance / 5) * 25 + adxStrength * 25;
    if (ctxTrend === dir) c += 10;                 // 4h agrees
    if (fundingBias !== "n/a" && ((dir === "up" && fr < 0) || (dir === "down" && fr > 0))) c += 3; // contrarian confirm
    if (volState === "high") c -= 5;               // strong move but noisier
    confidence = c;
  } else if (regime === "Range") {
    const rangeStrength = clamp((CFG.adxTrendMin - (adxVal ?? CFG.adxTrendMin)) / CFG.adxTrendMin, 0, 1);
    confidence = 40 + rangeStrength * 30 + (dominance === 0 ? 8 : 0) - (volState !== "normal" ? 8 : 0);
  } else { // High-Vol
    const volMag = clamp(atrPct / (CFG.hvAtrPctHigh * 1.5), 0, 1);
    confidence = 45 + volMag * 35;
  }
  confidence = Math.round(clamp(confidence, 5, 95));

  const suitability = SUITABILITY[regime];
  const warnings = [];
  if (fr == null) warnings.push("funding n/a (testnet) — regime read from structure + vol only");
  if (volState !== "normal") warnings.push(`volatility ${volState} (ATR ${atrPct.toFixed(2)}%) — widen stops / size down`);
  if (dir !== "range" && ctxTrend !== "n/a" && ctxTrend !== dir && ctxTrend !== "range")
    warnings.push(`4h context (${ctxTrend}) conflicts with ${tf} trend — lower conviction`);
  if (dir !== "range" && !trending) warnings.push("ADX below trend threshold — trend unconfirmed");

  return {
    ok: true, regime, confidence, volState, dir,
    signals: {
      adx: adxVal != null ? +adxVal.toFixed(1) : null,
      plusDI: dm ? +dm.plusDI.toFixed(1) : null,
      minusDI: dm ? +dm.minusDI.toFixed(1) : null,
      rsi: r != null ? +r.toFixed(1) : null,
      emaFast: emaF != null ? +emaF.toFixed(2) : null,
      emaSlow: emaS != null ? +emaS.toFixed(2) : null,
      slopePct: +slopePct.toFixed(3),
      atrPct: +atrPct.toFixed(2),
      structure: structDir, ctxTrend,
      fundingRate: fr, fundingBias, vote: { up, down },
    },
    suitability, warnings, price,
  };
}

const SUITABILITY = {
  "Trend-Up": { good: ["trend-following longs", "buy pullback (HL)"], avoid: ["fading / counter-trend shorts", "mean-reversion"] },
  "Trend-Down": { good: ["trend-following shorts", "sell the rally (LH)"], avoid: ["counter-trend longs", "catching the knife"] },
  "Range": { good: ["fade the edges (buy support / sell resistance)", "mean-reversion"], avoid: ["chasing breakouts (fakeout-prone)", "trend entries"] },
  "High-Vol": { good: ["size down + widen stops", "breakout only on confirmed close"], avoid: ["tight-stop scalps", "fresh entries into chop"] },
};

// ---- data bridge: pull klines/funding through the binance plugin ----
function callBinance(cmd, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ cmd, args });
    const req = http.request({
      host: "127.0.0.1", port: CFG.port, path: "/plugin/binance/cmd", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}
const getKlines = async (symbol, tf, limit) => {
  const r = await callBinance("klines", `${symbol} ${tf} ${limit}`);
  return r && r.ok && Array.isArray(r.candles) ? r.candles : null;
};

function renderText(sym, tf, x) {
  const s = x.signals;
  const emoji = { "Trend-Up": "🟢↑", "Trend-Down": "🔴↓", "Range": "🟡↔", "High-Vol": "⚡" }[x.regime] || "•";
  const lines = [
    `${emoji}  ${sym} ${tf} — ${x.regime}  (conf ${x.confidence}% · vol ${x.volState})`,
    `price ${x.price} · ADX ${s.adx} (+DI ${s.plusDI}/−DI ${s.minusDI}) · RSI ${s.rsi} · ATR ${s.atrPct}%`,
    `EMA${CFG.emaFast}/${CFG.emaSlow} ${s.emaFast}/${s.emaSlow} slope ${s.slopePct}% · struct ${s.structure} · 4h ${s.ctxTrend} · vote ↑${s.vote.up}/↓${s.vote.down}`,
    `✅ fits: ${x.suitability.good.join(", ")}`,
    `❌ avoid: ${x.suitability.avoid.join(", ")}`,
  ];
  if (x.warnings.length) lines.push(`⚠ ${x.warnings.join(" · ")}`);
  return lines.join("\n");
}

module.exports = (ctx) => ({
  async onCommand(cmd, args, reply) {
    const parts = String(args || "").trim().split(/\s+/).filter(Boolean);

    if (cmd === "health") {
      const ping = await callBinance("price", "BTCUSDT");
      const okBridge = !!(ping && ping.ok);
      return reply({ ok: true, engine: "regime-radar v0.1.0", binanceBridge: okBridge ? "reachable" : "unreachable", port: CFG.port });
    }

    if (cmd === "regime") {
      const symbol = (parts[0] || "").toUpperCase();
      if (!symbol) return reply({ ok: false, msg: "usage: regime <SYMBOL> [tf]  e.g. regime ETHUSDT 1h" });
      const tf = parts[1] || CFG.regimeTf;

      const [candles, ctxCandles, funding] = await Promise.all([
        getKlines(symbol, tf, CFG.regimeLimit),
        getKlines(symbol, CFG.ctxTf, CFG.ctxLimit),
        callBinance("funding", symbol),
      ]);
      if (!candles) return reply({ ok: false, msg: `no klines for ${symbol} (${tf}) — is the binance plugin up & symbol valid?` });

      const out = computeRegime(candles, ctxCandles, funding && funding.ok ? funding : null, tf);
      if (!out.ok) return reply({ ok: false, msg: out.msg });
      if (ctx && ctx.log) ctx.log(`[regime-radar] ${symbol} ${tf} => ${out.regime} ${out.confidence}%`);
      return reply({ ok: true, symbol, tf, ...out, text: renderText(symbol, tf, out) });
    }

    return reply({ ok: false, msg: `unknown command: ${cmd}` });
  },
});

// Exported for offline unit tests / backtests (require the module directly).
module.exports.computeRegime = computeRegime;
module.exports._ta = { ema, atr, rsi, adx, fractals, classifyStructure, median };
module.exports.CFG = CFG;
