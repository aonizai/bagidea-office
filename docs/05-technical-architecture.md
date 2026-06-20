# 5. Technical Architecture

## 5.1 System Overview — Three Processes

```
┌─────────────────────────────────────────────────────────────────┐
│  PROCESS A — AGENT RUNTIME DAEMON ("Layer 0")    Node/TypeScript│
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐        │
│  │ Adapter: │ │ Adapter: │ │ Adapter: │ │ Adapter:     │  …     │
│  │ Claude   │ │ Open     │ │ OpenClaw │ │ MCP / custom │        │
│  │ Code SDK │ │ Interp.  │ │          │ │ (plugin API) │        │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘        │
│       └─────────┬──┴────────────┴──────────────┘                │
│        Normalizer → OFFICE EVENT PROTOCOL (OEP)                 │
│        + Orchestrator (Main Agent) + Task Store (SQLite)        │
│        + Permission Broker + Memory/RAG index                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │ WebSocket (localhost) — OEP events
              ┌─────────────┴───────────────┐
              ▼                             ▼
┌──────────────────────────┐   ┌──────────────────────────────┐
│ PROCESS B — WORLD        │   │ PROCESS C — SHELL & OVERLAY  │
│ RENDERER (Layer 1)       │   │ (Layer 2)        Tauri/web   │
│ Godot 4 (HD-2D scene,    │   │ Chat, panels, settings, tray │
│ behavior sim, wallpaper  │◄──┤ transparent click-through    │
│ window)                  │IPC│ window above the world       │
└──────────────────────────┘   └──────────────────────────────┘
```

**Why three processes:**
- The daemon must run headless (agents keep working with rendering off / laptop lid closed / before login if desired). It's also independently testable and could later serve a mobile companion.
- The renderer can crash/restart/swap quality without dropping agent sessions.
- The overlay uses web UI velocity (component libraries, accessibility, text rendering) which game engines are weak at; it ships as a transparent always-on-top window with per-pixel click-through outside panels.

*Considered alternative:* single Godot app with embedded UI — simpler shipping, worse text/UI/accessibility and couples agent uptime to renderer uptime. Rejected for V1 architecture but the overlay could be folded in later if IPC overhead disappoints.

## 5.2 Engine Choice — Godot 4

| Requirement | Godot 4 fit |
|---|---|
| HD-2D (3D world + 2D sprites) | First-class: 3D scene + billboarded `Sprite3D` with normal maps, lit by 3D lights |
| Volumetrics / dynamic light | Volumetric fog, SDFGI/Lightmap GI, real-time shadows in Vulkan renderer |
| Custom shaders (tilt-shift, bloom, grain) | Godot shading language; full post-processing stack |
| Lightweight always-on footprint | Far lighter than Unity/Unreal for a diorama scene; export ~50–100 MB |
| Open source / no royalty | MIT — matters for a tool users run 24/7 and for community modding |
| Windows wallpaper embedding | C++/GDExtension module for WorkerW parenting (proven technique) |

Unity is the fallback if team familiarity dictates; Unreal is overkill (footprint, battery). A pure web/Three.js renderer was considered for one-stack simplicity but volumetrics + 100-agent simulation + wallpaper mode are materially harder there.

## 5.3 Wallpaper Mode Implementation

- **Windows**: spawn the renderer window, find `Progman` → send `0x052C` to create `WorkerW`, re-parent the window between the wallpaper and the icon `SHELLDLL_DefView` layer (the Wallpaper Engine technique). Overlay (Process C) remains a normal layered window with `WS_EX_TRANSPARENT` outside hit-test regions.
- **macOS**: `NSWindow` at `kCGDesktopWindowLevel`, `collectionBehavior = .stationary` (icons render above).
- **Linux** (experimental 🧪): on **X11/Xorg**, push the Godot window to the desktop layer via EWMH hints (`_NET_WM_WINDOW_TYPE_DESKTOP` + below/sticky/skip-taskbar/skip-pager, applied with `wmctrl`/`xdotool`/`xprop`); on **Wayland**, fall back to a borderless fullscreen window pinned below. Overlay + orb stay always-on-top above it.
- **Occlusion-aware**: when a fullscreen app covers the wallpaper, renderer drops to 1 fps state-sync (or full pause), daemon unaffected. (Details in [Performance](06-performance.md).)

## 5.4 Office Event Protocol (OEP)

The contract between truth and theater. JSON over local WebSocket; every event is also journaled to SQLite (enables replay — see [Revolutionary Features](10-revolutionary-features.md)).

```jsonc
// Envelope
{ "v": 1, "ts": 1717480000123, "seq": 48211,
  "type": "task.progress", "agent": "rin", "payload": { … } }
```

Core event families:

