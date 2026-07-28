"use strict";
/* trade-teams/engine.js — pure paper-trading engine for the team arena.
 * Mandate: trade_teams_2026_07_28. No I/O, no Date.now(), no Math.random():
 * every tick takes nowMs and every random decision (the control team) is a
 * seeded PRNG — the whole arena is replayable from its inputs.
 *
 * Execution semantics (pessimistic by construction, and cheat-proof):
 *  - market entries fill at mark shifted AGAINST you by slipPct; fee on notional
 *  - a stop is a stop-market: it triggers when the mark crosses it and fills
 *    AT THE MARK (which is at-or-worse than the stop level when detected)
 *  - a target fills AT THE TARGET LEVEL (a favorable gap pays only the target)
 *  - one tick crossing both stop and target → THE STOP WINS (same tie rule as
 *    managed_exit.py — the simulation never gets to flatter itself)
 *  - moving a stop/target to a level the mark has already crossed is rejected
 *    ("would trigger now") — profits cannot be conjured through modify
 */

const CFG = Object.freeze({
  startEquity: 10000,
  feePct: 0.06,          // taker, per side, on notional — ratified cost model
  slipPct: 0.03,         // per side, as an adverse price shift
  minStopPct: 1.0,       // same cost-floor geometry the real desk enforces
  maxRiskPctPerTrade: 1.0,
  maxNotionalPct: 50,
  maxConcurrent: 3,
  maxOpenOrders: 4,      // resting limit orders per team
  drawdownPauseAt: 0.60, // equity below 60% of start → team pauses for a retro
  controlTradeProb: 0.5, // control team: coin-flip per cycle, like teams may pass
  controlStopPct: 2.5,   // 2.5% keeps control's notional at 40% equity — inside the cap, not on it
});

const r2 = (v) => Math.round(v * 100) / 100;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

/* ---------------------------------------------------------------- PRNG --- */
// mulberry32 seeded from a string hash — deterministic control-team decisions.
function seededRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- books --- */
function newBook(team, cfg = CFG) {
  return {
    team, cash: cfg.startEquity, positions: [], openOrders: [],
    paused: false, pausedReason: null,
    stats: { trades: 0, wins: 0, losses: 0, feesUsd: 0, sumCostR: 0, sumPnlR: 0 },
    seq: 0,
  };
}

function equityOf(book, marks) {
  let eq = book.cash;
  for (const p of book.positions) {
    const m = marks[p.symbol];
    if (!Number.isFinite(m)) continue;           // unknown mark: count entry value
    eq += p.side === "LONG" ? (m - p.entry) * p.qty : (p.entry - m) * p.qty;
  }
  return eq;
}

/* ---------------------------------------------------------- validation --- */
// o = { symbol, side, riskUsd, stop, target?, limit? } · mark = current price.
function validateOrder(book, o, mark, cfg = CFG) {
  if (book.paused) return { reject: "team-paused: " + (book.pausedReason || "") };
  if (!o || !o.symbol) return { reject: "no-symbol" };
  if (o.side !== "LONG" && o.side !== "SHORT") return { reject: "side must be LONG|SHORT" };
  if (!Number.isFinite(mark) || mark <= 0) return { reject: "no-mark" };
  const entry = Number.isFinite(o.limit) ? o.limit : mark;
  if (!Number.isFinite(o.stop) || o.stop <= 0) return { reject: "mandatory-stop: ทุกไม้ต้องมี stop" };
  const long = o.side === "LONG";
  if (long ? o.stop >= entry : o.stop <= entry) return { reject: "stop-wrong-side" };
  if (o.target != null && (long ? o.target <= entry : o.target >= entry))
    return { reject: "target-wrong-side" };
  const stopPct = Math.abs(entry - o.stop) / entry * 100;
  if (stopPct < cfg.minStopPct)
    return { reject: `cost-floor: stop ${r2(stopPct)}% < ${cfg.minStopPct}% — geometry แพ้ค่าธรรมเนียม` };
  const equity = equityOf(book, { [o.symbol]: mark });
  const riskCap = cfg.maxRiskPctPerTrade / 100 * equity;
  const riskUsd = Math.min(Number(o.riskUsd) || riskCap, riskCap);
  if (riskUsd <= 0) return { reject: "risk-invalid" };
  const qty = riskUsd / Math.abs(entry - o.stop);
  const notional = qty * entry;
  if (notional > cfg.maxNotionalPct / 100 * equity)
    return { reject: `notional-cap: $${r2(notional)} > ${cfg.maxNotionalPct}% ของ equity` };
  if (book.positions.length + book.openOrders.length >= cfg.maxConcurrent)
    return { reject: `max-concurrent: ${cfg.maxConcurrent} (นับไม้เปิด + limit ค้าง)` };
  if (book.positions.some((p) => p.symbol === o.symbol) ||
      book.openOrders.some((w) => w.symbol === o.symbol))
    return { reject: "one-per-symbol: มีไม้/ออเดอร์ค้างในเหรียญนี้แล้ว" };
  if (Number.isFinite(o.limit) && o.limit <= 0) return { reject: "limit-invalid" };
  return { ok: true, entry, qty: r6(qty), riskUsd: r2(riskUsd), notional: r2(notional), stopPct: r2(stopPct) };
}

