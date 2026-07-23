// Phase 2 — real scan engine (Blitz). Config persistence, funding + Fear&Greed
// via public HTTP, news via ctx.runClaude("pulse", ...) (real WebSearch turn).
// Phase 3 (Ledger) — scheduler timer + high-impact broadcast + real panel.

const fs = require("fs");
const path = require("path");
const https = require("https");

const DEFAULT_CONFIG = {
  enabled: false,
  intervalMinutes: null,
  sources: { news: true, funding: true, fearGreed: true },
  highImpactLeadMinutes: 30,
  broadcastEnabled: false,
};

// Market-wide bellwether for funding sentiment — config.schema.json has no
// per-symbol field yet, so this stays a fixed constant until phase 3 needs it.
const FUNDING_SYMBOL = "BTCUSDT";
const NEWS_AGENT = "pulse"; // Sentiment Scout — has WebSearch

function httpsGetJson(hostname, reqPath, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const r = https.request({ method: "GET", hostname, path: reqPath, timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && json != null) resolve({ ok: true, json });
        else resolve({ ok: false, error: `HTTP ${res.statusCode}`, body: data.slice(0, 300) });
      });
    });
    r.on("error", (e) => resolve({ ok: false, error: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ ok: false, error: "request timeout" }); });
    r.end();
  });
}

function extractJson(text) {
  if (!text) return null;
  const s = String(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function minutesUntil(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - Date.now()) / 60000);
}

const NEWS_SCHEMA_HINT = `Reply with ONLY one JSON object, no markdown fences, no prose before/after, exact shape:
{
  "items": [
    { "headline": "...", "summary": "...", "impact": "high"|"medium"|"low", "sentiment": "bullish"|"bearish"|"neutral", "source": "...", "url": "..." }
  ],
  "highImpactEvents": [
    { "name": "CPI"|"FOMC"|"NFP"|"...", "eventTimeUtc": "ISO-8601 datetime", "note": "..." }
  ],
  "overallBias": "bullish"|"bearish"|"neutral"
}`;

