// JAVIS Spot Command Center — read-only BagIdea Office bridge.
//
// This plugin deliberately does NOT import or call the Binance execution command
// surface. It reads a versioned Spot analysis snapshot, exposes safe summaries to
// agents/panels, and may read GET /plugin/binance/snapshot for combined context.
// No API key, signed request, account mutation, order or execution intent exists.
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const ACCEPTED_SCHEMAS = [
  "javis-spot-command-center/v1",
  "spot-command-center/v1",
  "spot-accumulation/v1",
];

const FORBIDDEN_KEYS = new Set([
  "apikey", "apisecret", "privatekey", "private_key", "signature",
  "signedrequest", "signed_request", "executionintent", "execution_intent",
  "orderpayload", "order_payload", "withdraw", "withdrawal", "transfer",
  "mnemonic", "seedphrase", "seed_phrase",
]);

const DEFAULTS = {
  maxAgeSec: 1800,
  maxSnapshotBytes: 2 * 1024 * 1024,
  pollMs: 15000,
  appUrl: "http://127.0.0.1:4173",
  deskUrl: "http://127.0.0.1:8787/plugin/binance/snapshot",
  snapshotPaths: [
    path.join(os.homedir(), "javis-spot-command-center-data", "latest-snapshot.json"),
    "E:\\JARVIS-BrainOps\\projects\\javis-spot-command-center\\data\\latest-snapshot.json",
    "E:\\JARVIS-BrainOps\\projects\\javis-crypto-copilot\\reports\\spot-accumulation-latest.json",
  ],
};

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = asNumber(value);
    if (n !== null) return n;
  }
  return null;
}

function firstArray(...values) {
  return values.find(Array.isArray) || [];
}

function snapshotSchema(snapshot) {
  return String(snapshot?.schemaVersion || snapshot?.schema_version || snapshot?.schema || snapshot?.version || "");
}

function generatedAt(snapshot) {
  return String(snapshot?.generatedAt || snapshot?.generated_at || snapshot?.timestamp || "");
}

function ageSec(iso, nowMs = Date.now()) {
  const parsed = Date.parse(String(iso || ""));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

function walkForForbiddenKeys(value, seen = new Set()) {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = walkForForbiddenKeys(item, seen);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[-\s]/g, "").toLowerCase();
    if (FORBIDDEN_KEYS.has(normalized)) return key;
    const found = walkForForbiddenKeys(child, seen);
    if (found) return found;
  }
  return null;
}

function validateSnapshot(snapshot, opts = {}) {
  const maxAgeSec = Number(opts.maxAgeSec ?? DEFAULTS.maxAgeSec);
  const nowMs = Number(opts.nowMs ?? Date.now());
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { ok: false, reasonCode: "SNAPSHOT_NOT_OBJECT", safeMessage: "Spot snapshot is not a JSON object." };
  }
  const schema = snapshotSchema(snapshot);
  if (!ACCEPTED_SCHEMAS.includes(schema)) {
    return { ok: false, reasonCode: "SCHEMA_UNSUPPORTED", safeMessage: "Spot snapshot schema is unsupported.", schema };
  }
  const mode = String(snapshot.mode || snapshot.capability || snapshot.capability_status || "READ_ONLY_ANALYSIS").toUpperCase();
  if (!mode.includes("READ_ONLY") || /LIVE|EXECUTION|DISPATCH|TRADING_ENABLED/.test(mode)) {
    return { ok: false, reasonCode: "CAPABILITY_NOT_READ_ONLY", safeMessage: "Spot snapshot is outside the read-only capability boundary." };
  }
  const forbidden = walkForForbiddenKeys(snapshot);
  if (forbidden) {
    return { ok: false, reasonCode: "FORBIDDEN_CAPABILITY_FIELD", safeMessage: "Spot snapshot contains a forbidden secret or execution field." };
  }
  const generated = generatedAt(snapshot);
  const age = ageSec(generated, nowMs);
  if (age === null) {
    return { ok: false, reasonCode: "GENERATED_AT_INVALID", safeMessage: "Spot snapshot timestamp is missing or invalid." };
  }
  const state = String(snapshot.state || snapshot.status || "UNKNOWN").toUpperCase();
  const stale = age > maxAgeSec || state === "STALE" || state === "BLOCKED_DATA";
  return { ok: true, schema, mode, generatedAt: generated, ageSec: age, stale, state };
}