/* ----------------------------------------------------------- execution --- */
function fillWithSlip(side, price, cfg) {
  return side === "LONG" ? price * (1 + cfg.slipPct / 100) : price * (1 - cfg.slipPct / 100);
}

// Open at market (or record a resting limit order).
function placeOrder(book, o, mark, nowMs, cfg = CFG) {
  const v = validateOrder(book, o, mark, cfg);
  if (v.reject) return { reject: v.reject };
  const id = book.team.slice(0, 2) + "-" + (++book.seq);
  if (Number.isFinite(o.limit)) {
    const w = { id, symbol: o.symbol, side: o.side, limit: o.limit, stop: o.stop,
      target: o.target ?? null, riskUsd: v.riskUsd, placedAt: nowMs, note: o.note || null };
    book.openOrders.push(w);
    return { ok: true, resting: true, order: w };
  }
  const fill = fillWithSlip(o.side, mark, cfg);
  const qty = v.riskUsd / Math.abs(fill - o.stop);
  const fee = qty * fill * cfg.feePct / 100;
  book.cash -= fee;
  book.stats.feesUsd = r2(book.stats.feesUsd + fee);
  const p = { id, symbol: o.symbol, side: o.side, qty: r6(qty), entry: r6(fill),
    stop: o.stop, target: o.target ?? null, riskUsd: v.riskUsd,
    openedAt: nowMs, feePaid: r2(fee), note: o.note || null };
  book.positions.push(p);
  return { ok: true, position: p };
}

// Close helper: returns the trade record and mutates the book.
function settleClose(book, p, exitPrice, reason, nowMs, cfg) {
  const gross = p.side === "LONG" ? (exitPrice - p.entry) * p.qty : (p.entry - exitPrice) * p.qty;
  const fee = p.qty * exitPrice * cfg.feePct / 100;
  book.cash += gross - fee;
  book.positions = book.positions.filter((x) => x.id !== p.id);
  const pnlUsd = r2(gross - fee - p.feePaid);
  const pnlR = p.riskUsd > 0 ? r2(pnlUsd / p.riskUsd) : null;
  const costR = p.riskUsd > 0 ? r2((fee + p.feePaid) / p.riskUsd) : null;
  book.stats.trades++;
  book.stats.feesUsd = r2(book.stats.feesUsd + fee);
  if (pnlUsd >= 0) book.stats.wins++; else book.stats.losses++;
  if (costR != null) book.stats.sumCostR = r2(book.stats.sumCostR + costR);
  if (pnlR != null) book.stats.sumPnlR = r2(book.stats.sumPnlR + pnlR);
  return { id: p.id, team: book.team, symbol: p.symbol, side: p.side, qty: p.qty,
    entry: p.entry, exit: r6(exitPrice), stop: p.stop, target: p.target,
    riskUsd: p.riskUsd, pnlUsd, pnlR, costR, fees: r2(fee + p.feePaid),
    reason, openedAt: p.openedAt, closedAt: nowMs, note: p.note };
}