| Family | Events | Drives |
|---|---|---|
| `agent.*` | registered, online, offline, disabled, config_changed | character spawn/despawn, dorm, directory |
| `task.*` | created, assigned, started, progress, artifact, completed, failed, cancelled | missions board, desk work, beams, celebrations |
| `llm.*` | request, stream_delta(throttled), stream_end, error, rate_limited | typing animation, server-room rack activity, confusion emotes |
| `tool.*` | invoked, output, error | sub-animations (terminal, browser pages floating) |
| `collab.*` | session_started, message, handoff, session_ended | meeting-room choreography |
| `perm.*` | requested, approved, denied, policy_changed | security center flow, blocking notifications |
| `memory.*` | query, hit, write | library beams, pneumatic tubes, crystals |
| `system.*` | provider_status, usage_tick, daemon_health | server room LEDs, lobby totem, global lighting |

Commands flow back the other way (`cmd.task.create`, `cmd.agent.summon`, `cmd.perm.respond`, `cmd.chat.send`…). The protocol is **versioned and public** — third-party agents can integrate by speaking OEP directly (or via the MCP bridge below).

## 5.5 Agent Adapters (the moat)

Each adapter normalizes a real agent system into OEP:

- **Claude Code adapter**: drives sessions via the Claude Agent SDK (spawn/resume sessions, stream events, tool-permission callbacks → `perm.requested`). Hooks map 1:1 to OEP events.
- **Open Interpreter / OpenClaw / shell-agent adapters**: wrap their process APIs / WebSocket APIs; minimum viable mapping = lifecycle + stdout-derived progress.
- **MCP bridge**: the office itself exposes an MCP server (`create_task`, `report_progress`, `request_approval`, `notify`) so *any* MCP-capable agent can opt into the office with zero custom adapter work.
- **Generic adapter** (long tail): watch a JSONL file / local HTTP endpoint with a documented mini-schema — the "it just works" path for homegrown scripts.
- **Adapter SDK**: published TypeScript package + manifest format; adapters are sandboxed plugin processes (crash isolation, permissioned).

**Capability tiers** (the UX degrades gracefully per adapter):
- Tier 1: lifecycle only → character exists, works/sleeps.
- Tier 2: + tasks/progress → missions, desk animations, beams.
- Tier 3: + streaming/tools/permissions → full theater (typing, security flow, meeting rooms).

## 5.6 Orchestrator (the Main Agent)

The CEO character is real: a daemon-owned orchestration loop (default: Claude via Agent SDK) that
1. receives user chat/voice, 2. plans, 3. creates tasks in the Task Store, 4. assigns them to registered agents by capability tags, 5. monitors and synthesizes results.
Users can bypass it and chat with any agent directly (Agent Switcher). Orchestration policies (auto-delegate vs. ask-first) are settings — surfaced as the CEO's "management style."

## 5.7 Data & State

- **SQLite (daemon-owned)**: agents, tasks/missions, event journal (ring buffer ~7 days), permission policies, progression/XP, settings.
- **World save (renderer-owned)**: cosmetic state only — office layout/decor, camera bookmarks, unlocks. Corrupting/deleting it never loses real work.
- **Memory/RAG**: vector index (local, e.g. sqlite-vss/LanceDB) backing the Archive Library; adapters may also surface their own memory stores as additional "shelves."

## 5.8 Voice Pipeline

- **Input**: local VAD + whisper.cpp (small) for push-to-talk; optional cloud STT for continuous mode. Wake-word ("Hey Office") via lightweight local model (e.g., openWakeWord).
- **Output**: per-agent TTS voice (local Piper voices by default; premium cloud voices optional). Captions always rendered in chat.
- Latency budget: ≤300ms from PTT release to transcript shown; agent "turns to face you" immediately on VAD trigger (perceived responsiveness).

## 5.9 Security Model

- Daemon binds localhost only, with a session token shared to renderer/overlay at spawn.
- **Permission Broker** is the single chokepoint for privileged agent actions; policies (allow/deny/ask, per agent × per tool × per scope) stored centrally — the Security Center UI edits these. Adapters must route approvals through it (Claude Code adapter: permission callbacks; others: documented requirement for Tier-3 badge).
- Approval prompts always display the raw command/diff — no summarized-only approvals.
- Plugin adapters run as separate OS processes with explicit grant manifests.

## 5.10 Tech Stack Summary

| Component | Choice |
|---|---|
| Daemon | Node.js + TypeScript, SQLite, ws |
| Renderer | Godot 4 (Vulkan), GDScript + GDExtension (C++ for wallpaper embed & crowd sim) |
| Overlay/Shell | Tauri 2 (Rust shell + web UI: React/Solid), tray, auto-update |
| Voice | whisper.cpp, openWakeWord, Piper TTS |
| Protocol | OEP v1 (JSON/WebSocket, journaled) |
| Distribution | Windows first (wallpaper culture lives there), then macOS, Linux |
