"use strict";
/**
 * Scanner replay — emits the signals `executeAutoSignal` WOULD have fired.
 *
 * The whole value of this study is that the decision code is the LIVE BYTES.
 * So this file imports `analyzeSymbol` from plugins/binance/index.js rather
 * than re-implementing it; a second copy is exactly the drift the desk's own
 * `backtest-live-signal-before-trusting-autoexec` skill forbids
 * ("reconstruct the EXACT signal the live system fires on, don't backtest an
 * idealized version").
 *
 * Two things this must get right or every number downstream is fiction:
 *
 *  1. NO NETWORK, NO UNMODELLED ENDPOINT. The replay `req` answers exactly one
 *     (method, path) and THROWS on anything else. A silent fallback would let
 *     the harness quietly diverge from what it claims to be replaying.
 *
 *  2. THE GATE CHAIN IN THE LIVE ORDER, including the parts that look like
 *     bugs. The live dedup is a single module-scope string shared across all
 *     symbols, updated in score-descending order within a tick — that is the
 *     difference between "every qualifying bar" and the handful that actually
 *     fire. An adapter that dedups per-symbol produces a much larger, wrong
 *     trade population.
 *
 * Usage:
 *   node replay-scanner.js --mode closed --out signals-scanner.jsonl [--symbols A,B] [--limit N]
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DESK = "/home/tiwa/bagidea-desk";
const { analyzeSymbol, DEFAULTS } = require(path.join(DESK, "plugins/binance/index.js")).__research;
const { computeRegime } = require(path.join(DESK, "plugins/regime-radar/index.js"));

const CANDLES = path.join(DESK, "workspace/edge-validation/candles");
const RATIFIED = path.join(DESK, "ops/edge-validation/ratified-thresholds.json");
// Entry slippage must match the scoring side EXACTLY, and both must read it
// from the ratified file rather than each carrying its own constant. A 3 bps
// difference here is not cosmetic: it rescales R, which shifts when breakeven
// and the trail arm, which moved 82 of 985 trades to a different exit bar —
// one of them by 289 bars.
const SLIP_BPS = (() => {
  try { return JSON.parse(fs.readFileSync(RATIFIED, "utf8")).conservative_costs.base_slippage_per_side * 10000; }
  catch { throw new Error("cannot read ratified slippage — refusing to guess a cost assumption"); }
})();
const MANIFEST = path.join(DESK, "workspace/edge-validation/dataset-manifest.json");
const TF_MS = { "15m": 900000, "1h": 3600000, "4h": 14400000 };

/* ----------------------------------------------------------------- config */

// The LIVE values, read from the desk's own config with the secrets dropped.
// The harness must never read config.json directly for anything else.
function liveConfig() {
  // Reproducibility: --cfg <file> replays under a PINNED config snapshot
  // instead of whatever the desk runs today. Without it, the live sizing
  // change (maxNotionalPct 1 -> 40 on 2026-07-27) silently changes every
  // re-run of an older study — a golden re-run of H-AUTO-1 must be able to
  // load the config its signals header recorded.
  const i = process.argv.indexOf("--cfg");
  const src = i > 0 ? process.argv[i + 1]
                    : path.join(DESK, "plugins/binance/data/config.json");
  const raw = JSON.parse(fs.readFileSync(src, "utf8"));
  const c = { ...DEFAULTS, ...raw };
  for (const k of Object.keys(c)) if (/key|secret|token/i.test(k)) delete c[k];
  return c;
}

/* ------------------------------------------------------------------ data */

/** ISO candles → the {t,...,closeT} shape analyzeSymbol's `req` returns.
 *  closeT is derived as t + tfMs - 1, which is exactly how Binance defines it. */
function loadCandles(symbol, tf) {
  const f = path.join(CANDLES, `${symbol}-${tf}.json`);
  const step = TF_MS[tf];
  return JSON.parse(fs.readFileSync(f, "utf8")).map((c) => {
    const t = Date.parse(c.timestamp);
    return { t, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume, closeT: t + step - 1 };
  });
}

/** 4h bars from 1h bars. Exact — a 4h candle IS the union of its four 1h
 *  candles — so deriving beats downloading a second copy that could disagree. */
