// JAVIS Trading Desk — read-only unified portal front door.
//
// Capability: READ_ONLY_DESK_PORTAL.
//
// This plugin performs GET requests against loopback read models only. It does
// not import, construct or proxy any execution surface: there is no call to
// /plugin/binance/cmd, no order, close, stoploss, leverage, cancel, autotrade
// or setkeys path, no API key, and no signed request. Spot scanner scores are
// displayed as analysis and are never forwarded to Futures execution.
const fs = require("fs");
const path = require("path");
const http = require("http");

const SCHEMA_VERSION = "javis-trading-desk-home/v1";
const CAPABILITY = "READ_ONLY_DESK_PORTAL";

const DEFAULTS = {
  futuresUrl: "http://127.0.0.1:8787/plugin/binance/snapshot",
  spotUrl: "http://127.0.0.1:8787/plugin/spot-command-center/state",
  journalUrl: "http://127.0.0.1:8787/plugin/performance-journal/state",
  timeoutMs: 4000,
  maxBytes: 1024 * 1024,
  pollMs: 15000,
};

// Subsystem states. FIXTURE data must never be relabelled HEALTHY, and a
// subsystem that is simply absent is reported as absent rather than degraded.
const STATE_HEALTHY = "HEALTHY";
const STATE_DEGRADED = "DEGRADED";
const STATE_STALE = "STALE";
const STATE_UNAVAILABLE = "UNAVAILABLE";
const STATE_NOT_INSTALLED = "NOT_INSTALLED";
const STATE_NOT_CONNECTED = "NOT_CONNECTED";

// Anything shaped like a credential or an execution instruction is refused
// before it can reach the portal payload, whatever child produced it.
const FORBIDDEN_KEY_TOKENS = [
  "apikey", "apisecret", "secretkey", "privatekey", "signature", "signedrequest",
  "executionintent", "orderpayload", "withdraw", "transfer", "mnemonic", "seed",
  "passphrase", "credential", "authorization", "accesstoken", "refreshtoken",
  "bearertoken", "xmbxapikey",
];

function normalizeKey(key) {
  return String(key).normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function scrub(value, depth = 0) {
  if (depth > 12) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => scrub(item, depth + 1));
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (FORBIDDEN_KEY_TOKENS.some((token) => normalized.includes(token))) continue;
    output[key] = scrub(child, depth + 1);
  }
  return output;
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = num(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Bounded loopback GET. Never throws to the caller: every failure becomes a
 * controlled reason code, and no raw exception text or URL leaves this function.
 */
function getJsonLoopback(rawUrl, { timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) { settled = true; resolve(result); }
    };
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return finish({ ok: false, reasonCode: "SOURCE_URL_INVALID" });
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return finish({ ok: false, reasonCode: "SOURCE_NOT_LOOPBACK" });
    }
    const request = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET", headers: { Accept: "application/json" } },
      (res) => {
        if (res.statusCode === 404) { res.resume(); return finish({ ok: false, reasonCode: "SOURCE_NOT_INSTALLED", status: 404 }); }
        if (res.statusCode !== 200) { res.resume(); return finish({ ok: false, reasonCode: "SOURCE_STATUS_NOT_OK", status: res.statusCode }); }
        let size = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) { request.destroy(); return finish({ ok: false, reasonCode: "SOURCE_TOO_LARGE" }); }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch {
            finish({ ok: false, reasonCode: "SOURCE_MALFORMED_JSON" });
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => { request.destroy(); finish({ ok: false, reasonCode: "SOURCE_TIMEOUT" }); });
    request.on("error", () => finish({ ok: false, reasonCode: "SOURCE_UNREACHABLE" }));
    request.end();
  });
}