function normalizeAsset(asset, buyMap = {}) {
  const symbol = String(asset?.asset || asset?.symbol || "").toUpperCase();
  const entry = asset?.entryPlan || asset?.entry_plan || asset?.entry || null;
  return {
    asset: symbol,
    status: String(asset?.status || asset?.decision || asset?.scanner_status || "UNKNOWN"),
    allocationState: String(asset?.allocationState || asset?.allocation_state || "UNKNOWN"),
    score: firstNumber(asset?.score, asset?.technicalScore, asset?.technical_score),
    currentWeightPct: firstNumber(asset?.currentWeightPct, asset?.current_weight_pct, asset?.weightPct, asset?.weight_pct),
    targetWeightPct: firstNumber(asset?.targetWeightPct, asset?.target_weight_pct, asset?.targetPct, asset?.target_pct),
    targetGapThb: firstNumber(asset?.targetGapThb, asset?.target_gap_thb, asset?.gapThb, asset?.gap_thb),
    marketValueThb: firstNumber(asset?.marketValueThb, asset?.market_value_thb),
    recommendedBuyThb: firstNumber(asset?.recommendedBuyThb, asset?.recommended_buy_thb, buyMap[symbol]?.amountThb, buyMap[symbol]?.amount_thb, 0),
    blockers: firstArray(asset?.blockers, asset?.reasonCodes, asset?.reason_codes),
    reasons: firstArray(asset?.reasons, asset?.signals),
    entryPlan: entry,
  };
}

function summarizeSnapshot(snapshot, validation = validateSnapshot(snapshot)) {
  if (!validation.ok) return { available: false, validation };
  const valuation = snapshot.valuation || {};
  const portfolio = snapshot.portfolio || {};
  const plan = snapshot.plan || snapshot.rebalance || {};
  const buyBasket = firstArray(plan.buyBasket, plan.buy_basket);
  const trimBasket = firstArray(plan.trimBasket, plan.trim_basket, plan.sellBasket, plan.sell_basket);
  const buyMap = Object.fromEntries(buyBasket.map((item) => [String(item.asset || item.symbol || "").toUpperCase(), item]));
  const rawAssets = firstArray(snapshot.scans, valuation.assets, snapshot.assets, snapshot.results);
  const assets = rawAssets.map((asset) => normalizeAsset(asset, buyMap)).filter((asset) => asset.asset);
  const totalValueThb = firstNumber(
    valuation.totalPortfolioValueThb, valuation.total_portfolio_value_thb,
    valuation.totalValueThb, valuation.total_value_thb,
    portfolio.totalPortfolioValueThb, portfolio.total_portfolio_value_thb,
    portfolio.totalValueThb, portfolio.total_value_thb
  );
  const cashThb = firstNumber(valuation.cashThb, valuation.cash_thb, portfolio.cashThb, portfolio.cash_thb);
  const cashWeightPct = firstNumber(valuation.cashWeightPct, valuation.cash_weight_pct, portfolio.cashWeightPct, portfolio.cash_weight_pct);
  const cashFloorPct = firstNumber(portfolio.cashFloorPct, portfolio.cash_floor_pct, snapshot.cashFloorPct, snapshot.cash_floor_pct);
  const fx = valuation.fx || portfolio.fx || snapshot.fx || {};
  return {
    available: true,
    schema: validation.schema,
    mode: validation.mode,
    state: validation.stale ? "STALE" : validation.state,
    sourceState: validation.state,
    generatedAt: validation.generatedAt,
    ageSec: validation.ageSec,
    stale: validation.stale,
    valuation: {
      totalValueThb,
      cashThb,
      cashWeightPct,
      cashFloorPct,
      fxThbPerUsdt: firstNumber(fx.thbPerUsdt, fx.thb_per_usdt, fx.rate),
      fxFreshness: String(fx.freshnessStatus || fx.freshness_status || "UNKNOWN"),
    },
    assets,
    plan: {
      mode: String(plan.mode || "UNKNOWN"),
      buyTotalThb: firstNumber(plan.buyTotalThb, plan.buy_total_thb, 0),
      trimTotalThb: firstNumber(plan.trimTotalThb, plan.trim_total_thb, 0),
      turnoverPct: firstNumber(plan.turnoverPct, plan.turnover_pct, 0),
      projectedCashWeightPct: firstNumber(plan.projectedCashWeightPct, plan.projected_cash_weight_pct, plan.projectedPortfolio?.cashWeightPct, plan.projected_portfolio?.cash_weight_pct),
      buyBasket,
      trimBasket,
    },
    blockers: firstArray(snapshot.blockers, plan.blockers),
    warnings: firstArray(snapshot.warnings, plan.warnings),
    disclaimer: String(snapshot.disclaimer || "analysis only; no order is created or sent"),
  };
}

