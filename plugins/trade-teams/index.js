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
const crypto = require("crypto");
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

  // Hydration (red team): ENOENT = fresh start; an UNREADABLE file must never
  // silently reset the arena and overwrite the evidence — quarantine + pause.
  let corruptBoot = false;
  let state = (() => {
    let raw = null;
    try { raw = fs.readFileSync(booksFile, "utf8"); } catch { return null; }   // ENOENT → fresh
    try { return JSON.parse(raw); } catch {
      const q = booksFile + ".corrupt-" + Date.now();
      try { fs.renameSync(booksFile, q); } catch {}
      corruptBoot = true;
      ctx.log("trade-teams: books.json unreadable — quarantined to " + q + ", arena starts PAUSED");
      return null;
    }
  })() || {
    books: {}, cycleIdx: 0, nextCycleAt: {}, arenaPaused: corruptBoot, startedAt: Date.now(),
  };
  // Deep-merge every persisted book over a fresh newBook so schema growth
  // (new fields) and roster changes (new teams) can never NaN-poison a book
  // or kill the tick loop on a missing key (red-team finding).
  for (const t of ALL_TEAMS) {
    const base = engine.newBook(t);
    const cur = state.books[t] || {};
    state.books[t] = { ...base, ...cur, stats: { ...base.stats, ...(cur.stats || {}) } };
    if (!Number.isFinite(state.books[t].seq)) state.books[t].seq = 0;
    for (const k of Object.keys(base.stats))
      if (!Number.isFinite(state.books[t].stats[k])) state.books[t].stats[k] = 0;
  }
  const saveRaw = () => writeAtomic(booksFile, state);
  // A disposed instance must never write state — its snapshot is stale by
  // definition once the next generation hydrates (red-team lifecycle finding).
  const save = () => { if (!disposed) saveRaw(); };
  saveRaw();
  if (corruptBoot) try { ctx.feed("⛔ [ทีมเทรด] books.json อ่านไม่ได้ — quarantine ไว้แล้ว arena เริ่มแบบ PAUSED รอเจ้าของดู", "compass"); } catch {}

  // Per-team command keys: the office command door carries no caller identity,
  // so each cycle prompt hands the team its own key and mutating commands
  // require it — Atlas cannot close Ridge's winner (red-team finding).
  const keysFile = path.join(D, "team-keys.json");
  let teamKeys = (() => { try { return JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch { return null; } })();
  if (!teamKeys) {
    teamKeys = Object.fromEntries(AI_TEAMS.map((t) => [t, crypto.randomBytes(6).toString("hex")]));
    fs.writeFileSync(keysFile, JSON.stringify(teamKeys, null, 1), { mode: 0o600 });
  }

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
  // Marks carry timestamps and go stale (red team: a silent 20-min-old mark
  // let orders fill at pre-move prices). freshMarks() is what the engine sees:
  // stale symbols simply vanish, so stops neither fire nor fill on old data
  // and mutating commands can refuse. Fail-closed, like every desk guard.
  const MARK_TTL_MS = 120000;
  let symbols = ["XRPUSDT", "BTCUSDT", "SOLUSDT", "BNBUSDT", "ETHUSDT"];
  let marks = {};      // symbol -> { price, ts }
  async function refreshMarks() {
    const st = await callBinance("status");
    if (st && st.ok && Array.isArray(st.allowedSymbols) && st.allowedSymbols.length)
      symbols = st.allowedSymbols;
    const rows = await Promise.all(symbols.map((s) => callBinance("price", s)));
    for (const r of rows) if (r && r.ok && Number.isFinite(r.price))
      marks[r.symbol] = { price: r.price, ts: Date.now() };
  }
  function freshMarks() {
    const now = Date.now(), out = {};
    for (const [s, m] of Object.entries(marks))
      if (m && now - m.ts <= MARK_TTL_MS) out[s] = m.price;
    return out;
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

  // Fixed cycle phases (red team: adding the index offset at FIRE time made
  // the period per-team unequal — the control benchmark got ~11% fewer cycles
  // than the teams measured against it — and boot/downtime fired all four at
  // once). Phase is assigned once; reschedule preserves it: due + k*CYCLE_MS.
  for (const t of ALL_TEAMS)
    if (!Number.isFinite(state.nextCycleAt[t]))
      state.nextCycleAt[t] = Date.now() + (ALL_TEAMS.indexOf(t) + 1) * 10 * 60 * 1000;

  let monitorTimer = setInterval(async () => {
    if (disposed) return;
    try {
      await refreshMarks();
      if (disposed) return;              // reload can complete during the await
      const fm = freshMarks();
      let events = [];
      for (const t of ALL_TEAMS) {
        // arenaPaused suspends DECISIONS only — stops/targets keep enforcing
        // (red team: freezing fills while tt-close stayed live was a moneymaker).
        const r = engine.tickBook(state.books[t], fm, Date.now());
        events = events.concat(r.events);
      }
      if (disposed) return;
      if (events.length) save();         // book of record first…
      for (const ev of events) {         // …then the learning corpus + feed
        if (ev.trade) routeClosedTrade(ev.trade);
        else if (ev.type === "team-paused")
          ctx.feed(`⛔ [ทีมเทรด] ${TEAM_TH[ev.team]} หยุดชั่วคราว: ${ev.reason}`, "compass");
      }
      // equity curve: one snapshot per ~30 min rides the 30s loop
      if (!state._lastCurveAt || Date.now() - state._lastCurveAt > 30 * 60 * 1000) {
        state._lastCurveAt = Date.now();
        appendJsonl("equity-curve.jsonl", { ts: Date.now(),
          eq: Object.fromEntries(ALL_TEAMS.map((t) => [t, Math.round(engine.equityOf(state.books[t], fm) * 100) / 100])) });
        save();
      }
      if (state.arenaPaused) return;     // decisions stop here; physics ran above
      for (const t of ALL_TEAMS) {
        const due = state.nextCycleAt[t] || 0;
        if (Date.now() < due) continue;
        let next = due + CYCLE_MS;       // phase-preserving, clamped past downtime
        while (next <= Date.now()) next += CYCLE_MS;
        state.nextCycleAt[t] = next;
        save();
        if (disposed) return;
        if (t === "control") runControlCycle();
        else fireTeamCycle(t).catch((e) => ctx.log("trade-teams: cycle " + t + " failed: " + e.message));
      }
    } catch (e) { ctx.log("trade-teams: monitor error: " + e.message); }
  }, 30000);
  LOOPS.monitor++;
  ctx.log("trade-teams: arena loop started (live loops: " + LOOPS.monitor + ")");

  function runControlCycle() {
    state.cycleIdx++;
    const fm = freshMarks();
    const d = engine.controlDecide(CONTROL_SEED, state.cycleIdx, state.books.control, symbols, fm);
    if (!d) { appendJsonl("history-control.jsonl", { ts: Date.now(), cycle: state.cycleIdx, pass: true }); save(); return; }
    const r = engine.placeOrder(state.books.control, d, fm[d.symbol], Date.now(), undefined, fm);
    save();
    if (r.ok) ctx.feed(`🎲 [ทีมเทรด] กรรมการสุ่มเข้า ${d.symbol} ${d.side} (stop 2.5% · 2R) — ไม้บรรทัดของกระดาน`, "ledger");
  }

  /* ----------------------------------------------------- team AI cycles --- */
  function bookBrief(team) {
    const b = state.books[team];
    const fm = freshMarks();
    const eq = Math.round(engine.equityOf(b, fm) * 100) / 100;
    const pos = b.positions.map((p) =>
      `${p.id} ${p.symbol} ${p.side} qty ${p.qty} @${p.entry} stop ${p.stop} target ${p.target ?? "runner"} (mark ${fm[p.symbol] ?? "?"})`).join("\n") || "(ไม่มีไม้เปิด)";
    const rest = b.openOrders.map((w) =>
      `${w.id} ${w.symbol} ${w.side} limit ${w.limit} stop ${w.stop}`).join("\n") || "(ไม่มี limit ค้าง)";
    return `equity $${eq} · เทรดแล้ว ${b.stats.trades} (ชนะ ${b.stats.wins}) · ค่าธรรมเนียมสะสม $${b.stats.feesUsd}` +
      (b.paused ? `\n⛔ ทีมถูกพัก: ${b.pausedReason}` : "") +
      `\nไม้เปิด:\n${pos}\nออเดอร์ค้าง:\n${rest}`;
  }

  async function fireTeamCycle(team, retro = false) {
    const agent = TEAM_AGENT[team];
    // runClaude tolerates unknown agents by falling back to a toolless default
    // — a deleted tt-* agent would silently burn a cycle every 4h (red team).
    if (!ctx.reg || !ctx.reg.agents || !ctx.reg.agents[agent]) {
      ctx.feed(`⚠️ [ทีมเทรด] agent ${agent} หายจาก registry — ${TEAM_TH[team]} ข้ามรอบนี้`, "compass");
      return;
    }
    const losses = readJsonl("library-central-losses.jsonl", 8)
      .map((t) => `- ${TEAM_TH[t.team] || t.team}: ${t.symbol} ${t.side} ${t.pnlR}R (${t.reason})${t.note ? " · " + t.note : ""}`).join("\n") || "(ยังว่าง)";
    const wins = readJsonl(`library-${team}-wins.jsonl`, 5)
      .map((t) => `- ${t.symbol} ${t.side} +${t.pnlR}R (${t.reason})${t.note ? " · " + t.note : ""}`).join("\n") || "(ยังว่าง)";
    const fmLine = freshMarks();
    const mkLine = symbols.map((s) => `${s} ${fmLine[s] ?? "?"}`).join(" · ");
    const key = teamKeys[team];
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
      `คำสั่งจัดการไม้ (plugin trade-teams) — ทุกคำสั่งต้องลงท้ายด้วยกุญแจทีม \`key=${key}\` (กุญแจส่วนตัว ห้ามเผยแพร่):`,
      `  tt-order ${team} <SYM> <LONG|SHORT> <stop> [target] [@limit] key=${key}   — ขนาดไม้ระบบคิดให้ (risk 1% ของ equity)`,
      `  tt-modify ${team} <posId> [stop=X] [target=Y] key=${key}   — stop ขยับได้ทาง "รัด" เท่านั้น`,
      `  tt-close ${team} <posId> key=${key}`,
      `  tt-cancel ${team} <orderId> key=${key}`,
      `  tt-note ${team} <ข้อความ> key=${key}   — journal ของทีม`,
      `  tt-amend ${team} <ข้อความ> key=${key}   — แก้ธรรมนูญ (แนบเหตุผล)`,
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
    const raw = String(args || "").trim().split(/\s+/).filter(Boolean);
    let key = null;
    const parts = raw.filter((p) => {
      const m = /^key=(\S+)$/.exec(p);
      if (m) { key = m[1]; return false; }
      return true;
    });
    const team = (parts[0] || "").toLowerCase();
    return { team: ALL_TEAMS.includes(team) ? team : null, parts, key };
  }
  // The command door carries no caller identity, so mutations authenticate
  // with the per-team key handed out inside that team's own cycle prompt.
  function badKey(team, key) {
    if (!AI_TEAMS.includes(team)) return null;
    if (key && teamKeys[team] === key) return null;
    return { ok: false, blocked: true, msg: "team-key ไม่ถูกต้อง — จัดการได้เฉพาะสมุดทีมตัวเอง (กุญแจอยู่ใน cycle prompt ของทีม)" };
  }
  const pausedReject = () => ({ ok: false, msg: "arena paused — ระหว่างพักห้ามแก้สมุด (ราคา/ไม้ยังถูก mark ตามจริง)" });
  const disposedReject = () => ({ ok: false, msg: "instance disposed (reload) — ลองใหม่" });

  return {
    dispose() {
      disposed = true;
      if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; LOOPS.monitor--; }
      try { saveRaw(); } catch {}
    },

    async onCommand(cmd, args, reply) {
      if (cmd === "tt-board") {
        await refreshMarks().catch(() => {});
        const rows = engine.leaderboard(state.books, freshMarks());
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
        // tt-order <team> <SYM> <LONG|SHORT> <stop> [target] [@limit] key=<k>
        const { team, parts, key } = teamArg(args);
        if (!team) return reply({ ok: false, msg: "usage: tt-order <team> <SYM> <LONG|SHORT> <stop> [target] [@limit] key=<k>" });
        if (team === "control") return reply({ ok: false, msg: "กรรมการสุ่มไม่รับคำสั่ง — นั่นคือประเด็นของมัน" });
        const auth = badKey(team, key);
        if (auth) return reply(auth);
        if (state.arenaPaused) return reply(pausedReject());
        const symbol = (parts[1] || "").toUpperCase();
        const side = (parts[2] || "").toUpperCase();
        const stop = Number(parts[3]);
        const atIdx = parts.findIndex((x) => x.startsWith("@"));
        const target = parts[4] && !parts[4].startsWith("@") ? Number(parts[4]) : null;
        const limit = atIdx >= 0 ? Number(parts[atIdx].slice(1)) : null;
        await refreshMarks().catch(() => {});
        if (disposed) return reply(disposedReject());
        const fm = freshMarks();
        const mark = fm[symbol];
        if (!symbols.includes(symbol)) return reply({ ok: false, msg: "เหรียญนอกสนาม: " + symbols.join(", ") });
        if (!Number.isFinite(mark)) return reply({ ok: false, msg: "mark ของ " + symbol + " เก่าเกิน/ดึงไม่ได้ — ไม่รับออเดอร์บนราคาที่เชื่อไม่ได้" });
        // Tick this book on the fresh marks BEFORE sizing: stops/pauses that
        // should already have happened must not be outrun by a new order.
        const pre = engine.tickBook(state.books[team], fm, Date.now());
        if (pre.events.length) { save(); for (const ev of pre.events) if (ev.trade) routeClosedTrade(ev.trade); }
        const r = engine.placeOrder(state.books[team],
          { symbol, side, stop, target, ...(limit != null ? { limit } : {}) }, mark, Date.now(), undefined, fm);
        save();
        if (r.reject) return reply({ ok: false, blocked: true, msg: r.reject });
        const what = r.resting ? `ตั้ง limit ${r.order.limit}` : `เข้า @${r.position.entry} (qty ${r.position.qty})`;
        ctx.feed(`📋 [ทีมเทรด] ${TEAM_TH[team]} ${symbol} ${side} ${what} stop ${stop}`, "ledger");
        ctx.broadcast({ type: "tt.order", plugin: "trade-teams", team, result: r });
        return reply({ ok: true, ...r });
      }

      if (cmd === "tt-modify") {
        const { team, parts, key } = teamArg(args);
        if (!team || team === "control") return reply({ ok: false, msg: "usage: tt-modify <team> <posId> [stop=X] [target=Y] key=<k>" });
        const auth = badKey(team, key);
        if (auth) return reply(auth);
        if (state.arenaPaused) return reply(pausedReject());
        const posId = parts[1];
        const changes = {};
        for (const p of parts.slice(2)) {
          // strict numeric form — "1.2.3" must not survive to Number() (NaN cheat)
          const m = /^(stop|target)=(\d+(?:\.\d+)?|null)$/i.exec(p);
          if (m) changes[m[1].toLowerCase()] = m[2] === "null" ? null : Number(m[2]);
        }
        await refreshMarks().catch(() => {});
        if (disposed) return reply(disposedReject());
        const fm = freshMarks();
        const pos = state.books[team].positions.find((x) => x.id === posId);
        const r = engine.modifyPosition(state.books[team], posId, changes, pos ? fm[pos.symbol] : NaN);
        save();
        if (r.reject) return reply({ ok: false, blocked: true, msg: r.reject });
        ctx.feed(`🔧 [ทีมเทรด] ${TEAM_TH[team]} ปรับ ${posId} → stop ${r.position.stop} target ${r.position.target ?? "runner"}`, "ledger");
        return reply({ ok: true, position: r.position });
      }

      if (cmd === "tt-close") {
        const { team, parts, key } = teamArg(args);
        if (!team || team === "control") return reply({ ok: false, msg: "usage: tt-close <team> <posId> key=<k>" });
        const auth = badKey(team, key);
        if (auth) return reply(auth);
        if (state.arenaPaused) return reply(pausedReject());
        await refreshMarks().catch(() => {});
        if (disposed) return reply(disposedReject());
        const fm = freshMarks();
        const pos = state.books[team].positions.find((x) => x.id === parts[1]);
        const r = engine.manualClose(state.books[team], parts[1], pos ? fm[pos.symbol] : NaN, Date.now());
        save();
        if (r.reject) return reply({ ok: false, msg: r.reject });
        routeClosedTrade(r.trade);
        return reply({ ok: true, trade: r.trade });
      }

      if (cmd === "tt-cancel") {
        const { team, parts, key } = teamArg(args);
        if (!team || team === "control") return reply({ ok: false, msg: "usage: tt-cancel <team> <orderId> key=<k>" });
        const auth = badKey(team, key);
        if (auth) return reply(auth);
        if (disposed) return reply(disposedReject());
        const r = engine.cancelOrder(state.books[team], parts[1]);
        save();
        return reply(r.reject ? { ok: false, msg: r.reject } : { ok: true, order: r.order });
      }

      if (cmd === "tt-note") {
        const { team, parts, key } = teamArg(args);
        if (!team) return reply({ ok: false, msg: "usage: tt-note <team> <text> key=<k>" });
        const auth = badKey(team, key);
        if (auth) return reply(auth);
        const text = parts.slice(1).join(" ");
        appendJsonl(`journal-${team}.jsonl`, { ts: Date.now(), text });
        return reply({ ok: true });
      }

      if (cmd === "tt-amend") {
        const { team, parts, key } = teamArg(args);
        if (!team || team === "control") return reply({ ok: false, msg: "usage: tt-amend <team> <text> key=<k> (กรรมการสุ่มแก้ธรรมนูญไม่ได้ — ความสุ่มคือธรรมนูญ)" });
        const auth = badKey(team, key);
        if (auth) return reply(auth);
        const text = parts.slice(1).join(" ");
        if (!text) return reply({ ok: false, msg: "ต้องแนบเนื้อหา + เหตุผล" });
        const cur = constitutionOf(team);
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        fs.writeFileSync(path.join(D, `constitution-${team}.md`),
          cur + `\n\n## แก้ไข ${stamp}\n${text}\n`);
        appendJsonl("constitution-history.jsonl", { ts: Date.now(), team, text });
        // An amendment un-pauses a drawdown-paused team, and REBASES the
        // drawdown floor 10% below the acknowledged equity — otherwise the
        // absolute floor re-pauses a flat team 30s later, forever.
        if (state.books[team].paused) {
          state.books[team].paused = false;
          state.books[team].pausedReason = null;
          state.books[team].ddRebase = engine.equityOf(state.books[team], freshMarks());
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
        if (disposed) return reply(disposedReject());
        if (team === "control") {
          // The benchmark runs on ITS schedule only — spamming manual control
          // cycles was a way to fee-churn the yardstick (red-team finding).
          const due = state.nextCycleAt.control || 0;
          if (Date.now() < due)
            return reply({ ok: false, msg: `กรรมการสุ่มเดินตามตารางเท่านั้น (รอบถัดไป ${new Date(due).toISOString()})` });
          let next = (due || Date.now()) + CYCLE_MS;
          while (next <= Date.now()) next += CYCLE_MS;
          state.nextCycleAt.control = next;
          runControlCycle();
          return reply({ ok: true, msg: "control cycle ran (ตามตาราง)" });
        }
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