function summarizeFutures(result) {
  if (!result.ok) {
    return {
      available: false,
      state: result.reasonCode === "SOURCE_NOT_INSTALLED" ? STATE_NOT_INSTALLED : STATE_UNAVAILABLE,
      reason_code: result.reasonCode,
    };
  }
  const body = scrub(result.body) || {};
  const snap = body.snapshot || body.data || body;
  const env = String(snap.environment || snap.env || snap.mode || "UNKNOWN").toUpperCase();
  const positions = Array.isArray(snap.positions) ? snap.positions : [];
  return {
    available: true,
    state: STATE_HEALTHY,
    environment: env === "MAINNET" || env === "TESTNET" ? env : "UNKNOWN",
    paused: snap.paused === true,
    trade_enabled: snap.tradeEnabled === true || snap.trade_enabled === true,
    auto_trade: snap.autoTrade === true || snap.auto_trade === true,
    equity: firstNumber(snap.equity, snap.totalEquity, snap.walletBalance),
    available_balance: firstNumber(snap.availableBalance, snap.available_balance, snap.free),
    unrealized_pnl: firstNumber(snap.unrealizedPnl, snap.unrealized_pnl, snap.unrealizedProfit),
    position_count: positions.length,
    positions: positions.slice(0, 20).map((row) => ({
      symbol: String(row.symbol || "").slice(0, 20),
      side: String(row.side || "").slice(0, 8),
      qty: num(row.qty ?? row.positionAmt),
      entry: num(row.entryPrice ?? row.entry),
      unrealized_pnl: num(row.unrealizedPnl ?? row.unRealizedProfit),
    })),
    health: scrub(snap.health) || {},
  };
}

function summarizeSpot(result) {
  if (!result.ok) {
    // The Spot bridge is a separate, still-gated deliverable. Its absence is
    // reported truthfully; it is never filled in with fixture numbers.
    const notInstalled = result.reasonCode === "SOURCE_NOT_INSTALLED" || result.reasonCode === "SOURCE_UNREACHABLE";
    return {
      available: false,
      state: notInstalled ? STATE_NOT_INSTALLED : STATE_UNAVAILABLE,
      audit_status: "P1_HARDENING_REQUIRED",
      reason_code: result.reasonCode,
      assets: [],
    };
  }
  const body = scrub(result.body) || {};
  const auditStatus = String(body.audit_status || body.auditStatus || "PENDING_P1_HARDENING").toUpperCase();
  return {
    available: true,
    // Only an explicitly verified snapshot may claim VERIFIED_LOCAL here.
    audit_status: auditStatus === "VERIFIED_LOCAL" ? "VERIFIED_LOCAL" : "P1_HARDENING_REQUIRED",
    state: String(body.state || STATE_UNAVAILABLE).toUpperCase(),
    stale: body.stale === true,
    total_value_thb: firstNumber(body.totalValueThb, body.total_value_thb),
    cash_thb: firstNumber(body.cashThb, body.cash_thb),
    cash_weight_pct: firstNumber(body.cashWeightPct, body.cash_weight_pct),
    cash_floor_pct: firstNumber(body.cashFloorPct, body.cash_floor_pct),
    buy_total_thb: firstNumber(body.buyTotalThb, body.buy_total_thb),
    trim_total_thb: firstNumber(body.trimTotalThb, body.trim_total_thb),
    assets: (Array.isArray(body.assets) ? body.assets : []).slice(0, 10),
  };
}

function summarizeJournal(result) {
  if (!result.ok) {
    return {
      available: false,
      // No adapter yet: the section shows an explicit not-connected state and
      // never a fabricated P&L figure.
      state: STATE_NOT_CONNECTED,
      reason_code: result.reasonCode,
    };
  }
  const body = scrub(result.body) || {};
  return {
    available: true,
    state: String(body.state || STATE_HEALTHY).toUpperCase(),
    net_pnl_after_costs: firstNumber(body.netPnlAfterCosts, body.net_pnl_after_costs),
    winning_days: firstNumber(body.winningDays, body.winning_days),
    max_drawdown: firstNumber(body.maxDrawdown, body.max_drawdown),
    fees: firstNumber(body.fees),
    funding: firstNumber(body.funding),
  };
}

