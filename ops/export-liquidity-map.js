#!/usr/bin/env node
"use strict";
/* export-liquidity-map.js — read-only export of the smc-radar pool map for
 * JAVIS display (mandate: liquidity_hazard_2026_07_28, surface 4).
 * Data flows OUT of the desk only; nothing here can reach an order path.
 *
 * Candles come from the desk daemon's own klines command (same transport the
 * scanner trades against — testnet), falling back to the public testnet REST
 * endpoint when the daemon is down. Output: liquidity-map/v1, written
 * atomically to the dashboard-data dir and the JAVIS observation state dir.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");

const PORT = process.env.BAGIDEA_PORT || 8787;
const FALLBACK_SYMBOLS = ["XRPUSDT", "BTCUSDT", "SOLUSDT", "BNBUSDT", "ETHUSDT"];
const OUTPUTS = [
  path.join(os.homedir(), "bagidea-dashboard-data", "liquidity-map.json"),
  path.join(os.homedir(), "javis-signal-observation", "liquidity-map.json"),
];

// Engine self-bust mirrors plugins/smc-radar/index.js — both consumers reload
// the same math after an engine edit.
const engPath = require.resolve(path.join(__dirname, "..", "plugins", "smc-radar", "engine.js"));
try { delete require.cache[engPath]; } catch {}
const engine = require(engPath);

function daemonCmd(cmd, args) {
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
    r.setTimeout(10000, () => { r.destroy(); resolve(null); });
    r.write(body);
    r.end();
  });
}

function publicKlines(symbol, interval, limit) {
  return new Promise((resolve) => {
    https.get(`https://demo-fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { timeout: 15000 }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            const rows = JSON.parse(d);
            resolve(Array.isArray(rows) ? rows.map((k) => ({
              t: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
              close: Number(k[4]), volume: Number(k[5]), closeT: Number(k[6]),
            })) : null);
          } catch { resolve(null); }
        });
      }).on("error", () => resolve(null));
  });
}

async function getCandles(symbol, tf, limit) {
  const r = await daemonCmd("klines", `${symbol} ${tf} ${limit}`);
  if (r && r.ok && Array.isArray(r.candles) && r.candles.length) return r.candles;
  return publicKlines(symbol, tf, limit);
}

const fmtPool = (p) => ({
  side: p.side, level: p.level, bandLo: p.bandLo ?? null, bandHi: p.bandHi ?? null,
  count: p.count ?? null, strength: p.strength, swept: !!p.swept, distAtr: p.distAtr ?? null,
});

// nearestAbove/Below drop band/count in the engine report; refill from the
// closest same-side pool row within 1 ATR when one exists.
function refill(nearest, pools, atr) {
  if (!nearest) return null;
  const m = pools.find((p) => p.side === nearest.side && Math.abs(p.level - nearest.level) <= atr);
  return fmtPool({ ...nearest, ...(m || {}) });
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o644); } catch {}
}

(async () => {
  const st = await daemonCmd("status");
  const symbols = (st && st.ok && Array.isArray(st.allowedSymbols) && st.allowedSymbols.length)
    ? st.allowedSymbols : FALLBACK_SYMBOLS;

  const out = { schema: "liquidity-map/v1", generated_at_ms: Date.now(),
    source: "bagidea-desk smc-radar", symbols: {} };
  const failed = [];
  for (const symbol of symbols) {
    try {
      const [c15, c1h] = await Promise.all([
        getCandles(symbol, "15m", 300),
        getCandles(symbol, "1h", 200),
      ]);
      if (!c15) throw new Error("no candles");
      const x = engine.analyze(c15, c1h || [], { tf: "15m", htfTf: "1h", nowMs: Date.now() });
      if (!x.ok) throw new Error(x.msg || "analyze failed");
      const pools = (x.liquidity.pools || []).filter((p) => p.strength !== "weak");
      out.symbols[symbol] = {
        price: x.price, atr: x.atr, tf: "15m",
        pools: pools.map(fmtPool),
        nearest_above: refill(x.liquidity.nearestAbove, pools, x.atr),
        nearest_below: refill(x.liquidity.nearestBelow, pools, x.atr),
      };
    } catch (e) {
      failed.push(symbol + ": " + e.message);
    }
  }

  const okCount = Object.keys(out.symbols).length;
  if (!okCount) {
    console.error("export-liquidity-map: every symbol failed — " + failed.join(" · "));
    process.exit(1);
  }
  const text = JSON.stringify(out);
  for (const f of OUTPUTS) writeAtomic(f, text);
  console.log(`export-liquidity-map: ${okCount}/${symbols.length} symbols → ${OUTPUTS.join(" , ")}` +
    (failed.length ? ` · skipped: ${failed.join(" · ")}` : ""));
})();
