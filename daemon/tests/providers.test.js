const test = require("node:test");
const assert = require("node:assert");
const { resolve, PROVIDERS } = require("../providers");

test("default brain: no provider → empty overrides, no model arg", () => {
  const r = resolve(undefined, "", {});
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.env, {});
  assert.deepStrictEqual(r.modelArgs, []);
});

test("claude + explicit model → --model only, no env override", () => {
  const r = resolve("claude", "sonnet", {});
  assert.deepStrictEqual(r.env, {});
  assert.deepStrictEqual(r.modelArgs, ["--model", "sonnet"]);
});

test("GLM configured → z.ai endpoint + token in env", () => {
  const reg = { providerConfig: { glm: { token: "zk-123" } } };
  const r = resolve("glm", "glm-4.6", reg);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
  assert.strictEqual(r.env.ANTHROPIC_AUTH_TOKEN, "zk-123");
  assert.deepStrictEqual(r.modelArgs, ["--model", "glm-4.6"]);
});

test("GLM NOT configured (no token) → fail-open to plain Claude", () => {
  const r = resolve("glm", "glm-4.6", { providerConfig: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-configured");
  assert.deepStrictEqual(r.env, {});
  assert.deepStrictEqual(r.modelArgs, []);
});

test("unknown provider → fail-open, never throws", () => {
  const r = resolve("totally-made-up", "x", { providerConfig: { "totally-made-up": { token: "t" } } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unknown-provider");
  assert.deepStrictEqual(r.env, {});
});

test("per-agent baseUrl + model override via providerConfig", () => {
  const reg = { providerConfig: { qwen: { token: "qk", baseUrl: "https://qwen.example/anthropic", model: "qwen3-coder-plus" } } };
  const r = resolve("qwen", "ignored", reg);
  assert.strictEqual(r.env.ANTHROPIC_BASE_URL, "https://qwen.example/anthropic");
  assert.strictEqual(r.env.ANTHROPIC_AUTH_TOKEN, "qk");
  assert.deepStrictEqual(r.modelArgs, ["--model", "qwen3-coder-plus"]); // pc.model wins
});

test("openai routes through LiteLLM gateway (proxy provider)", () => {
  const reg = { providerConfig: { litellm: { baseUrl: "http://127.0.0.1:4000", token: "sk-master" } } };
  const r = resolve("openai", "gpt-5.5", reg);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4000");
  assert.strictEqual(r.env.ANTHROPIC_AUTH_TOKEN, "sk-master");
  assert.deepStrictEqual(r.modelArgs, ["--model", "gpt-5.5"]);
});

test("proxy provider with no litellm config still resolves (default url + placeholder token)", () => {
  const r = resolve("gemini", "gemini-3-pro", {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4000"); // DEFAULT_LITELLM
  assert.ok(r.env.ANTHROPIC_AUTH_TOKEN); // non-empty placeholder
});

test("P2 confirmed endpoints resolve from catalog with just a token", () => {
  const cases = {
    deepseek: "https://api.deepseek.com/anthropic",
    qwen: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    minimax: "https://api.minimax.io/anthropic",
  };
  for (const [prov, url] of Object.entries(cases)) {
    const r = resolve(prov, "", { providerConfig: { [prov]: { token: "k" } } });
    assert.strictEqual(r.ok, true, prov);
    assert.strictEqual(r.env.ANTHROPIC_BASE_URL, url, prov);
    assert.strictEqual(r.env.ANTHROPIC_AUTH_TOKEN, "k", prov);
  }
});

test("catalog exposes the seven planned providers", () => {
  for (const p of ["claude", "glm", "deepseek", "qwen", "minimax", "openai", "gemini"]) {
    assert.ok(PROVIDERS[p], `missing provider: ${p}`);
  }
});