function safeJsonResponse(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function readBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function fetchJsonLoopback(url, timeoutMs = 2500, maxBytes = 1024 * 1024) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let parsed;
    try { parsed = new URL(url); } catch { return done(null); }
    if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return done(null);
    const req = http.get(parsed, { timeout: timeoutMs }, (res) => {
      let body = "";
      let bytes = 0;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) { req.destroy(); return done(null); }
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return done(null);
        try { done(JSON.parse(body)); } catch { done(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); done(null); });
    req.on("error", () => done(null));
  });
}

function summarizeDesk(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return { available: false };
  const balance = snapshot.balance || null;
  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
  return {
    available: true,
    version: String(snapshot.version || "UNKNOWN"),
    generatedAt: String(snapshot.generatedAt || ""),
    environment: String(snapshot.environment || "UNKNOWN"),
    paused: !!snapshot.paused,
    tradeEnabled: !!snapshot.tradeEnabled,
    autoTrade: !!snapshot.autoTrade,
    autoTradeSignal: !!snapshot.autoTradeSignal,
    health: {
      loops: snapshot.health?.loops || null,
      lastOkTickAt: snapshot.health?.lastOkTickAt || null,
      consecutiveTickErrors: firstNumber(snapshot.health?.consecutiveTickErrors, 0),
      pausedReason: snapshot.health?.pausedReason || null,
    },
    balance: balance ? {
      asset: String(balance.asset || "USDT"),
      totalWalletBalance: firstNumber(balance.totalWalletBalance),
      availableBalance: firstNumber(balance.availableBalance),
      totalUnrealizedProfit: firstNumber(balance.totalUnrealizedProfit),
    } : null,
    positions: positions.map((item) => ({
      symbol: String(item.symbol || ""), side: String(item.side || ""),
      size: firstNumber(item.size), unrealizedPnl: firstNumber(item.unrealizedPnl, item.pnl),
      leverage: firstNumber(item.leverage),
    })),
    scanCount: Array.isArray(snapshot.scan) ? snapshot.scan.length : 0,
    copilot: snapshot.copilot ? {
      decision: snapshot.copilot.decision || "UNKNOWN",
      stale: !!snapshot.copilot.stale,
      decisionId: snapshot.copilot.decision_id || "",
    } : null,
  };
}

