// Regression cover for the B2 capability/secret boundary. Every case here was
// a verified bypass on the first bridge implementation.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const plugin = require(path.join(__dirname, "..", "..", "plugins", "spot-command-center", "index.js"));
const { validateSnapshot } = plugin._test;

function base(extra = {}) {
  return {
    schema_version: "spot-command-center/v1",
    generated_at: new Date().toISOString(),
    mode: "READ_ONLY_ANALYSIS",
    state: "HEALTHY",
    ...extra
  };
}

test("a snapshot that declares no capability mode is rejected, never defaulted", () => {
  const withoutMode = base();
  delete withoutMode.mode;
  const result = validateSnapshot(withoutMode, {});
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "CAPABILITY_NOT_DECLARED");
  assert.equal(result.mode, undefined, "no mode may be fabricated for the caller");
});

test("empty or non-string capability values are rejected", () => {
  for (const mode of ["", "   ", false, 0, null, [], {}]) {
    const result = validateSnapshot(base({ mode }), {});
    assert.equal(result.ok, false, `mode=${JSON.stringify(mode)}`);
  }
});

test("capability matching is exact — NOT_READ_ONLY must not satisfy it", () => {
  const hostile = [
    "NOT_READ_ONLY",
    "READ_ONLY_PLUS_ORDER_ROUTING",
    "READ_ONLY_AUTO_SUBMIT",
    "READ_ONLY_ANALYSIS_AND_EXECUTION",
    "LIVE_READ_ONLY"
  ];
  for (const mode of hostile) {
    const result = validateSnapshot(base({ mode }), {});
    assert.equal(result.ok, false, mode);
    assert.equal(result.reasonCode, "CAPABILITY_NOT_READ_ONLY", mode);
  }
  assert.equal(validateSnapshot(base({ mode: "READ_ONLY_ANALYSIS" }), {}).ok, true);
  assert.equal(validateSnapshot(base({ mode: "read_only_analysis" }), {}).ok, true);
});

test("credential-shaped keys are rejected in every casing and separator form", () => {
  const keys = [
    "apiKey", "api_key", "API_KEY", "api-key", "api key",
    "apiSecret", "api_secret", "secretKey", "secret_key",
    "privateKey", "private_key", "passphrase", "credential",
    "authorization", "accessToken", "refresh_token", "X-MBX-APIKEY",
    "mnemonic", "seed", "seedPhrase", "seed_phrase",
    "withdraw", "withdrawal", "withdrawAddress", "withdrawal_address",
    "transfer", "transferRequest", "signature", "signedRequest",
    "executionIntent", "execution_intent", "orderPayload", "order_payload"
  ];
  for (const key of keys) {
    const result = validateSnapshot(base({ nested: [[{ [key]: "value" }]] }), {});
    assert.equal(result.ok, false, `${key} must be rejected`);
    assert.equal(result.reasonCode, "FORBIDDEN_CAPABILITY_FIELD", key);
  }
});

test("unicode-folded key forms cannot smuggle a credential field", () => {
  const disguised = ["ａｐｉｋｅｙ", "api​key", "apikey‍"];
  for (const key of disguised) {
    const result = validateSnapshot(base({ deep: { level: [{ [key]: "x" }] } }), {});
    assert.equal(result.ok, false, JSON.stringify(key));
  }
});

test("secret-shaped values are rejected even under an innocent key", () => {
  const values = [
    "-----BEGIN RSA PRIVATE KEY-----MIIE",
    "api_key=AKIAIOSFODNN7EXAMPLE",
    "api-secret: hunter2hunter2",
    "X-MBX-APIKEY",
    "AKIAIOSFODNN7EXAMPLE",
    "sk-livekey0123456789abcdef",
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
    "xoxb-1234567890-abcdefghij",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig"
  ];
  for (const value of values) {
    const result = validateSnapshot(base({ note: value }), {});
    assert.equal(result.ok, false, value.slice(0, 24));
    assert.equal(result.reasonCode, "FORBIDDEN_CAPABILITY_FIELD");
  }
});

test("the scan reaches arbitrary array/object nesting depth", () => {
  let payload = { api_key: "leaked" };
  for (let depth = 0; depth < 40; depth += 1) {
    payload = depth % 2 === 0 ? [payload] : { level: payload };
  }
  const result = validateSnapshot(base({ payload }), {});
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "FORBIDDEN_CAPABILITY_FIELD");
});

test("a cyclic snapshot is handled without hanging", () => {
  const cyclic = base();
  cyclic.self = cyclic;
  const result = validateSnapshot(cyclic, {});
  assert.equal(result.ok, true);
});

test("a clean canonical snapshot still validates", () => {
  const clean = base({
    audit_status: "PENDING_P1_HARDENING",
    inputs_hash: "abc123",
    valuation: { total_value_thb: 100, fx: { thb_per_usdt: 35, source: "CREATOR_DECLARED" } },
    buy_basket: [{ asset: "BTC", amount_thb: 100 }],
    trim_basket: [],
    disclaimer: "analysis only; no order is created or sent"
  });
  const result = validateSnapshot(clean, {});
  assert.equal(result.ok, true);
  assert.equal(result.mode, "READ_ONLY_ANALYSIS");
});

test("the snapshot route returns the validated projection, never the raw file", () => {
  const source = require("fs").readFileSync(
    path.join(__dirname, "..", "..", "plugins", "spot-command-center", "index.js"),
    "utf8"
  );
  const routeBody = source.slice(source.indexOf("snapshot(req, res)"));
  const end = routeBody.indexOf("desk(req, res)");
  const snapshotRoute = routeBody.slice(0, end > 0 ? end : 800);
  assert.doesNotMatch(
    snapshotRoute,
    /safeJsonResponse\(res,\s*200,\s*latest\.snapshot\)/,
    "the raw snapshot object must not be echoed to callers"
  );
  assert.match(snapshotRoute, /latest\.summary/);
});