module.exports = (ctx) => {
  const configPath = () => path.join(ctx.dataDir, "config.json");
  const statePath = () => path.join(ctx.dataDir, "state.json");

  function mergeConfig(base, patch) {
    const p = patch && typeof patch === "object" ? patch : {};
    const out = { ...base, ...p };
    out.sources = { ...base.sources, ...(p.sources && typeof p.sources === "object" ? p.sources : {}) };
    for (const k of ["news", "funding", "fearGreed"])
      if (typeof out.sources[k] !== "boolean") out.sources[k] = base.sources[k];
    if (typeof out.enabled !== "boolean") out.enabled = base.enabled;
    if (out.intervalMinutes == null) out.intervalMinutes = null;
    else {
      const n = Number(out.intervalMinutes);
      out.intervalMinutes = Number.isFinite(n) && n >= 5 ? Math.floor(n) : base.intervalMinutes;
    }
    if (typeof out.highImpactLeadMinutes !== "number" || out.highImpactLeadMinutes < 1)
      out.highImpactLeadMinutes = base.highImpactLeadMinutes;
    if (typeof out.broadcastEnabled !== "boolean") out.broadcastEnabled = base.broadcastEnabled;
    return out;
  }

  function readConfig() {
    try {
      const raw = fs.readFileSync(configPath(), "utf8");
      return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
    } catch {
      return mergeConfig(DEFAULT_CONFIG, {});
    }
  }

  function writeConfig(cfg) {
    fs.mkdirSync(ctx.dataDir, { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  }

  function readState() {
    try { return JSON.parse(fs.readFileSync(statePath(), "utf8")); }
    catch { return { lastScanAt: null, lastBias: null, nextScanAt: null, lastBroadcastKey: null }; }
  }

  function writeState(state) {
    fs.mkdirSync(ctx.dataDir, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  }

  function computeNextScanAt(cfg, fromIso) {
    if (!cfg.enabled || !cfg.intervalMinutes) return null;
    const base = fromIso ? Date.parse(fromIso) : Date.now();
    return new Date(base + cfg.intervalMinutes * 60000).toISOString();
  }

  // Scheduler — one timer handle, restarted whenever config-set changes
  // enabled/intervalMinutes, and started once on plugin load.
  let scanTimer = null;

  function stopTimer() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  }

  function startTimer() {
    stopTimer();
    const cfg = readConfig();
    if (!cfg.enabled || !cfg.intervalMinutes) {
      const state = readState();
      if (state.nextScanAt) { state.nextScanAt = null; writeState(state); }
      return;
    }
    const state = readState();
    state.nextScanAt = computeNextScanAt(cfg, null);
    writeState(state);
    scanTimer = setInterval(() => {
      runScan().catch((e) => ctx.log("[sentiment-autoscan] scheduled scan failed: " + e.message));
    }, cfg.intervalMinutes * 60000);
  }

  async function fetchFunding() {
    const r = await httpsGetJson("fapi.binance.com", `/fapi/v1/premiumIndex?symbol=${FUNDING_SYMBOL}`);
    if (!r.ok || !r.json) return { error: r.error || "funding fetch failed" };
    const j = r.json;
    const rate = Number(j.lastFundingRate);
    return {
      symbol: FUNDING_SYMBOL,
      markPrice: Number(j.markPrice),
      fundingRate: rate,
      fundingRatePct: rate * 100,
      nextFundingTime: j.nextFundingTime,
      asOf: new Date().toISOString(),
    };
  }

  async function fetchFearGreed() {
    const r = await httpsGetJson("api.alternative.me", "/fng/?limit=1&format=json");
    if (!r.ok || !r.json || !Array.isArray(r.json.data) || !r.json.data[0])
      return { error: r.error || "fear&greed fetch failed" };
    const d = r.json.data[0];
    return {
      value: Number(d.value),
      label: d.value_classification,
      asOf: new Date(Number(d.timestamp) * 1000).toISOString(),
    };
  }

  function fetchNews() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => { if (!settled) { settled = true; resolve(result); } };
      const prompt = `สแกนข่าว crypto ล่าสุดด้วย WebSearch จริง (ให้ความสำคัญกับข่าว high-impact ก่อน: CPI/FOMC/NFP/แฮ็ก/กฎหมาย-กำกับดูแล/ETF flow ฯลฯ) สรุปไม่เกิน 6 ข่าวสำคัญที่สุด พร้อมเหตุการณ์ macro/high-impact ที่กำลังจะมาถึง (ถ้ามี) — ใส่เวลาเหตุการณ์เป็น UTC ISO-8601 ที่แม่นยำที่สุดเท่าที่หาได้ ห้ามเดาเวลาถ้าหาไม่เจอ ให้ข้ามฟิลด์นั้นแทน\n\n${NEWS_SCHEMA_HINT}`;
      try {
        ctx.runClaude(NEWS_AGENT, prompt, {
          logPrompt: "[sentiment-autoscan] scan-now news scan",
          onDone: (text, ok) => {
            if (!ok) return done({ error: "news scan agent run failed" });
            const parsed = extractJson(text);
            if (!parsed) return done({ error: "could not parse news agent reply", raw: String(text || "").slice(0, 500) });
            done({
              items: Array.isArray(parsed.items) ? parsed.items.slice(0, 10) : [],
              highImpactEvents: Array.isArray(parsed.highImpactEvents) ? parsed.highImpactEvents : [],
              overallBias: ["bullish", "bearish", "neutral"].includes(parsed.overallBias) ? parsed.overallBias : "neutral",
              asOf: new Date().toISOString(),
            });
          },
        });
      } catch (e) {
        done({ error: e.message });
      }
      // Belt-and-suspenders: a real multi-WebSearch turn regularly runs 90-120s+;
      // the daemon's own watchdog backstops true hangs, but scan-now must never
      // leave onCommand hanging forever either.
      setTimeout(() => done({ error: "news scan timed out" }), 240000);
    });
  }

  function computeBias(funding, fearGreed, news) {
    let score = 0;
    const reasons = [];
    if (funding && !funding.error) {
      if (funding.fundingRate > 0.0003) { score += 1; reasons.push(`funding +${funding.fundingRatePct.toFixed(4)}% (market leaning long)`); }
      else if (funding.fundingRate < -0.0003) { score -= 1; reasons.push(`funding ${funding.fundingRatePct.toFixed(4)}% (market leaning short)`); }
    }
    if (fearGreed && !fearGreed.error) {
      if (fearGreed.value >= 55) { score += 1; reasons.push(`Fear&Greed ${fearGreed.value} (${fearGreed.label})`); }
      else if (fearGreed.value <= 45) { score -= 1; reasons.push(`Fear&Greed ${fearGreed.value} (${fearGreed.label})`); }
    }
    if (news && !news.error) {
      if (news.overallBias === "bullish") { score += 1; reasons.push("news bias: bullish"); }
      else if (news.overallBias === "bearish") { score -= 1; reasons.push("news bias: bearish"); }
    }
    const overall = score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral";
    return { overall, score, reasons };
  }

  async function runScan() {
    const cfg = readConfig();
    const [funding, fearGreed, news] = await Promise.all([
      cfg.sources.funding ? fetchFunding() : null,
      cfg.sources.fearGreed ? fetchFearGreed() : null,
      cfg.sources.news ? fetchNews() : null,
    ]);

    const highImpactEvents = (news && Array.isArray(news.highImpactEvents) ? news.highImpactEvents : [])
      .map((e) => ({ ...e, minutesToEvent: minutesUntil(e.eventTimeUtc) }))
      .filter((e) => e.minutesToEvent === null || e.minutesToEvent > -60)
      .sort((a, b) => (a.minutesToEvent ?? Infinity) - (b.minutesToEvent ?? Infinity));
    const nearest = highImpactEvents.find((e) => e.minutesToEvent !== null && e.minutesToEvent >= 0) || null;

    const bias = computeBias(funding, fearGreed, news);

    const snapshot = {
      timestamp: new Date().toISOString(),
      sourcesUsed: { ...cfg.sources },
      funding,
      fearGreed,
      news,
      bias,
      highImpact: {
        active: !!(nearest && nearest.minutesToEvent <= cfg.highImpactLeadMinutes),
        leadMinutes: cfg.highImpactLeadMinutes,
        nearest,
        events: highImpactEvents,
      },
    };

    const state = readState();
    state.lastScanAt = snapshot.timestamp;
    state.lastBias = bias.overall;
    state.nextScanAt = computeNextScanAt(cfg, snapshot.timestamp);

    try { ctx.broadcast({ type: "plugin.event", plugin: "sentiment-autoscan", event: "scan", snapshot }, false); } catch {}

    // High-impact broadcast — dedupe on event identity (name+time) so a
    // recurring scan doesn't re-fire the same event every interval.
    if (cfg.broadcastEnabled && snapshot.highImpact.active && nearest) {
      const eventKey = `${nearest.name}|${nearest.eventTimeUtc}`;
      if (state.lastBroadcastKey !== eventKey) {
        state.lastBroadcastKey = eventKey;
        const msg = `⚠️ High-impact event ใกล้ถึง: ${nearest.name} อีก ${nearest.minutesToEvent} นาที — bias ปัจจุบัน: ${bias.overall} (score ${bias.score})`;
        try {
          ctx.broadcast({ type: "plugin.event", plugin: "sentiment-autoscan", event: "high-impact", snapshot, message: msg }, true);
          ctx.feed(msg, NEWS_AGENT);
        } catch {}
      }
    }

    writeState(state);

    return snapshot;
  }

  startTimer(); // resume the scheduler on plugin load/reload per the persisted config

  return {
    onCommand(cmd, args, reply) {
      switch (cmd) {
        case "scan-now":
          runScan().then((snapshot) => reply({ ok: true, snapshot })).catch((e) => reply({ ok: false, msg: e.message }));
          return;

        case "config-get":
          return reply({ ok: true, config: readConfig() });

        case "config-set": {
          let patch;
          try { patch = JSON.parse(args || "{}"); }
          catch (e) { return reply({ ok: false, msg: "invalid JSON: " + e.message }); }
          if (patch == null || typeof patch !== "object" || Array.isArray(patch))
            return reply({ ok: false, msg: "config-set expects a JSON object" });
          const merged = mergeConfig(readConfig(), patch);
          writeConfig(merged);
          startTimer(); // re-evaluate enabled/intervalMinutes and restart/stop the loop
          try { ctx.broadcast({ type: "plugin.event", plugin: "sentiment-autoscan", event: "config", config: merged }, false); } catch {}
          return reply({ ok: true, config: merged });
        }

        case "status": {
          const cfg = readConfig();
          const state = readState();
          const nextScanAt = state.nextScanAt || computeNextScanAt(cfg, state.lastScanAt);
          return reply({
            ok: true,
            enabled: cfg.enabled,
            config: cfg,
            lastScanAt: state.lastScanAt || null,
            lastBias: state.lastBias || null,
            nextScanAt,
          });
        }

        default:
          return reply({ ok: false, msg: "unknown command" });
      }
    },
  };
};