// One tick: resolve resting limits, stops, targets against fresh marks.
// Returns { events } and mutates the book. Stop wins any ambiguity.
function tickBook(book, marks, nowMs, cfg = CFG) {
  const events = [];
  // resting limit orders: LONG fills when mark <= limit; SHORT when mark >= limit
  for (const w of book.openOrders.slice()) {
    const m = marks[w.symbol];
    if (!Number.isFinite(m)) continue;
    const crossed = w.side === "LONG" ? m <= w.limit : m >= w.limit;
    if (!crossed) continue;
    book.openOrders = book.openOrders.filter((x) => x.id !== w.id);
    // If the same tick already sits beyond the stop, the fill is stillborn:
    // open and stop out at the mark in one motion (pessimistic, no free pass).
    const res = placeOrderFilledLimit(book, w, m, nowMs, cfg);
    events.push({ type: "limit-fill", team: book.team, order: w, result: res });
    if (res.position) {
      const stopHit = w.side === "LONG" ? m <= w.stop : m >= w.stop;
      if (stopHit) events.push({ type: "stop", team: book.team,
        trade: settleClose(book, res.position, fillWithSlip(w.side === "LONG" ? "SHORT" : "LONG", m, cfg), "stop", nowMs, cfg) });
    }
  }
  for (const p of book.positions.slice()) {
    const m = marks[p.symbol];
    if (!Number.isFinite(m)) continue;
    const long = p.side === "LONG";
    const stopHit = long ? m <= p.stop : m >= p.stop;
    const tgtHit = p.target != null && (long ? m >= p.target : m <= p.target);
    if (stopHit) {           // stop wins ties by construction (checked first)
      const exit = fillWithSlip(long ? "SHORT" : "LONG", m, cfg);
      events.push({ type: "stop", team: book.team, trade: settleClose(book, p, exit, "stop", nowMs, cfg) });
    } else if (tgtHit) {     // favorable gaps pay only the target level
      const exit = fillWithSlip(long ? "SHORT" : "LONG", p.target, cfg);
      events.push({ type: "target", team: book.team, trade: settleClose(book, p, exit, "target", nowMs, cfg) });
    }
  }
  // drawdown circuit: a team at -40% stands down until it amends its charter
  const eq = equityOf(book, marks);
  if (!book.paused && eq < cfg.drawdownPauseAt * cfg.startEquity) {
    book.paused = true;
    book.pausedReason = `drawdown ${r2((1 - eq / cfg.startEquity) * 100)}% — ต้อง amend ธรรมนูญก่อน resume`;
    events.push({ type: "team-paused", team: book.team, reason: book.pausedReason });
  }
  return { events };
}

// A limit order that just crossed: fill at the limit price (with slip), fee on notional.
function placeOrderFilledLimit(book, w, mark, nowMs, cfg) {
  const fill = fillWithSlip(w.side, w.limit, cfg);
  const qty = w.riskUsd / Math.abs(fill - w.stop);
  const fee = qty * fill * cfg.feePct / 100;
  book.cash -= fee;
  book.stats.feesUsd = r2(book.stats.feesUsd + fee);
  const p = { id: w.id, symbol: w.symbol, side: w.side, qty: r6(qty), entry: r6(fill),
    stop: w.stop, target: w.target, riskUsd: w.riskUsd, openedAt: nowMs,
    feePaid: r2(fee), note: w.note };
  book.positions.push(p);
  return { ok: true, position: p };
}

function manualClose(book, posId, mark, nowMs, cfg = CFG) {
  const p = book.positions.find((x) => x.id === posId);
  if (!p) return { reject: "no-position: " + posId };
  if (!Number.isFinite(mark)) return { reject: "no-mark" };
  const exit = fillWithSlip(p.side === "LONG" ? "SHORT" : "LONG", mark, cfg);
  return { ok: true, trade: settleClose(book, p, exit, "manual", nowMs, cfg) };
}