function aggregate(candles, factor, srcStep) {
  const out = [];
  const bucket = srcStep * factor;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const start = Math.floor(c.t / bucket) * bucket;
    const last = out[out.length - 1];
    if (!last || last.t !== start) {
      out.push({ t: start, open: c.open, high: c.high, low: c.low, close: c.close,
                 volume: c.volume, closeT: start + bucket - 1 });
    } else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    }
  }
  return out;
}

/** Index of the last candle whose CLOSE is at or before `nowMs`. Binary search
 *  because this runs ~120k times per symbol. */
function lastClosedIdx(candles, nowMs) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].closeT <= nowMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/* -------------------------------------------------------- replay transport */

/**
 * The ONLY endpoint analyzeSymbol touches is GET /fapi/v1/klines. Everything
 * else throws — that throw is the guarantee the harness never silently falls
 * back to the network or hits something this study has not modelled.
 */
function makeReplayReq(tapes, cursor) {
  return async function req(method, restPath, query) {
    if (method !== "GET" || restPath !== "/fapi/v1/klines")
      throw new Error(`replay req refuses ${method} ${restPath} — the harness models klines only`);
    const { symbol, interval, limit } = query || {};
    const tape = tapes[symbol] && tapes[symbol][interval];
    if (!tape) throw new Error(`no tape for ${symbol} ${interval}`);
    const end = lastClosedIdx(tape, cursor.now);
    if (end < 0) return { ok: true, json: [] };
    const n = Math.max(1, Number(limit) || 100);
    const slice = tape.slice(Math.max(0, end - n + 1), end + 1);
    // Raw Binance array shape — analyzeSymbol maps it itself, so the harness
    // must not hand it a pre-mapped object.
    return { ok: true, json: slice.map((c) => [c.t, String(c.open), String(c.high), String(c.low),
                                               String(c.close), String(c.volume), c.closeT]) };
  };
}


/* --------------------------------------------------------- exit occupancy */

/**
 * When would the live manager have closed this position?
 *
 * Mirrors managed_exit.py — hard stop first (a bar touching both the stop and
 * a +R trigger resolves as the STOP, because OHLC cannot tell us the order),
 * breakeven at +1R, trail armed at +2R and closed on a polled close that
 * crosses it. Only the exit BAR is needed here; PnL is computed once, on the
 * Python side, so there is exactly one accounting implementation.
 *
 * The two must agree on the exit bar, and that agreement is asserted rather
 * than assumed — the emitted `exit` rows exist so the Python run can check it.
 */
function resolveExitIdx(tape, pos, upto, tr) {
  const long = pos.side === "BUY";
  const risk = Math.abs(pos.entry - pos.stop);
  if (!(risk > 0)) return null;
  const beR = tr.breakevenTriggerR == null ? 1 : tr.breakevenTriggerR;
  const trailR = tr.trailActivateR == null ? 2 : tr.trailActivateR;
  const trailPct = tr.trailPct == null ? 1.5 : tr.trailPct;
  let stop = pos.stop, peak = pos.entry, armed = false, be = false;

  for (let i = pos.fromIdx; i <= upto; i++) {
    const b = tape[i];
    if (long ? b.low <= stop : b.high >= stop) {          // hard stop wins any tie
      const gap = long ? b.open <= stop : b.open >= stop;
      return { idx: i, price: gap ? b.open : stop, reason: be ? "BE_STOP" : "STOP_LOSS" };
    }
    const observed = long ? b.high : b.low;               // peak_from = "high"
    if (long ? observed > peak : observed < peak) peak = observed;
    const r = (long ? peak - pos.entry : pos.entry - peak) / risk;
    if (i === pos.fromIdx) continue;                      // the entry bar earns no trigger

    if (!be && beR > 0 && r >= beR) {
      const bb = (tr.beBufferPct != null ? tr.beBufferPct / 100 : 0.00225);
      const bePrice = long ? pos.entry * (1 + bb) : pos.entry * (1 - bb);
      if (long ? bePrice > stop : bePrice < stop) { stop = bePrice; be = true; }
    }
    if (trailR > 0 && r >= trailR) armed = true;
    if (armed) {
      const trail = long ? peak * (1 - trailPct / 100) : peak * (1 + trailPct / 100);
      const eff = long ? Math.max(trail, stop) : Math.min(trail, stop);
      if (long ? b.close <= eff : b.close >= eff)
        return { idx: i, price: b.close, reason: "TRAIL" };
    }
  }
  return null;                                            // still open at `upto`
}