function overallState({ futures, spot, journal }) {
  const blockers = [];
  const warnings = [];
  if (!futures.available) blockers.push(`FUTURES_${futures.state}`);
  if (!spot.available) warnings.push(`SPOT_${spot.state}`);
  if (spot.available && spot.audit_status !== "VERIFIED_LOCAL") warnings.push("SPOT_P1_HARDENING_REQUIRED");
  if (spot.available && spot.stale) warnings.push("SPOT_STALE");
  if (!journal.available) warnings.push(`PERFORMANCE_JOURNAL_${journal.state}`);

  // Partial data can never present as HEALTHY.
  let state = STATE_HEALTHY;
  if (blockers.length) state = STATE_UNAVAILABLE;
  else if (spot.available && spot.stale) state = STATE_STALE;
  else if (warnings.length) state = STATE_DEGRADED;
  return { state, blockers, warnings };
}

async function buildUnifiedReadModel(config, nowIso = new Date().toISOString()) {
  const options = { timeoutMs: config.timeoutMs, maxBytes: config.maxBytes };
  // Each subsystem is fetched independently: one failure cannot take down another.
  const [futuresResult, spotResult, journalResult] = await Promise.all([
    getJsonLoopback(config.futuresUrl, options),
    getJsonLoopback(config.spotUrl, options),
    getJsonLoopback(config.journalUrl, options),
  ]);
  const futures = summarizeFutures(futuresResult);
  const spot = summarizeSpot(spotResult);
  const performance_journal = summarizeJournal(journalResult);
  const { state, blockers, warnings } = overallState({ futures, spot, journal: performance_journal });
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: nowIso,
    capability: CAPABILITY,
    state,
    futures,
    spot,
    performance_journal,
    warnings,
    blockers,
    disclaimer: "Read-only desk portal. No order, execution intent or account mutation exists here.",
  };
}

function safeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(payload);
}

function createPlugin(ctx) {
  const config = { ...DEFAULTS, ...(ctx && ctx.config ? ctx.config : {}) };
  let cached = null;
  let inFlight = null;

  // One refresh at a time: overlapping cycles are collapsed onto the in-flight
  // promise so a slow subsystem cannot stack pollers.
  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = buildUnifiedReadModel(config)
      .then((model) => { cached = model; return model; })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  const routes = {
    async state(req, res) {
      if (req.method !== "GET") return safeJson(res, 405, { ok: false, reasonCode: "METHOD_NOT_ALLOWED" });
      return safeJson(res, 200, await refresh());
    },
    async health(req, res) {
      if (req.method !== "GET") return safeJson(res, 405, { ok: false, reasonCode: "METHOD_NOT_ALLOWED" });
      const model = await refresh();
      return safeJson(res, 200, {
        ok: true,
        capability: CAPABILITY,
        state: model.state,
        generated_at: model.generated_at,
        futures_state: model.futures.state,
        spot_state: model.spot.state,
        journal_state: model.performance_journal.state,
      });
    },
    panel(req, res) {
      if (req.method !== "GET") return safeJson(res, 405, { ok: false, reasonCode: "METHOD_NOT_ALLOWED" });
      let html;
      try {
        html = fs.readFileSync(path.join(__dirname, "panel.html"), "utf8");
      } catch {
        return safeJson(res, 500, { ok: false, reasonCode: "PANEL_UNAVAILABLE" });
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(html);
    },
  };

  return {
    async onCommand(cmd, args) {
      const command = String(cmd || "").trim().toLowerCase();
      if (command === "health") {
        const model = await refresh();
        return { ok: true, capability: CAPABILITY, state: model.state, futures: model.futures.state, spot: model.spot.state, journal: model.performance_journal.state };
      }
      if (command === "summary") return { ok: true, ...(await refresh()) };
      return { ok: false, msg: "unknown command (health | summary)" };
    },
    routes,
    dispose() { cached = null; inFlight = null; },
  };
}

module.exports = createPlugin;
module.exports._test = {
  SCHEMA_VERSION,
  CAPABILITY,
  DEFAULTS,
  scrub,
  summarizeFutures,
  summarizeSpot,
  summarizeJournal,
  overallState,
  buildUnifiedReadModel,
};
