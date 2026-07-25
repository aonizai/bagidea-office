"use strict";
/**
 * smc-radar — SMC / FVG advisory reader.
 *
 * Thin adapter over engine.js: parse args, pull candles through the binance
 * plugin over loopback, hand them to the pure engine, render Thai text.
 *
 * ADVISORY ONLY. This file never calls a binance WRITE command (order,
 * autotrade, close, stoploss, leverage, cancel) and is not referenced by the
 * trading guard chain. It also never calls ctx.relay — Telegram on this desk is
 * reserved for money events (see plugins/binance/index.js:1738, where scan
 * signals deliberately skip it because advisory spam buried real alerts).
 */

const http = require("http");

// The host busts require.cache for index.js only (daemon/plugins.js:91), so a
// split-out engine would stay STALE across every /plugins/reload — edits to the
// math would silently not take effect. Drop it ourselves first; this file is
// only ever re-required by that same reload path.
try { delete require.cache[require.resolve("./engine")]; } catch { /* first load */ }
const engine = require("./engine");

const PORT = Number(process.env.BAGIDEA_PORT) || 8787;
const VERSION = "0.1.0";

// Entry TF -> context TF. `smc BTC 1h` promotes 1h to entry and 4h to context.
const HTF_MAP = {
  "1m": "15m", "3m": "15m", "5m": "1h", "15m": "1h",
  "30m": "4h", "1h": "4h", "2h": "1d", "4h": "1d", "6h": "1d", "12h": "1d",
  "1d": "1w", "1w": "1w",
};
const TF_OK = new Set(Object.keys(HTF_MAP));

/**
 * Loopback to the sibling binance plugin — the single place that holds keys and
 * talks to the exchange. MUST be http.request, not https: the loopback is
 * plaintext and https throws ERR_INVALID_PROTOCOL synchronously, which a silent
 * catch once turned a whole gate into a no-op.
 */