/* ------------------------------------------------------------- gate chain */

const GRADE = { A: 3, B: 2, C: 1 };

/** Position sizing, mirroring sizeByRisk: risk% of equity over the stop
 *  distance, then clamped by the notional cap. On this desk the cap ALWAYS
 *  binds (1% of $5002 = $50), so real risk per trade is ~$0.33, not the $25
 *  that riskPct 0.5% advertises. */
function sizeSignal(r, c) {
  const tr = c.trendRules || {};
  const equity = c.simulatedEquity || 5002;
  const riskCeil = r.grade === "A" ? (tr.riskPctMaxGradeA || 2) : (tr.riskPctMax || 1);
  const riskPct = Math.min(tr.riskPct || 0.5, riskCeil);
  const stopDist = Math.abs(r.entry - r.stop);
  if (!(stopDist > 0)) return { blocked: "stop distance = 0" };
  let qty = (equity * riskPct / 100) / stopDist;
  const cap = equity * (c.maxNotionalPct || 0) / 100;
  let capped = false;
  if (cap && qty * r.entry > cap) { qty = cap / r.entry; capped = true; }
  const notional = qty * r.entry;
  return { qty, notional, capped, riskUsd: qty * stopDist, riskPct };
}

/**
 * Replays the guards in executeAutoSignal + autoTradeGuard order, keeping only
 * the ones that are modellable from historical data. The two that are not —
 * newsGate and requireCopilotApproval — are declared OFF, and both can only
 * ever REMOVE trades, so the resulting trade count is an UPPER BOUND and a
 * negative expectancy estimate is already the optimistic one.
 */
function gateChain(r, ctx) {
  const c = ctx.cfg;
  const rules = c.autoTradeSignalRules || {};
  if ((GRADE[r.grade] || 0) < (GRADE[rules.minGrade || "B"] || 0)) return "minGrade";
  const g = c.regimeGate || {};
  if (g.enabled !== false) {
    const rr = ctx.regime();
    if (!rr || !rr.regime) return "regimeGate:unavailable";      // fail-closed, as live
    if ((g.mode || "aligned") === "longOnly") {
      if (!(r.dir === "bull" && rr.regime === "Trend-Up")) return `regimeGate:longOnly:${rr.regime}`;
    } else if (rr.regime !== (r.dir === "bull" ? "Trend-Up" : "Trend-Down")) {
      return `regimeGate:${rr.regime}`;
    }
  }
  if (rules.onePositionAtATime && ctx.openCount() > 0) return "onePositionAtATime";
  const sized = sizeSignal(r, c);
  if (sized.blocked) return "sizing:" + sized.blocked;
  if (!c.tradeEnabled) return "tradeEnabled";
  if (!(c.allowedSymbols || []).includes(r.symbol)) return "allowlist";
  const atr = c.autoTradeRules || {};
  if (ctx.tradesToday() >= (atr.maxTradesPerDay || Infinity)) return "maxTradesPerDay";
  if (ctx.openCount() >= (c.maxConcurrentPositions || Infinity)) return "maxConcurrentPositions";
  if (atr.requireSetupGrade && (GRADE[r.grade] || 0) < (GRADE[atr.requireSetupGrade] || 0))
    return "requireSetupGrade";
  return { pass: true, sized };
}

/* ------------------------------------------------------------------- main */

