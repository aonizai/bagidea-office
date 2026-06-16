"use strict";
// ---------------------------------------------------------------------------
// Per-agent model/provider routing — the office's "swappable brain".
//
// The agent runtime is ALWAYS the Claude Code CLI (`claude -p`): it owns the
// tools, the agentic loop, skills, sessions. Only the *model behind it* changes.
// `claude` is just a client — point ANTHROPIC_BASE_URL at another endpoint and it
// talks to that backend instead, authenticated with ANTHROPIC_AUTH_TOKEN. So
// switching an agent to GLM/Qwen/DeepSeek/MiniMax is purely env + --model.
//
//   • Anthropic-format providers (direct: true)  → ANTHROPIC_BASE_URL straight at
//     their Anthropic-compatible endpoint. No proxy.
//   • OpenAI-format providers   (needsProxy: true) → ANTHROPIC_BASE_URL at a local
//     LiteLLM gateway that translates Anthropic <-> OpenAI (wired in P3).
//
// FAIL-OPEN: an unconfigured, unknown, or "claude" provider returns empty
// overrides, so the spawn is byte-identical to today's plain-Claude behavior.
// (A *configured* provider with a bad token will fail that run — same as a bad
// Claude key today; we do not silently re-route to Claude.)
// ---------------------------------------------------------------------------

// Catalog. `baseUrl` filled only where the endpoint is confirmed; the rest are
// supplied via reg.providerConfig[id].baseUrl (verified per-provider in P2).
// `models` is a hint list for the settings UI — any string is accepted.
const PROVIDERS = {
  claude: {
    label: "Claude · Anthropic", format: "anthropic", direct: true, baseUrl: null,
    models: ["", "opus", "sonnet", "haiku",
             "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  glm: {
    label: "GLM · Z.AI", format: "anthropic", direct: true,
    baseUrl: "https://api.z.ai/api/anthropic",          // confirmed (Z.AI docs)
    models: ["glm-4.6", "glm-4.5"],
  },
  deepseek: {
    label: "DeepSeek", format: "anthropic", direct: true,
    baseUrl: "https://api.deepseek.com/anthropic",       // verify in P2
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  qwen: {
    label: "Qwen · Alibaba", format: "anthropic", direct: true,
    baseUrl: "",                                          // set in P2 (providerConfig)
    models: ["qwen3-coder-plus", "qwen3-coder"],
  },
  minimax: {
    label: "MiniMax", format: "anthropic", direct: true,
    baseUrl: "",                                          // set in P2 (providerConfig)
    models: ["MiniMax-M2"],
  },
  openai: {
    label: "OpenAI · via LiteLLM", format: "openai", needsProxy: true, baseUrl: null,
    models: ["gpt-5.5", "gpt-5-mini"],
  },
  gemini: {
    label: "Gemini · via LiteLLM", format: "openai", needsProxy: true, baseUrl: null,
    models: ["gemini-3-pro", "gemini-3-flash"],
  },
};

const DEFAULT_LITELLM = "http://127.0.0.1:4000";

// resolve(provider, model, reg) -> { ok, env, modelArgs, reason }
//   env       : object spread into the child's env (ANTHROPIC_BASE_URL/_AUTH_TOKEN)
//   modelArgs : [] or ["--model", "<id>"] pushed into the claude argv
//   reg.providerConfig = {
//     glm:      { token, baseUrl?, model? },
//     deepseek: { token, baseUrl?, model? },
//     litellm:  { baseUrl?, token? },          // for openai/gemini
//     ...
//   }
function resolve(provider, model, reg = {}) {
  const out = { ok: true, env: {}, modelArgs: [], reason: "claude-default" };
  const pConf = (reg && reg.providerConfig) || {};

  // Default brain: plain Claude. Optional explicit model only.
  if (!provider || provider === "claude") {
    if (model) out.modelArgs = ["--model", String(model)];
    return out;
  }

  const spec = PROVIDERS[provider];
  if (!spec) { return { ok: false, env: {}, modelArgs: [], reason: "unknown-provider" }; }

  const pc = pConf[provider] || {};
  let baseUrl, token;

  if (spec.needsProxy) {
    // OpenAI/Gemini ride a local LiteLLM gateway (Anthropic-compatible front).
    const lc = pConf.litellm || {};
    baseUrl = lc.baseUrl || reg.litellmUrl || DEFAULT_LITELLM;
    token   = lc.token || pc.token || "litellm";   // LiteLLM master key (any non-empty)
  } else {
    baseUrl = pc.baseUrl || spec.baseUrl;
    token   = pc.token;
  }

  // Not configured yet → fail-open to plain Claude.
  if (!baseUrl || !token) {
    return { ok: false, env: {}, modelArgs: [], reason: "not-configured" };
  }

  out.env = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token };
  const m = pc.model || model;
  if (m) out.modelArgs = ["--model", String(m)];
  out.reason = provider;
  return out;
}

module.exports = { PROVIDERS, DEFAULT_LITELLM, resolve };