function callBinance(cmd, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ cmd, args });
    const req = http.request(
      {
        host: "127.0.0.1", port: PORT, path: "/plugin/binance/cmd", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let d = "";
        res.on("data", (chunk) => (d += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(d)); } catch { resolve(null); }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

const getKlines = async (symbol, tf, limit) => {
  const r = await callBinance("klines", `${symbol} ${tf} ${limit}`);
  return r && r.ok && Array.isArray(r.candles) ? r.candles : null;
};

/* ------------------------------------------------------------- rendering */

const STATE_TH = {
  fresh: "สด", tapped: "แตะแล้ว", ce: "เติมครึ่ง", filled: "เต็มแล้ว", invalidated: "ยกเลิก",
};
const SCENARIO_TH = {
  "uptrend-bos": "เทรนด์ขึ้น หลัง BOS",
  "downtrend-bos": "เทรนด์ลง หลัง BOS",
  "post-mss": "หลัง MSS (เปลี่ยนโครงสร้าง)",
  "fvg-sweep": "FVG + กวาด liquidity",
  "range-edge": "FVG ในกรอบ sideway",
};
const READY_TH = {
  waiting: "🟡 รอราคา — ยังไม่ใช่จุดเข้า",
  armed: "🟠 ราคาอยู่ในโซนแล้ว — รอแท่งยืนยัน",
  triggered: "🟢 มีแท่งปฏิกิริยาปิดแล้ว — ยังต้องเช็คความเสี่ยงเอง",
};
const FOOTER = "📌 FVG คือโซนรอราคา ไม่ใช่สัญญาณเข้าเทรด — ที่ปรึกษาเท่านั้น ไม่ส่งคำสั่งเอง";

function renderText(sym, x) {
  const s = x.structure;
  const lastEv = x.lastMss && (!x.lastBos || x.lastMss.j > x.lastBos.j)
    ? `MSS ${x.lastMss.dir === "up" ? "ขึ้น" : "ลง"} ${x.asOf.closedBars - 1 - x.lastMss.j} แท่งก่อน`
    : x.lastBos
      ? `BOS ${x.lastBos.dir === "up" ? "ขึ้น" : "ลง"} ${x.asOf.closedBars - 1 - x.lastBos.j} แท่งก่อน`
      : "ยังไม่มี BOS/MSS";
  const htfMark = x.htf.trend === "unknown" ? "—" : x.htf.trend === "range" ? "↔" : x.htf.trend === "up" ? "↑" : "↓";

  const counts = { fresh: 0, tapped: 0, ce: 0, filled: 0, invalidated: 0 };
  for (const z of x.zones) counts[z.state]++;

  const lines = [
    `🔲  ${sym} ${x.tf} — SMC/FVG · โครงสร้าง ${s.bias} (${lastEv}) · ${x.htfTf} ${x.htf.trend} ${htfMark}`,
    `price ${x.price} · ATR ${x.atr} (${x.atrPct}%) · ADX ${s.adx ?? "n/a"} · โซนราคา: ${x.pd.zone ?? "n/a"}${x.pd.rangePos != null ? ` ${Math.round(x.pd.rangePos * 100)}%` : ""}`,
    `FVG ${x.zones.length} โซน — สด ${counts.fresh} · แตะแล้ว ${counts.tapped} · เติมครึ่ง ${counts.ce} · เต็มแล้ว ${counts.filled} · ยกเลิก ${counts.invalidated}`,
  ];

  if (!x.setups.length) {
    lines.push("", "ไม่มีโซนที่ใช้ได้ตอนนี้ — รอ");
    if (x.watchlist.length) {
      const top = x.watchlist.slice(0, 3).map((w) => `${w.dir === "bull" ? "▲" : "▼"} ${w.bottom}–${w.top} (${w.reject})`);
      lines.push(`เฝ้าดู: ${top.join(" · ")}`);
    }
  }

  for (const st of x.setups) {
    const arrow = st.dir === "long" ? "LONG" : "SHORT";
    lines.push(
      "",
      `⭐ ${st.grade}  ${arrow} · ${SCENARIO_TH[st.scenario] || st.scenario} · FVG ${st.zone.bottom}–${st.zone.top} (CE ${st.zone.ce} · ${st.zone.sizeAtr}×ATR · ${STATE_TH[st.zone.state]})`,
      `   สถานะ: ${READY_TH[st.readiness]}`,
      `   แผน: entry ${st.entry} · SL ${st.sl} · TP1 ${st.tp1} (${st.tpSource})${st.tp2 != null ? ` · TP2 ${st.tp2}` : ""} · R:R ${st.rr}`,
      `   เหตุผล: ${st.reasons.map((r) => `${r.label}(${r.weight > 0 ? "+" : ""}${r.weight})`).join(" · ")}`,
    );
    if (st.missing.length) lines.push(`   ขาด: ${st.missing.join(" · ")}`);
    if (st.gradeCaps && st.gradeCaps.length)
      lines.push(`   เกรดถูกจำกัดเพราะ: ${st.gradeCaps.join(" · ")}`);
    lines.push(`   ยกเลิกเมื่อ: ${st.invalidation}`);
  }

  if (x.unknowns.length) lines.push("", `⚠ ${x.unknowns.join(" · ")}`);
  if (x.warnings.length) lines.push(`⚠ ${x.warnings.join(" · ")}`);
  lines.push(FOOTER);
  return lines.join("\n");
}

function renderZones(sym, x) {
  const lines = [`🔲  ${sym} ${x.tf} — FVG ${x.zones.length} โซน (price ${x.price} · ATR ${x.atr})`];
  if (!x.zones.length) lines.push("ไม่มีช่องว่างที่ผ่านเกณฑ์ตอนนี้");
  for (const z of x.zones) {
    lines.push(
      `${z.dir === "bull" ? "▲ bull" : "▼ bear"} ${z.bottom}–${z.top} (CE ${z.ce} · ${z.sizeAtr}×ATR) · ` +
      `${STATE_TH[z.state]} ${Math.round((z.maxPenetration || 0) * 100)}%` +
      `${z.invalidReason ? ` (${z.invalidReason})` : ""} · เกรดตอนเกิด ${z.formGrade} · อายุ ${z.barsSinceForm} แท่ง` +
      `${z.quality ? "" : " · ไม่ผ่านเกณฑ์คุณภาพ"}`,
    );
  }
  lines.push(FOOTER);
  return lines.join("\n");
}

function renderLevels(sym, x) {
  const L = x.liquidity;
  const lines = [
    `🔲  ${sym} ${x.tf} — Liquidity & Range (price ${x.price})`,
    `กรอบ: ${x.pd.rangeLow}–${x.pd.rangeHigh} (eq ${x.pd.equilibrium}) · ตอนนี้ ${x.pd.zone ?? "n/a"}${x.pd.stale ? " · กรอบเก่า" : ""}${x.pd.valid ? "" : ` · ใช้ไม่ได้ (${x.pd.reason})`}`,
    `เหนือ: ${L.nearestAbove ? `${L.nearestAbove.level} (${L.nearestAbove.strength}, ${L.nearestAbove.distAtr}×ATR)` : "—"} · ` +
      `ใต้: ${L.nearestBelow ? `${L.nearestBelow.level} (${L.nearestBelow.strength}, ${L.nearestBelow.distAtr}×ATR)` : "—"}`,
  ];
  const eq = L.pools.filter((p) => p.count >= 2);
  if (eq.length) lines.push(`กระจุกราคาเท่ากัน: ${eq.map((p) => `${p.side} ${p.level}×${p.count}${p.swept ? " (กวาดแล้ว)" : ""}`).join(" · ")}`);
  const live = L.sweeps.filter((s) => s.live);
  if (live.length) {
    lines.push(
      `กวาดล่าสุด: ${live.map((s) => `${s.type} @${s.level} แท่ง ${s.j}${s.pending ? " (ยังไม่ยืนยัน)" : s.confirmed ? " ✓" : " ✗"}`).join(" · ")}`,
    );
  }
  if (x.range && x.range.support) {
    lines.push(
      `แนวรับ ${x.range.support.lo}–${x.range.support.hi} (แตะ ${x.range.support.touches}${x.range.support.provisional ? " · ยังไม่ยืนยัน" : ""}) · ` +
      `แนวต้าน ${x.range.resistance.lo}–${x.range.resistance.hi} (แตะ ${x.range.resistance.touches}${x.range.resistance.provisional ? " · ยังไม่ยืนยัน" : ""})`,
    );
  }
  lines.push(FOOTER);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ plugin */

async function readSymbol(parts, cfgTf) {
  const symbol = (parts[0] || "").toUpperCase();
  if (!symbol) return { err: "usage: <cmd> <SYMBOL> [tf]  เช่น smc ETHUSDT 15m" };
  const tf = (parts[1] || cfgTf).toLowerCase();
  if (!TF_OK.has(tf)) return { err: `tf ไม่รองรับ: ${tf} (ใช้ได้: ${[...TF_OK].join(", ")})` };
  const htfTf = HTF_MAP[tf];

  const [candles, htfCandles] = await Promise.all([
    getKlines(symbol, tf, engine.CFG.entryLimit),
    getKlines(symbol, htfTf, engine.CFG.htfLimit),
  ]);
  if (!candles) return { err: `ดึงแท่งเทียนไม่ได้: ${symbol} (${tf}) — plugin binance ขึ้นอยู่ไหม / symbol ถูกไหม` };

  // Date.now() lives here and ONLY here. The engine takes nowMs as an argument
  // so the same candles always produce the same answer.
  const out = engine.analyze(candles, htfCandles || [], { tf, htfTf, nowMs: Date.now() });
  if (!out.ok) return { err: out.msg };
  return { symbol, tf, out };
}

module.exports = (ctx) => ({
  async onCommand(cmd, args, reply) {
    const parts = String(args || "").trim().split(/\s+/).filter(Boolean);

    if (cmd === "health") {
      const ping = await callBinance("price", "BTCUSDT");
      return reply({
        ok: true, engine: `smc-radar v${VERSION}`, advisoryOnly: true,
        binanceBridge: ping && ping.ok ? "reachable" : "unreachable", port: PORT,
      });
    }

    if (cmd === "smc" || cmd === "fvg" || cmd === "levels") {
      const r = await readSymbol(parts, engine.CFG.entryTf);
      if (r.err) return reply({ ok: false, msg: r.err });
      const { symbol, out } = r;

      if (ctx && ctx.log) {
        const a = out.setups.filter((s) => s.grade === "A").length;
        ctx.log(
          `[smc-radar] ${symbol} ${out.tf} => ${out.zones.length} zones (${a}×A) ` +
          `struct=${out.structure.bias} setups=${out.setups.length}`,
        );
      }
      if (ctx && ctx.broadcast) {
        try {
          ctx.broadcast(
            {
              type: "plugin.event", plugin: "smc-radar", event: cmd,
              symbol, tf: out.tf, zones: out.zones.length, setups: out.setups.length,
              bias: out.structure.bias,
            },
            false, // non-persisted: live on the overlay, no feed-history pollution
          );
        } catch { /* a broadcast failure must never fail the read */ }
      }

      if (cmd === "fvg") {
        return reply({
          ok: true, symbol, tf: out.tf, engine: out.engine, advisoryOnly: true,
          asOf: out.asOf, price: out.price, atr: out.atr,
          zones: out.zones, text: renderZones(symbol, out),
        });
      }
      if (cmd === "levels") {
        return reply({
          ok: true, symbol, tf: out.tf, engine: out.engine, advisoryOnly: true,
          asOf: out.asOf, price: out.price, atr: out.atr,
          structure: out.structure, pd: out.pd, liquidity: out.liquidity,
          range: out.range, regime: out.regime, text: renderLevels(symbol, out),
        });
      }
      return reply({ ok: true, symbol, ...out, text: renderText(symbol, out) });
    }

    return reply({ ok: false, msg: `unknown command: ${cmd}` });
  },
});

// Exposed for offline tests (require the module directly).
module.exports.renderText = renderText;
module.exports.renderZones = renderZones;
module.exports.renderLevels = renderLevels;
module.exports.HTF_MAP = HTF_MAP;
