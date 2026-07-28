"use strict";
/* trade-teams — the paper trading arena (mandate: trade_teams_2026_07_28).
 *
 * AI teams with distinct constitutions trade VIRTUAL $10k books marked to live
 * testnet prices. One team is a seeded random control bot: the yardstick every
 * AI team is measured against. STRUCTURAL SAFETY: this plugin's only exchange
 * egress is the loopback below, gated by a frozen READ-ONLY allowlist — it can
 * never place, modify, or cancel a real order (pinned by trade-teams.test.js).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const engine = (() => {
  // Self-bust like smc-radar: the daemon only busts index.js on reload.
  const p = require.resolve("./engine");
  try { delete require.cache[p]; } catch {}
  return require(p);
})();

const PORT = process.env.BAGIDEA_PORT || 8787;
const AI_TEAMS = ["structure", "trend", "limitonly"];
const ALL_TEAMS = [...AI_TEAMS, "control"];
const TEAM_AGENT = { structure: "tt-structure", trend: "tt-trend", limitonly: "tt-limit" };
const TEAM_TH = { structure: "ทีมโครงสร้าง", trend: "ทีมเทรนด์", limitonly: "ทีมลิมิต", control: "ทีมสุ่ม (กรรมการ)" };
const CYCLE_MS = 4 * 3600 * 1000;      // one decision cycle per team per 4h
const CONTROL_SEED = "bagidea-arena-2026-07-28";   // committed = reproducible

// ---- THE read-only egress (the only http call site in this file) ----------
const ALLOWED_BINANCE_CMDS = Object.freeze(["price", "ticker", "klines", "funding", "status"]);

module.exports = (ctx) => {
  const D = ctx.dataDir;
  fs.mkdirSync(D, { recursive: true });
  let disposed = false;

  function callBinance(cmd, args) {
    if (!ALLOWED_BINANCE_CMDS.includes(cmd))
      return Promise.resolve({ ok: false, msg: "trade-teams egress blocked (read-only allowlist): " + cmd });
    return new Promise((resolve) => {
      const body = JSON.stringify({ cmd, args });
      const r = http.request({
        host: "127.0.0.1", port: PORT, path: "/plugin/binance/cmd", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      r.on("error", () => resolve(null));
      r.setTimeout(8000, () => { r.destroy(); resolve(null); });
      r.write(body);
      r.end();
    });
  }

  /* -------------------------------------------------------------- state --- */
  const booksFile = path.join(D, "books.json");
  const writeAtomic = (file, obj) => {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
  };
  const appendJsonl = (name, obj) => {
    try { fs.appendFileSync(path.join(D, name), JSON.stringify(obj) + "\n"); } catch {}
  };
  const readJsonl = (name, last) => {
    try {
      const rows = fs.readFileSync(path.join(D, name), "utf8").trim().split("\n")
        .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return last ? rows.slice(-last) : rows;
    } catch { return []; }
  };

  let state = (() => {
    try { return JSON.parse(fs.readFileSync(booksFile, "utf8")); } catch { return null; }
  })() || {
    books: Object.fromEntries(ALL_TEAMS.map((t) => [t, engine.newBook(t)])),
    cycleIdx: 0, nextCycleAt: {}, arenaPaused: false, startedAt: Date.now(),
  };
  const save = () => writeAtomic(booksFile, state);
  save();

  // Constitutions: repo-committed initial charter seeds the data copy once;
  // runtime amendments touch only the data copy + the history log.
  function constitutionOf(team) {
    const live = path.join(D, `constitution-${team}.md`);
    try { return fs.readFileSync(live, "utf8"); } catch {}
    try {
      const seed = fs.readFileSync(path.join(ctx.pluginDir, "constitutions", `${team}.md`), "utf8");
      fs.writeFileSync(live, seed);
      return seed;
    } catch { return "(ยังไม่มีธรรมนูญ)"; }
  }

  /* -------------------------------------------------------------- marks --- */
  let symbols = ["XRPUSDT", "BTCUSDT", "SOLUSDT", "BNBUSDT", "ETHUSDT"];
  let marks = {};
  async function refreshMarks() {
    const st = await callBinance("status");
    if (st && st.ok && Array.isArray(st.allowedSymbols) && st.allowedSymbols.length)
      symbols = st.allowedSymbols;
    const rows = await Promise.all(symbols.map((s) => callBinance("price", s)));
    for (const r of rows) if (r && r.ok && Number.isFinite(r.price)) marks[r.symbol] = r.price;
  }

  /* ------------------------------------------------------------- events --- */
  function routeClosedTrade(trade) {
    appendJsonl(`history-${trade.team}.jsonl`, trade);
    // Asymmetric learning (mandate): losses teach everyone, wins stay home.
    if (trade.pnlUsd < 0) appendJsonl("library-central-losses.jsonl", trade);
    else appendJsonl(`library-${trade.team}-wins.jsonl`, trade);
    const sign = trade.pnlUsd >= 0 ? "🟢" : "🔴";
    const m = `${sign} [ทีมเทรด] ${TEAM_TH[trade.team]} ปิด ${trade.symbol} ${trade.side} ` +
      `${trade.reason} · ${trade.pnlUsd >= 0 ? "+" : ""}$${trade.pnlUsd} (${trade.pnlR >= 0 ? "+" : ""}${trade.pnlR}R)`;
    ctx.feed(m, "ledger");
    ctx.broadcast({ type: "tt.trade", plugin: "trade-teams", trade });
  }

  /* -------------------------------------------------------------- loops --- */
  // Dispose contract + globalThis registry — same anti-leak pattern as binance.
  globalThis.__bagideaTradeTeamsLoops = globalThis.__bagideaTradeTeamsLoops || { monitor: 0 };
  const LOOPS = globalThis.__bagideaTradeTeamsLoops;

  const monitorTimer = setInterval(async () => {
    if (disposed || state.arenaPaused) return;
    try {
      await refreshMarks();
      let changed = false;
      for (const t of ALL_TEAMS) {
        const { events } = engine.tickBook(state.books[t], marks, Date.now());
        for (const ev of events) {
          changed = true;
          if (ev.trade) routeClosedTrade(ev.trade);
          else if (ev.type === "team-paused")
            ctx.feed(`⛔ [ทีมเทรด] ${TEAM_TH[t]} หยุดชั่วคราว: ${ev.reason}`, "compass");
        }
      }
      if (changed) save();
      // equity curve: one snapshot per ~30 min rides the 30s loop
      if (!state._lastCurveAt || Date.now() - state._lastCurveAt > 30 * 60 * 1000) {
        state._lastCurveAt = Date.now();
        appendJsonl("equity-curve.jsonl", { ts: Date.now(),
          eq: Object.fromEntries(ALL_TEAMS.map((t) => [t, Math.round(engine.equityOf(state.books[t], marks) * 100) / 100])) });
        save();
      }
      // decision cycles
      for (const t of ALL_TEAMS) {
        const due = state.nextCycleAt[t] || 0;
        if (Date.now() < due) continue;
        // stagger so 4 teams never fire at once
        state.nextCycleAt[t] = Date.now() + CYCLE_MS + ALL_TEAMS.indexOf(t) * 10 * 60 * 1000;
        save();
        if (t === "control") runControlCycle();
        else fireTeamCycle(t).catch((e) => ctx.log("trade-teams: cycle " + t + " failed: " + e.message));
      }
    } catch (e) { ctx.log("trade-teams: monitor error: " + e.message); }
  }, 30000);
  LOOPS.monitor++;
  ctx.log("trade-teams: arena loop started (live loops: " + LOOPS.monitor + ")");

  function runControlCycle() {
    state.cycleIdx++;
    const d = engine.controlDecide(CONTROL_SEED, state.cycleIdx, state.books.control, symbols, marks);
    if (!d) { appendJsonl("history-control.jsonl", { ts: Date.now(), cycle: state.cycleIdx, pass: true }); save(); return; }
    const r = engine.placeOrder(state.books.control, d, marks[d.symbol], Date.now());
    save();
    if (r.ok) ctx.feed(`🎲 [ทีมเทรด] กรรมการสุ่มเข้า ${d.symbol} ${d.side} (stop 2.5% · 2R) — ไม้บรรทัดของกระดาน`, "ledger");
  }

  /* ----------------------------------------------------- team AI cycles --- */
  function bookBrief(team) {
    const b = state.books[team];
    const eq = Math.round(engine.equityOf(b, marks) * 100) / 100;
    const pos = b.positions.map((p) =>
      `${p.id} ${p.symbol} ${p.side} qty ${p.qty} @${p.entry} stop ${p.stop} target ${p.target ?? "runner"} (mark ${marks[p.symbol] ?? "?"})`).join("\n") || "(ไม่มีไม้เปิด)";
    const rest = b.openOrders.map((w) =>
      `${w.id} ${w.symbol} ${w.side} limit ${w.limit} stop ${w.stop}`).join("\n") || "(ไม่มี limit ค้าง)";
    return `equity $${eq} · เทรดแล้ว ${b.stats.trades} (ชนะ ${b.stats.wins}) · ค่าธรรมเนียมสะสม $${b.stats.feesUsd}` +
      (b.paused ? `\n⛔ ทีมถูกพัก: ${b.pausedReason}` : "") +
      `\nไม้เปิด:\n${pos}\nออเดอร์ค้าง:\n${rest}`;
  }

  async function fireTeamCycle(team, retro = false) {
    const agent = TEAM_AGENT[team];
    const losses = readJsonl("library-central-losses.jsonl", 8)
      .map((t) => `- ${TEAM_TH[t.team] || t.team}: ${t.symbol} ${t.side} ${t.pnlR}R (${t.reason})${t.note ? " · " + t.note : ""}`).join("\n") || "(ยังว่าง)";
    const wins = readJsonl(`library-${team}-wins.jsonl`, 5)
      .map((t) => `- ${t.symbol} ${t.side} +${t.pnlR}R (${t.reason})${t.note ? " · " + t.note : ""}`).join("\n") || "(ยังว่าง)";
    const mkLine = symbols.map((s) => `${s} ${marks[s] ?? "?"}`).join(" · ");
    const prompt = [
      `[TRADE-TEAMS ${retro ? "RETRO ประจำสัปดาห์" : "รอบตัดสินใจ"}] คุณคือหัวหน้า${TEAM_TH[team]} — สนามซ้อม paper บน testnet marks`,
      ``,
      `ธรรมนูญทีมคุณ (คุณเขียนแก้ได้เอง):`,
      constitutionOf(team),
      ``,
      `สมุดบัญชีทีม: ${bookBrief(team)}`,
      `ราคา: ${mkLine}`,
      `บทเรียนกลาง (ไม้เสียของทุกทีม):\n${losses}`,
      `คลังชนะของทีมคุณ (ทีมอื่นมองไม่เห็น):\n${wins}`,
      ``,
      `เครื่องมือวิเคราะห์: \`smc <SYM>\` · \`levels <SYM>\` · \`regime <SYM> 1h\` (regime-radar) · \`klines <SYM> 1h 100\``,
      `คำสั่งจัดการไม้ (plugin trade-teams):`,
      `  tt-order ${team} <SYM> <LONG|SHORT> <stop> [target] [@limit]   — ขนาดไม้ระบบคิดให้ (risk 1% ของ equity)`,
      `  tt-modify ${team} <posId> [stop=X] [target=Y]   — stop ขยับได้ทาง "รัด" เท่านั้น`,
      `  tt-close ${team} <posId>`,
      `  tt-cancel ${team} <orderId>`,
      `  tt-note ${team} <ข้อความ>   — journal ของทีม`,
      `  tt-amend ${team} <ข้อความ>   — แก้ธรรมนูญ (แนบเหตุผล)`,
      ``,
      `กติกาเหล็ก: ทุกไม้ต้องมี stop · stop แคบกว่า 1% ถูกปฏิเสธ (คณิตต้นทุน) · ไม่เข้าไม้ = ความเห็นที่ถูกต้องเสมอถ้าไม่เจอ setup ตามธรรมนูญ`,
      `KPI ของคุณคือ "กระบวนการ": ทำตามธรรมนูญตัวเอง, cost-in-R ต่ำ, journal ครบ — ไม่ใช่ % กำไร`,
      retro ? `นี่คือ RETRO: ทบทวนไม้ทั้งหมดสัปดาห์นี้เทียบธรรมนูญ แล้วถ้าเจอบทเรียนจริงให้ tt-amend พร้อมเหตุผล` :
        `ประเมินตอนนี้: จัดการไม้เปิดก่อน แล้วถ้ามี setup ตรงธรรมนูญค่อยเข้าใหม่ ถ้าไม่มี ให้ tt-note เหตุผลสั้น ๆ แล้วจบ`,
    ].join("\n");
    ctx.runClaude(agent, prompt);
    appendJsonl("cycles.jsonl", { ts: Date.now(), team, retro });
    ctx.log(`trade-teams: cycle fired → ${agent}${retro ? " (retro)" : ""}`);
  }

  /* ----------------------------------------------------------- commands --- */
  function teamArg(args) {
    const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
    const team = (parts[0] || "").toLowerCase();
    return { team: ALL_TEAMS.includes(team) ? team : null, parts };
  }

  return {
    dispose() {
      disposed = true;
      clearInterval(monitorTimer);
      LOOPS.monitor--;
      try { save(); } catch {}
    },

    async onCommand(cmd, args, reply) {
      if (cmd === "tt-board") {
        await refreshMarks().catch(() => {});
        const rows = engine.leaderboard(state.books, marks);
        const medal = ["🥇", "🥈", "🥉", "4️⃣"];
        const lines = rows.map((r, i) =>
          `${medal[i] || "·"} ${TEAM_TH[r.team]} — $${r.equity} (${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct}%) · ` +
          `ไม้ ${r.trades} · win ${r.winRate ?? "-"}% · avg ${r.avgPnlR ?? "-"}R · cost ${r.avgCostR ?? "-"}R` +
          (r.paused ? " · ⛔พัก" : ""));
        const ctrl = rows.find((r) => r.team === "control");
        const beat = rows.filter((r) => r.team !== "control" && r.equity > ctrl.equity).length;
        lines.push(`— ทีม AI ชนะกรรมการสุ่ม ${beat}/${AI_TEAMS.length} · กระดานนี้วัด "ชนะบอทสุ่มไหม" ไม่ใช่ "เขียวไหม"`);
        return reply({ ok: true, board: rows, msg: "🏟 กระดานทีมเทรด (paper)\n" + lines.join("\n") });
      }

      if (cmd === "tt-book") {
        const { team } = teamArg(args);
        if (!team) return reply({ ok: false, msg: "usage: tt-book <" + ALL_TEAMS.join("|") + ">" });
        await refreshMarks().catch(() => {});
        return reply({ ok: true, team, brief: bookBrief(team), book: state.books[team],
          constitution: constitutionOf(team) });
      }

      if (cmd === "tt-order") {
        // tt-order <team> <SYM> <LONG|SHORT> <stop> [target] [@limit]
        const { team, parts } = teamArg(args);
        if (!team) return reply({ ok: false, msg: "usage: tt-order <team> <SYM> <LONG|SHORT> <stop> [target] [@limit]" });
        if (team === "control") return reply({ ok: false, msg: "กรรมการสุ่มไม่รับคำสั่ง — นั่นคือประเด็นของมัน" });
        const symbol = (parts[1] || "").toUpperCase();
        const side = (parts[2] || "").toUpperCase();
        const stop = Number(parts[3]);
        const atIdx = parts.findIndex((x) => x.startsWith("@"));
        const target = parts[4] && !parts[4].startsWith("@") ? Number(parts[4]) : null;
        const limit = atIdx >= 0 ? Number(parts[atIdx].slice(1)) : null;
        await refreshMarks().catch(() => {});
        const mark = marks[symbol];
        if (!symbols.includes(symbol)) return reply({ ok: false, msg: "เหรียญนอกสนาม: " + symbols.join(", ") });
        const r = engine.placeOrder(state.books[team],
          { symbol, side, stop, target, ...(limit != null ? { limit } : {}) }, mark, Date.now());
        save();
        if (r.reject) return reply({ ok: false, blocked: true, msg: r.reject });
        const what = r.resting ? `ตั้ง limit ${r.order.limit}` : `เข้า @${r.position.entry} (qty ${r.position.qty})`;
        ctx.feed(`📋 [ทีมเทรด] ${TEAM_TH[team]} ${symbol} ${side} ${what} stop ${stop}`, "ledger");
        ctx.broadcast({ type: "tt.order", plugin: "trade-teams", team, result: r });
        return reply({ ok: true, ...r });
      }

      if (cmd === "tt-modify") {
        const { team, parts } = teamArg(args);
        if (!team || team === "control") return reply({ ok: false, msg: "usage: tt-modify <team> <posId> [stop=X] [target=Y]" });
        const posId = parts[1];
        const changes = {};
        for (const p of parts.slice(2)) {
          const m = /^(stop|target)=([\d.]+|null)$/i.exec(p);
          if (m) changes[m[1].toLowerCase()] = m[2] === "null" ? null : Number(m[2]);
        }
        await refreshMarks().catch(() => {});
        const pos = state.books[team].positions.find((x) => x.id === posId);
        const r = engine.modifyPosition(state.books[team], posId, changes, pos ? marks[pos.symbol] : NaN);
        save();
        if (r.reject) return reply({ ok: false, blocked: true, msg: r.reject });
        ctx.feed(`🔧 [ทีมเทรด] ${TEAM_TH[team]} ปรับ ${posId} → stop ${r.position.stop} target ${r.position.target ?? "runner"}`, "ledger");
        return reply({ ok: true, position: r.position });
      }

      if (cmd === "tt-close") {
        const { team, parts } = teamArg(args);
        if (!team || team === "control") return reply({ ok: false, msg: "usage: tt-close <team> <posId>" });
        await refreshMarks().catch(() => {});
        const pos = state.books[team].positions.find((x) => x.id === parts[1]);
        const r = engine.manualClose(state.books[team], parts[1], pos ? marks[pos.symbol] : NaN, Date.now());
        save();
        if (r.reject) return reply({ ok: false, msg: r.reject });
        routeClosedTrade(r.trade);
        return reply({ ok: true, trade: r.trade });
      }

      if (cmd === "tt-cancel") {
        const { team, parts } = teamArg(args);
        if (!team || team === "control") return reply({ ok: false, msg: "usage: tt-cancel <team> <orderId>" });
        const r = engine.cancelOrder(state.books[team], parts[1]);
        save();
        return reply(r.reject ? { ok: false, msg: r.reject } : { ok: true, order: r.order });
      }

      if (cmd === "tt-note") {
        const { team, parts } = teamArg(args);
        if (!team) return reply({ ok: false, msg: "usage: tt-note <team> <text>" });
        const text = parts.slice(1).join(" ");
        appendJsonl(`journal-${team}.jsonl`, { ts: Date.now(), text });
        return reply({ ok: true });
      }

      if (cmd === "tt-amend") {
        const { team, parts } = teamArg(args);
        if (!team || team === "control") return reply({ ok: false, msg: "usage: tt-amend <team> <text> (กรรมการสุ่มแก้ธรรมนูญไม่ได้ — ความสุ่มคือธรรมนูญ)" });
        const text = parts.slice(1).join(" ");
        if (!text) return reply({ ok: false, msg: "ต้องแนบเนื้อหา + เหตุผล" });
        const cur = constitutionOf(team);
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        fs.writeFileSync(path.join(D, `constitution-${team}.md`),
          cur + `\n\n## แก้ไข ${stamp}\n${text}\n`);
        appendJsonl("constitution-history.jsonl", { ts: Date.now(), team, text });
        // An amendment un-pauses a drawdown-paused team: the retro happened.
        if (state.books[team].paused) {
          state.books[team].paused = false;
          state.books[team].pausedReason = null;
          save();
        }
        ctx.feed(`📜 [ทีมเทรด] ${TEAM_TH[team]} แก้ธรรมนูญ: ${text.slice(0, 120)}`, "compass");
        return reply({ ok: true, msg: "บันทึกลงธรรมนูญ + history แล้ว" });
      }

      if (cmd === "tt-cycle") {
        const { team } = teamArg(args);
        if (!team) return reply({ ok: false, msg: "usage: tt-cycle <team> [retro]" });
        const retro = /retro/.test(String(args));
        await refreshMarks().catch(() => {});
        if (team === "control") { runControlCycle(); return reply({ ok: true, msg: "control cycle ran" }); }
        fireTeamCycle(team, retro).catch((e) => ctx.log("trade-teams: manual cycle failed: " + e.message));
        return reply({ ok: true, msg: `cycle fired → ${TEAM_AGENT[team]}${retro ? " (retro)" : ""}` });
      }

      if (cmd === "tt-pause") {
        state.arenaPaused = !/resume/.test(String(args || ""));
        save();
        return reply({ ok: true, arenaPaused: state.arenaPaused });
      }

      if (cmd === "tt-health") {
        return reply({ ok: true, loops: { ...LOOPS }, arenaPaused: state.arenaPaused,
          symbols, lastCurveAt: state._lastCurveAt || null,
          teams: Object.fromEntries(ALL_TEAMS.map((t) => [t, {
            positions: state.books[t].positions.length, paused: state.books[t].paused }])) });
      }

      return reply({ ok: false, msg: "unknown command (tt-board | tt-book | tt-order | tt-modify | tt-close | tt-cancel | tt-note | tt-amend | tt-cycle | tt-pause | tt-health)" });
    },
  };
};
