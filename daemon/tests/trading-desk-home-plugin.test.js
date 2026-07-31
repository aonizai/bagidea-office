// Safety cover for the read-only trading desk portal.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PLUGIN_DIR = path.join(__dirname, "..", "..", "plugins", "trading-desk-home");
const createPlugin = require(path.join(PLUGIN_DIR, "index.js"));
const {
  SCHEMA_VERSION, CAPABILITY, scrub, summarizeFutures, summarizeSpot,
  summarizeJournal, overallState, buildUnifiedReadModel
} = createPlugin._test;

const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "plugin.json"), "utf8"));
const panel = fs.readFileSync(path.join(PLUGIN_DIR, "panel.html"), "utf8");
const source = fs.readFileSync(path.join(PLUGIN_DIR, "index.js"), "utf8");

const FUTURES_SNAPSHOT = {
  environment: "TESTNET", paused: false, tradeEnabled: false, autoTrade: false,
  equity: 5000, availableBalance: 4900, unrealizedPnl: -12.5,
  positions: [{ symbol: "ETHUSDT", side: "LONG", qty: 0.1, entryPrice: 3600, unrealizedPnl: -12.5 }],
  health: { breaker: "CLOSED" }
};

/** Spin up a loopback stub for one or more child routes. */
async function withStub(handlers, run) {
  const server = http.createServer((req, res) => {
    const handler = handlers[req.url.split("?")[0]];
    if (!handler) { res.writeHead(404); return res.end("{}"); }
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function config(base, overrides = {}) {
  return {
    futuresUrl: `${base}/futures`,
    spotUrl: `${base}/spot`,
    journalUrl: `${base}/journal`,
    timeoutMs: 1500,
    maxBytes: 256 * 1024,
    ...overrides
  };
}

const jsonRoute = body => (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

// ---------------------------------------------------------------- read model

test("a valid combined read model is returned", async () => {
  await withStub({ "/futures": jsonRoute(FUTURES_SNAPSHOT) }, async base => {
    const model = await buildUnifiedReadModel(config(base));
    assert.equal(model.schema_version, SCHEMA_VERSION);
    assert.equal(model.capability, CAPABILITY);
    assert.equal(model.futures.available, true);
    assert.equal(model.futures.environment, "TESTNET");
    assert.equal(model.futures.position_count, 1);
    assert.equal(model.futures.trade_enabled, false);
  });
});

test("missing Futures stays safe and does not throw", async () => {
  await withStub({ "/spot": jsonRoute({ state: "HEALTHY", audit_status: "VERIFIED_LOCAL" }) }, async base => {
    const model = await buildUnifiedReadModel(config(base));
    assert.equal(model.futures.available, false);
    assert.equal(model.spot.available, true, "Spot must survive a Futures failure");
    assert.notEqual(model.state, "HEALTHY");
  });
});

test("missing Spot stays safe and reports NOT_INSTALLED without fixture data", async () => {
  await withStub({ "/futures": jsonRoute(FUTURES_SNAPSHOT) }, async base => {
    const model = await buildUnifiedReadModel(config(base));
    assert.equal(model.spot.available, false);
    assert.equal(model.spot.state, "NOT_INSTALLED");
    assert.equal(model.spot.audit_status, "P1_HARDENING_REQUIRED");
    assert.deepEqual(model.spot.assets, []);
    assert.equal(model.spot.total_value_thb, undefined, "no fabricated valuation");
    assert.equal(model.futures.available, true, "Futures must survive a Spot failure");
  });
});

test("a Spot snapshot that is not explicitly verified can never claim VERIFIED_LOCAL", async () => {
  for (const claimed of [undefined, "PENDING_P1_HARDENING", "BLOCKED", "FIXTURE", "verified_local_ish"]) {
    await withStub({ "/spot": jsonRoute({ state: "HEALTHY", audit_status: claimed }) }, async base => {
      const model = await buildUnifiedReadModel(config(base));
      assert.equal(model.spot.audit_status, "P1_HARDENING_REQUIRED", String(claimed));
    });
  }
});

test("stale Spot is shown stale and downgrades the portal state", async () => {
  await withStub({
    "/futures": jsonRoute(FUTURES_SNAPSHOT),
    "/spot": jsonRoute({ state: "STALE", stale: true, audit_status: "VERIFIED_LOCAL" })
  }, async base => {
    const model = await buildUnifiedReadModel(config(base));
    assert.equal(model.spot.stale, true);
    assert.equal(model.state, "STALE");
    assert.ok(model.warnings.includes("SPOT_STALE"));
  });
});

test("the journal reports NOT_CONNECTED until a real adapter exists", async () => {
  await withStub({ "/futures": jsonRoute(FUTURES_SNAPSHOT) }, async base => {
    const model = await buildUnifiedReadModel(config(base));
    assert.equal(model.performance_journal.available, false);
    assert.equal(model.performance_journal.state, "NOT_CONNECTED");
    assert.equal(model.performance_journal.net_pnl_after_costs, undefined);
  });
});

test("a malformed child response does not crash the portal", async () => {
  await withStub({
    "/futures": (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{not json"); },
    "/spot": (req, res) => { res.writeHead(500); res.end("boom"); }
  }, async base => {
    const model = await buildUnifiedReadModel(config(base));
    assert.equal(model.futures.available, false);
    assert.equal(model.futures.reason_code, "SOURCE_MALFORMED_JSON");
    assert.equal(model.spot.available, false);
  });
});

test("partial data can never present as HEALTHY", async () => {
  const { state } = overallState({
    futures: { available: true, state: "HEALTHY" },
    spot: { available: false, state: "NOT_INSTALLED" },
    journal: { available: false, state: "NOT_CONNECTED" }
  });
  assert.notEqual(state, "HEALTHY");
});

test("a timeout produces a degraded, non-healthy state", async () => {
  await withStub({ "/futures": () => { /* never responds */ } }, async base => {
    const model = await buildUnifiedReadModel(config(base, { timeoutMs: 200 }));
    assert.equal(model.futures.available, false);
    assert.equal(model.futures.reason_code, "SOURCE_TIMEOUT");
    assert.notEqual(model.state, "HEALTHY");
  });
});

test("an oversized child response is refused", async () => {
  await withStub({
    "/futures": (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ blob: "x".repeat(200000) })); }
  }, async base => {
    const model = await buildUnifiedReadModel(config(base, { maxBytes: 4096 }));
    assert.equal(model.futures.available, false);
    assert.equal(model.futures.reason_code, "SOURCE_TOO_LARGE");
  });
});

test("a non-loopback source is refused before any request", async () => {
  const model = await buildUnifiedReadModel({
    futuresUrl: "http://192.168.10.162:8787/plugin/binance/snapshot",
    spotUrl: "http://example.com/spot",
    journalUrl: "http://127.0.0.1:1/journal",
    timeoutMs: 500, maxBytes: 1024
  });
  assert.equal(model.futures.reason_code, "SOURCE_NOT_LOOPBACK");
  assert.equal(model.spot.reason_code, "SOURCE_NOT_LOOPBACK");
});

// ---------------------------------------------------------------- no secrets

test("credential-shaped fields from any child are stripped from the payload", async () => {
  const poisoned = {
    ...FUTURES_SNAPSHOT,
    apiKey: "AKIA-LEAK", api_key: "AKIA-LEAK", api_secret: "s3cr3t",
    nested: { credentials: { secretKey: "z", passphrase: "p" }, authorization: "Bearer x" },
    orderPayload: { side: "BUY", qty: 1 }
  };
  await withStub({ "/futures": jsonRoute(poisoned) }, async base => {
    const model = await buildUnifiedReadModel(config(base));
    const rendered = JSON.stringify(model);
    for (const leak of ["AKIA-LEAK", "s3cr3t", "apiKey", "api_key", "api_secret", "secretKey", "passphrase", "authorization", "orderPayload"]) {
      assert.ok(!rendered.includes(leak), `${leak} must not appear in the portal payload`);
    }
  });
});

test("no raw exception text or source URL reaches the payload", async () => {
  await withStub({}, async base => {
    const model = await buildUnifiedReadModel(config(base));
    const rendered = JSON.stringify(model);
    assert.doesNotMatch(rendered, /Traceback|ECONNREFUSED|at Object\.|http:\/\/127\.0\.0\.1/);
  });
});

test("scrub removes forbidden keys at depth and keeps safe data", () => {
  const cleaned = scrub({ ok: 1, deep: [{ apiSecret: "x", keep: 2 }] });
  assert.equal(cleaned.ok, 1);
  assert.equal(cleaned.deep[0].keep, 2);
  assert.equal("apiSecret" in cleaned.deep[0], false);
});

// ---------------------------------------------------------------- no execution

test("the plugin source constructs no execution surface", () => {
  // Comments that document the absence of a capability are legitimate, so the
  // assertion runs against executable code only.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(code, /plugin\/binance\/cmd/, "must never reference the command route");
  assert.doesNotMatch(code, /\bmethod:\s*["'](POST|PUT|PATCH|DELETE)["']/i);
  for (const forbidden of ["setkeys", "stoploss", "cancelorder", "closeposition"]) {
    assert.doesNotMatch(code.toLowerCase(), new RegExp(forbidden), forbidden);
  }
  // The only HTTP verb the portal may issue is GET.
  const methods = code.match(/method:\s*["'][A-Z]+["']/g) || [];
  for (const method of methods) assert.match(method, /GET/, method);
});

test("the manifest declares no keys and only read-only commands", () => {
  assert.deepEqual(manifest.needsKeys, []);
  assert.equal(manifest.id, "trading-desk-home");
  const names = manifest.commands.map(c => c.name).sort();
  assert.deepEqual(names, ["health", "summary"]);
  for (const command of manifest.commands) {
    assert.doesNotMatch(command.desc.toLowerCase(), /\b(buy|sell|order|close|cancel|leverage|autotrade)\b/);
  }
});

test("commands are read-only and reject unknown input", async () => {
  const plugin = createPlugin({ config: { futuresUrl: "http://127.0.0.1:1/x", spotUrl: "http://127.0.0.1:1/y", journalUrl: "http://127.0.0.1:1/z", timeoutMs: 300, maxBytes: 1024 } });
  const unknown = await plugin.onCommand("order", "BTCUSDT BUY 1");
  assert.equal(unknown.ok, false);
  const health = await plugin.onCommand("health");
  assert.equal(health.capability, CAPABILITY);
  plugin.dispose();
});

test("mutating HTTP methods are refused on every route", async () => {
  const plugin = createPlugin({ config: { futuresUrl: "http://127.0.0.1:1/x", spotUrl: "http://127.0.0.1:1/y", journalUrl: "http://127.0.0.1:1/z", timeoutMs: 300, maxBytes: 1024 } });
  for (const name of ["state", "health", "panel"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const captured = {};
      const res = { writeHead(status){ captured.status = status; return this; }, end(){ } };
      await plugin.routes[name]({ method }, res);
      assert.equal(captured.status, 405, `${name} ${method}`);
    }
  }
  plugin.dispose();
});

// ---------------------------------------------------------------- panel safety

test("the panel renders no execution or credential control", () => {
  const controls = /<(button|input|form|select)\b[^>]*>/gi;
  const found = panel.match(controls) || [];
  assert.equal(found.length, 0, `portal must render no interactive control, found: ${found.join(" ")}`);
  for (const word of ["password", "api key", "apikey", "secret", "auto-trade", "autotrade"]) {
    assert.ok(!panel.toLowerCase().includes(`type="${word}"`), word);
  }
});

test("the panel never targets the Binance command route and stays same-origin", () => {
  assert.doesNotMatch(panel, /plugin\/binance\/cmd/);
  assert.doesNotMatch(panel, /ws:\/\/127\.0\.0\.1|http:\/\/127\.0\.0\.1|localhost:8787/);
  const fetches = panel.match(/fetch\(\s*"([^"]*)"/g) || [];
  assert.ok(fetches.length > 0, "the panel must poll its own state route");
  for (const call of fetches) {
    assert.doesNotMatch(call, /https?:\/\//, `fetch must be same-origin relative: ${call}`);
  }
});

test("the panel declares the read-only capability and a self-contained CSP", () => {
  assert.match(panel, /READ_ONLY_DESK_PORTAL/);
  assert.match(panel, /Content-Security-Policy/);
  assert.doesNotMatch(panel, /unsafe-eval/);
  assert.doesNotMatch(panel, /https?:\/\/(cdn|fonts|www)\./, "no remote asset may be referenced");
});

test("the panel labels last-known data instead of presenting it as fresh", () => {
  assert.match(panel, /renderAll\(lastGood, true\)/);
  assert.match(panel, /STALE/);
});

test("polling has an abort timeout, backoff and no overlap", () => {
  assert.match(panel, /AbortController/);
  assert.match(panel, /if \(running\) return;/);
  assert.match(panel, /backoff/);
  assert.match(panel, /document\.hidden/);
});

// ---------------------------------------------------------------- lifecycle

test("repeated create/dispose cycles leave no timer behind", () => {
  const before = process._getActiveHandles().length;
  for (let index = 0; index < 5; index += 1) {
    const plugin = createPlugin({ config: { futuresUrl: "http://127.0.0.1:1/x", spotUrl: "http://127.0.0.1:1/y", journalUrl: "http://127.0.0.1:1/z", timeoutMs: 200, maxBytes: 1024 } });
    assert.equal(typeof plugin.dispose, "function");
    plugin.dispose();
  }
  const after = process._getActiveHandles().length;
  assert.ok(after <= before + 1, `handles grew from ${before} to ${after}`);
});

test("concurrent state requests collapse onto one in-flight refresh", async () => {
  let hits = 0;
  await withStub({
    "/futures": (req, res) => {
      hits += 1;
      setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(FUTURES_SNAPSHOT)); }, 60);
    }
  }, async base => {
    const plugin = createPlugin({ config: config(base) });
    const collect = () => new Promise(resolve => {
      plugin.routes.state({ method: "GET" }, { writeHead(){ return this; }, end(){ resolve(); } });
    });
    await Promise.all([collect(), collect(), collect()]);
    assert.equal(hits, 1, "three concurrent reads must trigger exactly one upstream fetch");
    plugin.dispose();
  });
});
