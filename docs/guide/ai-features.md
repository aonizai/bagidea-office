# AI Features — main keys, voice, images, memory, realtime

The program's AI features are powered by **Main API Keys** — set them once at
⚙ → 🔗 CONNECT and everything unlocks.

## 🔑 Main API Keys

| Key | Unlocks |
|---|---|
| **OPENAI_API_KEY** | 🎤 Speech-to-text (Whisper) · 🖼 Image generation |
| **GEMINI_API_KEY** | 🎤 Speech-to-text · 🗣 Agent voices · 📞 Realtime · 🖼 Image generation |

- If a key isn't set, the related buttons appear **dimmed and disabled**, with a note explaining which key is required.
- The cards on the CONNECT page clearly state what each key unlocks, plus a link to obtain the key.
- **See which features are ready**: ⚙ → TOOLS → SYSTEM TOOLS (✅/🔒)

**Additional API Keys** (e.g. `GEMINI2`) are stored separately for agents to use in their own work
— injected into every session's env automatically.

## 🎤 Speech-to-text

- **🎤 button** next to the chat box: click to record, speak, click again → text drops into the input field.
- **F6**: press to start recording, press again → sent as a command on behalf of the CEO immediately (works in every mode).
- A live VU meter appears in the red box so you know the mic is picking you up.
- The first time, the WebView asks for mic permission — click Allow once.

## 🗣 Agent voices (TTS)

Set a voice for an agent on the edit page (⚙ → AGENTS → edit → 🗣 Voice) — there are **16 presets,
clearly split female ♀ / male ♂ (8 each)**, each with its own mood/style
(bright, calm and cool, warm and deep, storyteller, etc.). Press **▶ Preview**
to listen before choosing (`bagidea voices` lists them all).

- Agents speak **only when something is genuinely worth announcing** (an important task done / the owner asks them to read it aloud) —
  they don't read every message; it's just flavor.
- Toggle all on/off at ⚙ → AGENTS → 🗣 Agent voices
- Requires GEMINI_API_KEY

## 📞 Realtime voice chat

Press the **📞** button next to the chat box → talk live by voice with the **main agent** via Gemini Live.
(The 📞 button only shows when main is selected — it's the office's spokesperson.) It knows the office's info
(OFFICE.md + the team) and uses **the voice you set for main**; if none is set, it uses the default preset ·
press 📞 again to hang up · requires GEMINI_API_KEY

> **Note — calls go straight to main only:** A live call always reaches the **main agent**
> (the default is the Director — SHINO, the office's spokesperson), never another agent.
> That's why the 📞 button only appears when main is selected (or at the CEO seat, where the call routes to main anyway).
> **There is no "set as main" button** that promotes another employee to lead — the main slot
> is a fixed Director position. If you want to change who main is / its persona / its voice,
> go to **⚙ → AGENTS → edit the Director (main) row** and adjust the name / persona / 🗣 voice
> of that row directly.

## 🖼 AI image generation

- You: `bagidea image "a cute robot mascot"` → get an image file
- Agents can call it themselves (via /gen/image) — generated images **show up in chat automatically**
- Uses OpenAI gpt-image-1 or Gemini (fallback)

## 📎 Attachments & media in chat

- Press the **📎** button or **drag and drop a file** onto the window — it uploads and attaches to your message.
- Chat displays **images / video / audio** inline · agents can also open attached files with Read.
- When an agent creates a file and mentions its path, a preview is shown right away.

## 🧠 Memory (Hermes-style)

It grows with you while staying token-efficient:

- **OFFICE.md** (🗂 → NOTES, at the bottom): shared info every agent knows — read
  only when relevant to the work, not loaded every time.
- **Per-agent memory notebooks** `workspace/memory/<agent>.md`: agents jot down important facts
  about you / the work themselves, automatically, after real work (`bagidea memory <agent>` to read).
- A new session sees only **a pointer + the last few lines of memory** — the rest is fetched on demand.

## ☕ A living office + project proposals

- ⚙ → AGENTS → ☕ SOCIAL: let idle agents wander over to meet up — sometimes two chat,
  sometimes **groups of 3–4** chat / banter / brainstorm (mostly canned dialogue,
  free, no token cost; occasionally a real conversation via Claude).
- When a chat crystallizes into an idea → they write a **project proposal** for approval in 🗂 → TASKS.
  The proposal is steered toward being an independent creative work, or a **plugin for the office** (it won't
  touch the program's core systems directly, since that would break things).
- Press **✅ Approve / ✕ Reject** along with **typing a message to the team** (optional, works either way).
  Once approved, the task is created in the **`projects/`** folder (default) and the Director assembles a team for it
  — read the full details before deciding with `bagidea proposal show <id>`