// Anti-cheat modify: a level the mark has already crossed is rejected.
function modifyPosition(book, posId, changes, mark, cfg = CFG) {
  const p = book.positions.find((x) => x.id === posId);
  if (!p) return { reject: "no-position: " + posId };
  if (!Number.isFinite(mark)) return { reject: "no-mark" };
  const long = p.side === "LONG";
  if (changes.stop != null) {
    if (long ? changes.stop >= mark : changes.stop <= mark)
      return { reject: "stop-would-trigger-now — ใช้ close ถ้าต้องการออก" };
    // Stops only tighten (move toward price). Widening a stop after entry is
    // risk beyond the sized riskUsd — the averaging-down cousin. Re-enter instead.
    if (long ? changes.stop < p.stop : changes.stop > p.stop)
      return { reject: "stop-widen-forbidden — ถ่าง stop = เพิ่ม risk เกินไซส์ที่คิดไว้; ปิดแล้วเข้าใหม่" };
    p.stop = changes.stop;
  }
  if (changes.target !== undefined) {
    if (changes.target != null && (long ? changes.target <= mark : changes.target >= mark))
      return { reject: "target-would-trigger-now" };
    p.target = changes.target;
  }
  return { ok: true, position: p };
}

function cancelOrder(book, orderId) {
  const w = book.openOrders.find((x) => x.id === orderId);
  if (!w) return { reject: "no-order: " + orderId };
  book.openOrders = book.openOrders.filter((x) => x.id !== orderId);
  return { ok: true, order: w };
}

/* ------------------------------------------------------------- control --- */
// The yardstick. Signal-blind, same caps, same costs, zero LLM involvement.
// Deterministic: (seed, cycleIdx) fully decide the action.
function controlDecide(seedStr, cycleIdx, book, symbols, marks, cfg = CFG) {
  const rng = seededRng(seedStr + ":" + cycleIdx);
  if (rng() > cfg.controlTradeProb) return null;              // pass, like teams may
  const free = symbols.filter((s) => Number.isFinite(marks[s]) &&
    !book.positions.some((p) => p.symbol === s) &&
    !book.openOrders.some((w) => w.symbol === s));
  if (!free.length || book.paused) return null;
  const symbol = free[Math.floor(rng() * free.length)];
  const side = rng() < 0.5 ? "LONG" : "SHORT";
  const mark = marks[symbol];
  const stop = side === "LONG"
    ? mark * (1 - cfg.controlStopPct / 100)
    : mark * (1 + cfg.controlStopPct / 100);
  const target = side === "LONG"
    ? mark * (1 + 2 * cfg.controlStopPct / 100)
    : mark * (1 - 2 * cfg.controlStopPct / 100);               // fixed 2R, no opinions
  return { symbol, side, stop: r6(stop), target: r6(target), note: "control:coin-flip" };
}

/* --------------------------------------------------------- leaderboard --- */
function leaderboard(books, marks, cfg = CFG) {
  return Object.values(books).map((b) => {
    const eq = equityOf(b, marks);
    const t = b.stats;
    return {
      team: b.team, equity: r2(eq), pnlPct: r2((eq / cfg.startEquity - 1) * 100),
      open: b.positions.length, resting: b.openOrders.length,
      trades: t.trades, winRate: t.trades ? r2(t.wins / t.trades * 100) : null,
      avgPnlR: t.trades ? r2(t.sumPnlR / t.trades) : null,
      avgCostR: t.trades ? r2(t.sumCostR / t.trades) : null,
      feesUsd: t.feesUsd, paused: b.paused,
    };
  }).sort((a, b) => b.equity - a.equity);
}

module.exports = {
  CFG, newBook, equityOf, validateOrder, placeOrder, tickBook, manualClose,
  modifyPosition, cancelOrder, controlDecide, leaderboard, seededRng,
};
