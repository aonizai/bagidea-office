const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createPlugin = require("../../plugins/spot-command-center/index.js");
const { validateSnapshot, summarizeSnapshot, summarizeDesk } = createPlugin._test;

function validSnapshot(overrides = {}) {
  const generatedAt = new Date(Date.now() - 60_000).toISOString();
  return {
    schema_version: "spot-command-center/v1",
    generated_at: generatedAt,
    mode: "READ_ONLY_ANALYSIS",
    state: "HEALTHY",
    valuation: {
      total_value_thb: 120000,
      cash_thb: 60000,
      cash_weight_pct: 50,
      fx: { thb_per_usdt: 35.25, freshness_status: "HEALTHY" },
      assets: [
        {
          asset: "BTC",
          status: "DCA_1X",
          allocation_state: "UNDERWEIGHT",
          score: 4,
          current_weight_pct: 26,
          target_weight_pct: 30,
          target_gap_thb: 4800,
          market_value_thb: 31200,
          recommended_buy_thb: 2000,
          reasons: ["ENTRY_VALID"],
        },
        {
          asset: "BNB",
          status: "BLOCKED_NO_GAP",
          allocation_state: "WITHIN_BAND",
          score: 4,
          current_weight_pct: 5,
          target_weight_pct: 5,
          target_gap_thb: 0,
          market_value_thb: 6000,
          recommended_buy_thb: 0,
          blockers: ["BLOCKED_NO_GAP"],
        },
      ],
    },
    portfolio: { cash_floor_pct: 40 },
    rebalance: {
      mode: "CASHFLOW_ONLY",
      buy_total_thb: 2000,
      trim_total_thb: 0,
      turnover_pct: 1.67,
      projected_cash_weight_pct: 48.33,
      buy_basket: [{ asset: "BTC", amount_thb: 2000, reason_code: "UNDERWEIGHT_AND_ENTRY_VALID", capped_by: "TRANCHE" }],
      trim_basket: [],
    },
    disclaimer: "analysis only; no transaction is created or sent",
    ...overrides,
  };
}

test("valid read-only snapshot is accepted and summarized", () => {
  const snapshot = validSnapshot();
  const validation = validateSnapshot(snapshot, { nowMs: Date.now(), maxAgeSec: 900 });
  assert.strictEqual(validation.ok, true);
  assert.strictEqual(validation.stale, false);

  const summary = summarizeSnapshot(snapshot, validation);
  assert.strictEqual(summary.available, true);
  assert.strictEqual(summary.valuation.totalValueThb, 120000);
  assert.strictEqual(summary.valuation.cashFloorPct, 40);
  assert.strictEqual(summary.assets.length, 2);
  assert.strictEqual(summary.assets[0].asset, "BTC");
  assert.strictEqual(summary.assets[0].recommendedBuyThb, 2000);
  assert.strictEqual(summary.plan.buyTotalThb, 2000);
});

test("unsupported, stale and malformed snapshots fail closed", () => {
  assert.strictEqual(validateSnapshot(null).reasonCode, "SNAPSHOT_NOT_OBJECT");
  assert.strictEqual(validateSnapshot(validSnapshot({ schema_version: "unknown/v9" })).reasonCode, "SCHEMA_UNSUPPORTED");
  assert.strictEqual(validateSnapshot(validSnapshot({ generated_at: "not-a-date" })).reasonCode, "GENERATED_AT_INVALID");

  const old = validSnapshot({ generated_at: new Date(Date.now() - 3600_000).toISOString() });
  const validation = validateSnapshot(old, { nowMs: Date.now(), maxAgeSec: 900 });
  assert.strictEqual(validation.ok, true);
  assert.strictEqual(validation.stale, true);
  assert.strictEqual(summarizeSnapshot(old, validation).state, "STALE");
});

test("secret and execution capability fields are rejected recursively", () => {
  const withSecret = validSnapshot({ debug: { apiKey: "must-not-exist" } });
  assert.strictEqual(validateSnapshot(withSecret).reasonCode, "FORBIDDEN_CAPABILITY_FIELD");

  const withIntent = validSnapshot({ plan: { execution_intent: { side: "BUY" } } });
  assert.strictEqual(validateSnapshot(withIntent).reasonCode, "FORBIDDEN_CAPABILITY_FIELD");

  const live = validSnapshot({ mode: "LIVE_EXECUTION" });
  assert.strictEqual(validateSnapshot(live).reasonCode, "CAPABILITY_NOT_READ_ONLY");
});

test("Futures desk summary exposes context without command capability", () => {
  const summary = summarizeDesk({
    version: "office-snapshot/v1",
    generatedAt: new Date().toISOString(),
    environment: "TESTNET",
    paused: true,
    tradeEnabled: true,
    autoTrade: false,
    balance: { asset: "USDT", totalWalletBalance: 5000, availableBalance: 4900, totalUnrealizedProfit: -20 },
    positions: [{ symbol: "BTCUSDT", side: "LONG", size: 0.01, unrealizedPnl: -20, leverage: 2 }],
    health: { loops: { monitor: 1, scanner: 1 }, consecutiveTickErrors: 0 },
  });
  assert.strictEqual(summary.available, true);
  assert.strictEqual(summary.environment, "TESTNET");
  assert.strictEqual(summary.positions.length, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(summary, "commands"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(summary, "apiKey"), false);
});

test("plugin reads a local canonical snapshot and answers safe agent commands", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spot-command-center-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "latest-snapshot.json"), JSON.stringify(validSnapshot()));
  const events = [];
  const plugin = createPlugin({
    dataDir,
    broadcast: (event) => events.push(event),
    log: () => {},
  });
  try {
    const health = await plugin.onCommand("health", "");
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.available, true);
    assert.strictEqual(health.capability, "READ_ONLY_ANALYSIS");

    const asset = await plugin.onCommand("asset", "BTC");
    assert.strictEqual(asset.ok, true);
    assert.strictEqual(asset.asset.asset, "BTC");

    const rebalance = await plugin.onCommand("rebalance", "");
    assert.strictEqual(rebalance.ok, true);
    assert.strictEqual(rebalance.plan.buyTotalThb, 2000);
  } finally {
    plugin.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest and panel expose no Binance command or credential controls", () => {
  const root = path.join(__dirname, "..", "..", "plugins", "spot-command-center");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
  const commands = manifest.commands.map((item) => item.name);
  assert.deepStrictEqual(commands, ["health", "snapshot", "asset", "rebalance", "combined", "open"]);
  assert.deepStrictEqual(manifest.needsKeys, []);

  const panel = fs.readFileSync(path.join(root, "panel.html"), "utf8");
  assert.doesNotMatch(panel, /\/plugin\/binance\/cmd/);
  assert.doesNotMatch(panel, /type=["']password["']/i);
  assert.doesNotMatch(panel, /setkeys|placeOrder|autotrade|stoploss|withdraw|leverage/i);
  assert.match(panel, /READ_ONLY_ANALYSIS/);
});