function parseArgs(argv) {
  const a = { mode: "closed", out: "signals-scanner.jsonl", symbols: null, limit: 0 };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, ""), v = argv[i + 1];
    if (k === "limit") a.limit = Number(v); else if (k === "symbols") a.symbols = v.split(",");
    else a[k] = v;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = liveConfig();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const symbols = args.symbols || cfg.allowedSymbols;
  // A 5-coin study is exactly what produced the desk's recorded n=6 false
  // positive, so the wider universe must be runnable — but the allowlist gate
  // is real, so widening it is explicit and recorded in the header.
  if (args.universe === "study") cfg.allowedSymbols = symbols;
  const entryTf = cfg.entryTf || "15m", ctxTf = cfg.contextTf || "1h";
  const regimeTf = (cfg.regimeGate || {}).tf || "1h";

  const tapes = {};
  for (const s of symbols) {
    tapes[s] = { [entryTf]: loadCandles(s, entryTf) };
    if (ctxTf !== entryTf) tapes[s][ctxTf] = loadCandles(s, ctxTf);
    if (!tapes[s][regimeTf]) tapes[s][regimeTf] = loadCandles(s, regimeTf);
    tapes[s]["4h"] = aggregate(tapes[s]["1h"], 4, TF_MS["1h"]);   // regime context, derived exactly
  }

  const cursor = { now: 0 };
  const req = makeReplayReq(tapes, cursor);
  const out = fs.createWriteStream(path.join(__dirname, args.out));

  // Header carries the dataset identity. The Python side REFUSES a file whose
  // dataset_sha256 does not match the candles it was handed — that mismatch
  // latch is what stops a stale signal file being scored against fresh data.
  const datasetSha = crypto.createHash("sha256")
    .update(symbols.map((s) => `${s}:${(manifest.datasets[`${s}-${entryTf}`] || {}).sha256}`).sort().join("|"))
    .digest("hex");
  out.write(JSON.stringify({
    schema: "bagidea-signal-replay/v1", kind: "scanner", mode: args.mode,
    generatedAt: new Date().toISOString(), symbols, entryTf, ctxTf, regimeTf,
    dataset_sha256: datasetSha,
    code_sha256: crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(DESK, "plugins/binance/index.js"))).digest("hex"),
    cfg: { maxNotionalPct: cfg.maxNotionalPct, maxLeverage: cfg.maxLeverage,
           maxConcurrentPositions: cfg.maxConcurrentPositions,
           autoTradeRules: cfg.autoTradeRules, autoTradeSignalRules: cfg.autoTradeSignalRules,
           regimeGate: cfg.regimeGate, trendRules: cfg.trendRules, simulatedEquity: cfg.simulatedEquity },
    universe: args.universe === "study" ? "STUDY (allowlist widened to the 15-coin set)"
                                       : "LIVE (desk allowedSymbols only)",
    unmodelled: ["newsGate", "requireCopilotApproval"],
    unmodelled_note: "both can only REMOVE trades, so the emitted count is an upper bound",
  }) + "\n");

  // Live state, replayed: ONE dedup string shared across symbols (not per
  // symbol — that is what the live code does), open-position count, day count.
  let lastSignalKey = "";
  const open = [];
  const closedTrades = [];              // [{symbol, side, entry, stop, openedAt}]
  let dayKey = null, tradesDay = 0;
  const ctxState = {
    cfg,
    openCount: () => open.length,
    tradesToday: () => tradesDay,
    regime: null,
  };

  const base = tapes[symbols[0]][entryTf];
  const startIdx = 320;                                   // warm-up for TA + regime
  const endIdx = args.limit ? Math.min(base.length - 1, startIdx + args.limit) : base.length - 1;
  const taOpts = { stopMult: (cfg.trendRules || {}).atrStopMult || 2,
                   fixedTargetR: (cfg.trendRules || {}).fixedTargetR || 0 };

  let emitted = 0, blocked = 0, ticks = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    cursor.now = base[i].closeT;                          // decide at the close of bar i
    ticks++;
    const d = new Date(cursor.now).toISOString().slice(0, 10);
    if (d !== dayKey) { dayKey = d; tradesDay = 0; }

    // Free the slot when the position would have EXITED — under the desk's real
    // manager, not just its original stop.
    //
    // This matters far more than it looks. A first cut released the slot only
    // on a stop hit, so any trade that ran favourably and never came back
    // stayed "open" forever and onePositionAtATime locked the whole replay:
    // all 43 of its signals landed in 2023 and the following 2.5 years emitted
    // nothing at all. Occupancy decides WHICH signals fire, so it has to be
    // modelled in the same pass, under the same rules managed_exit.py uses.
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k];
      const tape = tapes[p.symbol][entryTf];
      const j = lastClosedIdx(tape, cursor.now);
      const ex = resolveExitIdx(tape, p, j, cfg.trendRules || {});
      if (ex) { p.exit = ex; closedTrades.push(p); open.splice(k, 1); }
    }

    const results = [];
    for (const s of symbols) {
      try {
        const r = await analyzeSymbol(s, req, entryTf, ctxTf, taOpts);
        if (r) results.push(r);
      } catch (e) {
        if (/refuses/.test(e.message)) throw e;            // never swallow a transport violation
      }
    }
    results.sort((a, b) => b.score - a.score);             // live ranking order

    for (const r of results) {
      if (r.grade !== "A" && r.grade !== "B") continue;
      const key = `${r.symbol}:${r.grade}:${r.dir}`;
      if (key === lastSignalKey) continue;                 // the LIVE single-string dedup
      lastSignalKey = key;

      ctxState.regime = () => {
        const h1 = tapes[r.symbol][regimeTf], h4 = tapes[r.symbol]["4h"];
        const e1 = lastClosedIdx(h1, cursor.now), e4 = lastClosedIdx(h4, cursor.now);
        if (e1 < 60) return null;
        const out = computeRegime(h1.slice(Math.max(0, e1 - 199), e1 + 1),
                                  h4.slice(Math.max(0, e4 - 119), e4 + 1), null, regimeTf);
        return out && out.ok ? out : null;
      };

      const verdict = gateChain(r, ctxState);
      if (typeof verdict === "string") {
        blocked++;
        out.write(JSON.stringify({ type: "blocked", ts: cursor.now, symbol: r.symbol,
                                   grade: r.grade, dir: r.dir, reason: verdict }) + "\n");
        continue;
      }
      const { sized } = verdict;
      const side = r.dir === "bull" ? "BUY" : "SELL";
      emitted++;
      tradesDay++;
      // Next-bar execution, matching the scoring side exactly: the decision is
      // made at the close of this bar, the fill is the NEXT bar's open, and the
      // stop is re-anchored to preserve the signal's risk distance so a gap
      // between decision and fill cannot silently change position risk.
      //
      // This is not cosmetic. A first cut entered here at the signal bar with
      // the signal's own stop, which shifted every +R trigger by a fraction and
      // left 82 of 985 trades (8.3%) disagreeing with the Python model about
      // WHICH BAR they exited on. Same rules on both sides is the only way that
      // number is zero by construction rather than by luck.
      const _tape = tapes[r.symbol][entryTf];
      const _sig = lastClosedIdx(_tape, cursor.now);
      const _fillIdx = _sig + 1;
      if (_fillIdx >= _tape.length - 2) continue;      // no room to resolve
      const _fill = _tape[_fillIdx].open * (side === "BUY" ? 1 + SLIP_BPS / 10000 : 1 - SLIP_BPS / 10000);
      const _risk = Math.abs(r.entry - r.stop);
      open.push({ symbol: r.symbol, side, entry: _fill,
                  stop: side === "BUY" ? _fill - _risk : _fill + _risk,
                  openedAt: cursor.now, fromIdx: _fillIdx });
      out.write(JSON.stringify({
        type: "signal", ts: cursor.now, symbol: r.symbol, side, dir: r.dir,
        grade: r.grade, score: r.score, signals: r.signals,
        entry: r.entry, stop: r.stop, target: r.target, atr: r.atr,
        qty: sized.qty, notional: sized.notional, notionalCapped: sized.capped,
        riskUsd: sized.riskUsd, structure: r.structure, aligned: r.aligned,
      }) + "\n");
    }
  }

  for (const p of open) { p.exit = { idx: null, price: null, reason: "STILL_OPEN" }; closedTrades.push(p); }
  for (const p of closedTrades)
    out.write(JSON.stringify({ type: "exit", ts: p.openedAt, symbol: p.symbol,
      exitIdx: p.exit.idx, exitPrice: p.exit.price, exitReason: p.exit.reason }) + "\n");
  out.write(JSON.stringify({ type: "summary", ticks, emitted, blocked,
    stillOpen: open.length, closed: closedTrades.length }) + "\n");
  out.end();
  console.error(`ticks ${ticks} · signals ${emitted} · blocked ${blocked} → ${args.out}`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