function createPlugin(ctx) {
  const log = typeof ctx.log === "function" ? ctx.log : () => {};
  const cfgFile = path.join(ctx.dataDir, "config.json");
  const publishedFile = path.join(ctx.dataDir, "latest-snapshot.json");
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  if (!fs.existsSync(cfgFile)) {
    try { fs.writeFileSync(cfgFile, JSON.stringify(DEFAULTS, null, 2)); }
    catch (error) { log("spot-command-center: config init failed: " + error.message); }
  }

  function cfg() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch {}
    const paths = Array.isArray(saved.snapshotPaths) ? saved.snapshotPaths : DEFAULTS.snapshotPaths;
    return { ...DEFAULTS, ...saved, snapshotPaths: paths };
  }

  function candidates() {
    const unique = new Set([publishedFile, ...cfg().snapshotPaths.map(String)]);
    return [...unique];
  }

  function readLatest() {
    const c = cfg();
    const failures = [];
    for (const file of candidates()) {
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        if (stat.size > c.maxSnapshotBytes) {
          failures.push({ reasonCode: "SNAPSHOT_TOO_LARGE", fileName: path.basename(file) });
          continue;
        }
        const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
        const validation = validateSnapshot(snapshot, { maxAgeSec: c.maxAgeSec });
        if (!validation.ok) {
          failures.push({ reasonCode: validation.reasonCode, fileName: path.basename(file) });
          continue;
        }
        return { ok: true, file, fileName: path.basename(file), snapshot, validation, summary: summarizeSnapshot(snapshot, validation) };
      } catch (error) {
        if (error && error.code !== "ENOENT") failures.push({ reasonCode: "SNAPSHOT_READ_FAILED", fileName: path.basename(file) });
      }
    }
    return { ok: false, failures };
  }

  async function readDesk() {
    const raw = await fetchJsonLoopback(cfg().deskUrl);
    return summarizeDesk(raw);
  }

  async function combined() {
    const latest = readLatest();
    const desk = await readDesk();
    const spot = latest.ok ? latest.summary : { available: false, failures: latest.failures };
    let estimatedCombinedCapitalThb = null;
    if (spot.available && desk.available && desk.balance) {
      const fx = spot.valuation.fxThbPerUsdt;
      const spotTotal = spot.valuation.totalValueThb;
      const futuresEquity = firstNumber(desk.balance.totalWalletBalance, 0) + firstNumber(desk.balance.totalUnrealizedProfit, 0);
      if (fx !== null && spotTotal !== null) estimatedCombinedCapitalThb = Math.round((spotTotal + futuresEquity * fx) * 100) / 100;
    }
    return {
      ok: true,
      capability: "READ_ONLY_ANALYSIS",
      lanesIndependent: true,
      spot,
      futuresDesk: desk,
      estimatedCombinedCapitalThb,
      estimateNote: estimatedCombinedCapitalThb === null ? null : "Estimate only: manual Spot valuation plus Futures wallet equity converted using the Spot snapshot FX.",
      executionBoundary: "Spot analysis cannot call Binance Trader commands or create execution intent.",
    };
  }

  let lastFingerprint = "";
  function fingerprint() {
    for (const file of candidates()) {
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) return `${file}:${stat.size}:${stat.mtimeMs}`;
      } catch {}
    }
    return "missing";
  }
  lastFingerprint = fingerprint();
  const timer = setInterval(() => {
    const next = fingerprint();
    if (next === lastFingerprint) return;
    lastFingerprint = next;
    try { ctx.broadcast({ type: "plugin.event", plugin: "spot-command-center", event: "snapshot-changed" }, false); } catch {}
  }, Math.max(5000, Number(cfg().pollMs) || DEFAULTS.pollMs));
  if (timer.unref) timer.unref();

  const routes = {
    state(req, res) {
      if (req.method !== "GET") return safeJsonResponse(res, 405, { ok: false, reasonCode: "METHOD_NOT_ALLOWED" });
      const latest = readLatest();
      if (!latest.ok) return safeJsonResponse(res, 200, { ok: false, available: false, state: "UNAVAILABLE", failures: latest.failures });
      return safeJsonResponse(res, 200, { ok: true, sourceFile: latest.fileName, appUrl: cfg().appUrl, ...latest.summary });
    },
    snapshot(req, res) {
      if (req.method !== "GET") return safeJsonResponse(res, 405, { ok: false, reasonCode: "METHOD_NOT_ALLOWED" });
      const latest = readLatest();
      if (!latest.ok) return safeJsonResponse(res, 404, { ok: false, reasonCode: "SNAPSHOT_UNAVAILABLE", failures: latest.failures });
      return safeJsonResponse(res, 200, latest.snapshot);
    },
    async desk(req, res) {
      if (req.method !== "GET") return safeJsonResponse(res, 405, { ok: false, reasonCode: "METHOD_NOT_ALLOWED" });
      return safeJsonResponse(res, 200, await readDesk());
    },
    async combined(req, res) {
      if (req.method !== "GET") return safeJsonResponse(res, 405, { ok: false, reasonCode: "METHOD_NOT_ALLOWED" });
      return safeJsonResponse(res, 200, await combined());
    },
    async publish(req, res) {
      if (req.method !== "POST") return safeJsonResponse(res, 405, { ok: false, reasonCode: "METHOD_NOT_ALLOWED" });
      if (String(req.headers["x-bagidea-ui"] || "") !== "1") {
        return safeJsonResponse(res, 403, { ok: false, reasonCode: "UI_HEADER_REQUIRED" });
      }
      try {
        const body = await readBodyLimited(req, cfg().maxSnapshotBytes);
        const snapshot = JSON.parse(body);
        const validation = validateSnapshot(snapshot, { maxAgeSec: cfg().maxAgeSec });
        if (!validation.ok) return safeJsonResponse(res, 400, { ok: false, ...validation });
        const tmp = publishedFile + ".tmp-" + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, publishedFile);
        lastFingerprint = fingerprint();
        try { ctx.broadcast({ type: "plugin.event", plugin: "spot-command-center", event: "snapshot-published", generatedAt: validation.generatedAt }, false); } catch {}
        return safeJsonResponse(res, 200, { ok: true, version: "spot-command-center-publish/v1", generatedAt: validation.generatedAt, state: validation.stale ? "STALE" : validation.state });
      } catch (error) {
        const reasonCode = error && error.message === "BODY_TOO_LARGE" ? "SNAPSHOT_TOO_LARGE" : "SNAPSHOT_PUBLISH_FAILED";
        return safeJsonResponse(res, reasonCode === "SNAPSHOT_TOO_LARGE" ? 413 : 400, { ok: false, reasonCode });
      }
    },
  };

  return {
    async onCommand(cmd, args) {
      const command = String(cmd || "").trim().toLowerCase();
      if (command === "health") {
        const latest = readLatest();
        return latest.ok
          ? { ok: true, available: true, state: latest.summary.state, stale: latest.summary.stale, ageSec: latest.summary.ageSec, sourceFile: latest.fileName, schema: latest.summary.schema, capability: "READ_ONLY_ANALYSIS" }
          : { ok: true, available: false, state: "UNAVAILABLE", failures: latest.failures, capability: "READ_ONLY_ANALYSIS" };
      }
      if (command === "snapshot") {
        const latest = readLatest();
        return latest.ok ? { ok: true, ...latest.summary } : { ok: false, state: "UNAVAILABLE", failures: latest.failures };
      }
      if (command === "asset") {
        const symbol = String(args || "").trim().toUpperCase();
        if (!symbol) return { ok: false, msg: "usage: asset <BTC|ETH|SOL|BNB|XRP>" };
        const latest = readLatest();
        if (!latest.ok) return { ok: false, state: "UNAVAILABLE", failures: latest.failures };
        const asset = latest.summary.assets.find((item) => item.asset === symbol);
        return asset ? { ok: true, state: latest.summary.state, generatedAt: latest.summary.generatedAt, asset } : { ok: false, msg: "asset not found" };
      }
      if (command === "rebalance") {
        const latest = readLatest();
        return latest.ok ? { ok: true, state: latest.summary.state, generatedAt: latest.summary.generatedAt, plan: latest.summary.plan, blockers: latest.summary.blockers, warnings: latest.summary.warnings } : { ok: false, state: "UNAVAILABLE", failures: latest.failures };
      }
      if (command === "combined") return await combined();
      if (command === "open") return { ok: true, appUrl: cfg().appUrl, note: "Open locally; this command does not start, trade or modify the app." };
      return { ok: false, msg: "unknown command (health | snapshot | asset <symbol> | rebalance | combined | open)" };
    },
    routes,
    dispose() { clearInterval(timer); },
  };
}

module.exports = createPlugin;
module.exports._test = {
  validateSnapshot,
  summarizeSnapshot,
  summarizeDesk,
  walkForForbiddenKeys,
  snapshotSchema,
  ageSec,
};
