# Ollama (local) — run a model on your own machine, no key, no cloud

Back any agent with a model running **locally** through [Ollama](https://ollama.com) — free, offline,
private, **no API key to paste**. The office talks to Ollama through its built-in
**Anthropic ↔ OpenAI proxy**, so `claude` (the engine) keeps all its tools/skills/sessions while the
model behind it is whatever you've `ollama pull`ed.

> How it flows: `claude` sends **Anthropic Messages** → the daemon's proxy translates to **OpenAI
> Chat Completions** → forwards to Ollama's OpenAI-compatible endpoint (`/v1/chat/completions`) →
> translates the reply back. Local servers need no auth — the proxy synthesizes a placeholder key so
> the "key not set" guard passes without you typing anything.
> _(see `daemon/proxy.js` → `UPSTREAM.ollama`, `daemon/providers.js` → `PROVIDERS.ollama`)_

## Machine specs — pick a model your hardware can run

Ollama runs best on GPU VRAM but will fall back to system RAM (slower). Sizes below assume the usual
**Q4 quantization**. Rule of thumb: you need roughly **model-size-in-billions × 0.6–0.75 GB**, plus
headroom for context.

| Model size | Example tags | VRAM (ideal) | RAM (CPU fallback) | Good for |
|---|---|---|---|---|
| **7–8B** | `llama3.1:8b`, `qwen2.5-coder:7b` | ~6–8 GB | 16 GB | light assistant / chat agents |
| **13–14B** | `qwen2.5-coder:14b` | ~10–12 GB | 24 GB | small build tasks |
| **32–34B** | `qwen2.5-coder:32b`, `deepseek-r1:32b` | ~20–24 GB | 32–48 GB | solid coding/agent work |
| **70B** | `llama3.1:70b` | ~40–48 GB | 64 GB+ | best local quality, needs a big GPU |

> For **agent** work (tool calls), prefer models with strong tool-use support — `qwen2.5-coder`,
> `llama3.1` are reliable picks. Tiny models (≤3B) often fail to call tools cleanly and waste loops.

## Setup (3 steps)

**1 — Install Ollama and pull a model**

```bash
# install from https://ollama.com, then:
ollama pull qwen2.5-coder:7b     # or any tag from the table above
ollama serve                     # usually already running as a background service
```

Verify it's up and lists your model:

```bash
curl http://127.0.0.1:11434/v1/models
```

**2 — Connect in the office (one time)**

⚙ → **CONNECT → 🧠 MODELS / PROVIDERS** → find **Ollama · local** → press **🔌 Connect**.
There is **no key field** — it just probes `http://127.0.0.1:11434/v1` and fetches your installed
models. It should turn ✅.

**3 — Point an agent's brain at it**

1. ⚙ → AGENTS → edit the agent
2. **🧠 Brain** field → choose **Ollama · local**
3. **Model** field → **type the exact tag you pulled** (e.g. `qwen2.5-coder:7b`) — see the gotcha below
4. 💾 Save → takes effect on that agent's next session

## Gotchas (read these — they cause "silent" failures)

### ⚠️ You MUST set an explicit model id

Ollama has **no usable default** in the office (`fallbackModel: ""`). The proxy ignores blank or
`claude-*` model names, so if you leave the Model field empty the agent fails immediately with:

> `no model set for "ollama" — pick or type a model in the agent's 🧠 BRAIN field`

Type the **full tag including the variant**, exactly as `ollama list` shows it (e.g. `llama3.1:8b`,
not `llama3.1`, unless that tag really exists locally). _(see `proxy.js` → `pickModel` / `handle`.)_

### ⚠️ Tiny context window (`num_ctx`) truncates silently

By default Ollama caps context at **2048 tokens** and **silently drops** anything beyond it — an agent
with real tool output and history will lose its earlier context and behave erratically, with no error.
Raise it:

```bash
# global default for the server (simplest):
OLLAMA_CONTEXT_LENGTH=32768 ollama serve

# or bake it into a custom model via a Modelfile:
#   FROM qwen2.5-coder:7b
#   PARAMETER num_ctx 32768
# then:  ollama create qwen-32k -f Modelfile   (and use the tag "qwen-32k")
```

Pick a `num_ctx` your RAM/VRAM can hold — larger context costs more memory. Then set the office's
matching context window so auto-compact kicks in at the right point:
registry `providerConfig.ollama.contextWindow` (and `contextBudget`).

### ⚠️ Non-default port → use a Custom provider

The built-in Ollama entry is hard-wired to `http://127.0.0.1:11434/v1`. If Ollama runs on another
host/port (remote box, Docker, `OLLAMA_HOST`), the built-in won't reach it. Instead use **CONNECT →
Custom**, set **Base URL** to your `…/v1` endpoint, and choose **OpenAI-compatible**.

### Other notes

- **`max_tokens` is clamped to 16384** by the proxy (Claude Code asks for more than most local models
  allow); the proxy also self-heals common param rejections (`max_completion_tokens`, temperature).
- **No streaming translation** — the proxy buffers the full reply then replays it as Anthropic SSE.
  Long generations on a slow CPU will pause before the answer appears all at once; that's expected.
- **Fail-open**: if Ollama isn't reachable the run errors for that agent only — other agents (and
  Claude-backed ones) are unaffected.
- **Cost = $0** and nothing leaves your machine — ideal for private/offline work; quality is lower than
  frontier cloud models, so keep your Director/main agent on a stronger brain (see `models.md`).
