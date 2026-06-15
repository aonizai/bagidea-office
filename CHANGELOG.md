# Changelog

All notable changes to BagIdea Office. A **release** is a deliberate `VERSION`
bump on `main` (see [RELEASING.md](RELEASING.md)) — that's what triggers the
in-app 🔄 update banner. Versions follow [semver](https://semver.org).

## [0.7.22] — Tools Hub, Plugins Hub & Workflow Builder speak every language

**Changed**
- **The pop-out windows now translate into all 14 languages**, not just Thai/
  English. The Tools Hub, Plugins Hub and Workflow Builder auto-translate to your
  office language (and ship pre-translated, so they show instantly) — they used to
  fall back to English for everything except Thai.

## [0.7.21] — More of the UI ships pre-translated

**Changed**
- **Newer screens now ship pre-translated** in all 14 languages — the Plugins Hub,
  the display menu, the confirm dialogs and more show in your language instantly,
  instead of waiting for on-the-fly translation the first time.

## [0.7.20] — Workflow Builder polish & friendlier scrolling

**Fixed**
- **The last Thai bit in the Workflow Builder** (the Run / Save-as-Skill help line)
  now translates properly in English offices.
- **No more white resize-grip / scrollbar** on workflow node boxes — the text area
  scrolls with the office’s slim themed scrollbar instead.

**Changed**
- **Scrolling over node text scrolls the text**, not the canvas zoom. (Zoom still
  works over empty canvas.)
- **Right-click anywhere on the workflow canvas** pops the ＋ Node menu at your
  cursor — works on examples too (adding a node + Save just makes an editable copy).
- **No native browser right-click menu** in pop-out windows anymore (Plugins,
  Workflow, Tools/Plugins Hub…). Pages that want their own menu still have one;
  the browser’s default just doesn’t butt in.
- **The agents rail scrolls sideways with the mouse wheel** — no more wrestling the
  thin scrollbar.

## [0.7.19] — Workflow Builder: English-first & right-click to add a node

**Changed**
- **The bundled workflow examples are now all in English** — a clean, global
  default. (Write your own flows in any language you like; the examples just set
  the standard.)
- **No more stray Thai** in the Workflow Builder when the office is in English —
  the new-workflow starter node follows your language too.

**Added**
- **Right-click the canvas to add a node right there.** A ＋ Node menu pops up at
  your cursor and drops the node where you clicked — no hunting for it.

## [0.7.18] — The display menu is always there

**Changed**
- **The 🖥 Display menu now always shows** (in the ⋯ menu), listing exactly the
  screens the office detected — one monitor shows one (ticked), two show two, and
  so on. Switching still remembers your choice and restarts to apply it.

## [0.7.17] — Real multi-monitor detection, its own menu & a tray Restart

**Changed**
- **The display picker is now its own menu**, separate from atmosphere — and it
  only appears when you actually have more than one monitor.
- **Monitors are detected for real.** No more phantom “Display 2/3” on a single
  screen. On a multi-monitor PC the office auto-places the wallpaper on your
  primary screen from the first launch, and lists exactly the screens you have.
- **Switching screens restarts the office for you** — no need to type
  `bagidea restart`; it re-attaches to the chosen monitor automatically.

**Added**
- **A “Restart office” item in the tray menu**, right where you’d expect it.

## [0.7.16] — One-click install straight from the website

**Added**
- **Install from the web with one click.** The “Open in office” button on a plugin’s
  web page now hands the install straight to your running office through a
  `bagidea://` link. The office always **asks you to confirm first** — a web page
  can never install code silently — and the copy-link fallback still works if the
  office isn’t open.

## [0.7.15] — Plugins Hub: a community catalog you can install in one click

**Added**
- **Plugins Hub.** A curated catalog of community plugins — browse them and install
  into your running office with a single click. Open it from **⋯ → 🧩 Plugins Hub**
  (or the button in the Plugins panel). The catalog is fetched live, so newly
  approved plugins show up without an app update.
- **A public Plugins page on the website** to discover plugins, copy an install
  link, and learn how to publish your own.
- **Anyone can submit a plugin.** Publish it as a GitHub repo, then open a PR adding
  it to the catalog — every submission is reviewed (plugins run real code on a
  user's machine). See `docs/guide/plugin-hub.md`.

## [0.7.14] — Safer deletes & clearing team proposals

**Changed**
- **Deleting in Settings now asks first.** Removing a role, skill, or staff member
  pops a clear “are you sure?” confirmation — deleting should be a deliberate act,
  not a stray click.
- **Clear team proposals in bulk.** The 💡 proposals list now lets you tick several
  and clear them at once, or clear them all — quietly, with no message sent to the
  team. Approving still happens one at a time (each spins up a real project).

## [0.7.13] — Shadows back, and crisp at any zoom

**Fixed**
- **Shadows no longer disappear at the normal camera.** The previous tweak cut the
  shadow range too short, so the office sat outside it when zoomed out and lost its
  shadows entirely. The range now covers the whole office, and the shadow map is
  twice as detailed (and a touch sharper) — so shadows stay crisp from the far
  diorama view all the way in to a close-up.

## [0.7.12] — Discussions you can watch, smarter walking & clearer shadows

**Fixed**
- **Agents stop walking through walls.** Pathfinding now always enters and leaves
  a room through its doorway instead of cutting a straight line to the nearest
  point (which could sit on the far side of a wall).
- **Shadows read clearly at the normal camera**, not only when zoomed in — tuned
  the sun’s shadow so it stays crisp at a distance.

**Changed**
- **Discussions are now live huddles.** When the team confers, members actually
  gather in a ring with a floating topic banner over them — and several
  discussions can run at the same time, each in its own spot, so you can watch
  everything on the wallpaper at once.
- **Anyone double-booked splits a stand-in (แยกร่าง).** If a teammate is heads-down
  on a task or already in another meeting, a translucent clone joins the huddle
  while the real one keeps working.
- **Tools Hub:** removed a stray duplicate “＋” icon on the “Add your own MCP” box.

## [0.7.11] — Workflow polish, centered windows, real ghost-splits & a fuller Tools Hub

**Fixed**
- **Workflow side panel no longer overflows.** Long analysis/run output now scrolls
  inside its box, so the Run / Save-as-Skill buttons stay put.
- **Workflows really split into ghosts.** When a flow has parallel branches, the
  team now actually spawns visible ghost clones (via the SUB protocol) instead of
  only *saying* it split.

**Changed**
- **Pop-out windows open centered** on screen (plugins, Workflow Builder, Tools
  Hub) instead of scattering to inconsistent spots.
- **Tools Hub is fuller** — 15 ready MCP servers plus an **“Add your own MCP”**
  box so you can install any server by pasting its command.

## [0.7.10] — Fix the Plugins “open” button

**Fixed**
- The Plugins panel's open button rendered cramped/broken (the “⤢ เปิด” icon+label
  overflowed the small icon button). It's a clean ⤢ icon again — click it or the
  row to open the plugin in its own window.

## [0.7.9] — Workflows you can run, a richer Tools Hub & full-language windows

**Added**
- **Workflows do things now.** After you build a flow, **▶️ Run now** hands it to
  the team to execute (with parallel branches & “wait for all” merges), and **🧠
  Save as Skill** turns it into a reusable skill you assign to an agent (or just
  tell an agent to “run &lt;name&gt;”). Dragging to connect nodes is fixed.
- **Workflow tabs + read-only examples.** Open several workflows in tabs and
  switch between them. **7 worked examples** (basic→advanced: PDF summary, GitHub
  triage, competitor watch, research→draft→review…) are read-only templates —
  save one to fork your own editable copy. Your test workflows are kept clean.
- **Tools Hub: more & clearer.** 12 popular MCP servers (Browser, Memory,
  Sequential-Thinking, Filesystem, Fetch, GitHub, Google Workspace, Google Maps,
  Brave Search, Postgres, Slack, Notion), installed ones grouped on top, plus a
  plain-language **“What is MCP?”** explainer and how-to.

**Changed**
- **New windows speak your language.** The Workflow Builder and Tools Hub now
  follow the office language (Thai/English; other languages fall back to English)
  instead of always showing Thai.
- **Plugins open one way** — as their own window (so they can't be open two ways
  at once), and the chat tucks aside for any new window / opened image or folder.
- **Warmer agent voices** — every spoken line now carries a lively, natural,
  anime-flavored delivery instead of a flat read.

## [0.7.8] — Visual Workflow canvas, Tools Hub & a wallpaper-stability fix

**Fixed**
- **Wallpaper no longer vanishes on Win+D / desktop click.** A v0.7.7 change
  (multi-monitor repositioning + a re-pin watcher) regressed the embed on some
  setups, making the office disappear when showing the desktop. Reverted to the
  original rock-solid embed; the monitor reposition now only runs when you've
  explicitly picked a monitor. **Recommended update for anyone on v0.7.7.**

**Added**
- **🔀 Workflow Builder is now a real graph canvas** (n8n-style): pan, zoom,
  draw arrows between nodes, **branch one→many (parallel) and merge many→one
  (wait for all)** — not just a top-to-bottom list. The Director's analysis
  understands the branches and merges.
- **🧰 Tools Hub** (⋯ menu → Tools Hub): a one-click MCP-server catalog —
  **Browser automation (Playwright)** so agents can open & drive a real browser
  for you, plus Web Fetch, Filesystem, GitHub, Slack, Google Workspace.
- **Bundled CLI tools** for agents: the installer now sets up `gh`, `ffmpeg`,
  `yt-dlp`, `jq`, `pandoc` and ImageMagick (best-effort), widening what the
  office can actually do.

## [0.7.7] — Workflow Builder, louder channels & a sturdier wallpaper

A big update — a whole new way to plan work, channels that talk back, and fixes
for the multi-monitor / desktop-click wallpaper reports.

**Added**
- **🔀 Workflow Builder.** A drag-drop canvas (⋯ menu → Workflow Builder) where
  each node is a plain-language step (trigger / fetch / action / decision /
  output / note) and the flow reads top→bottom. Hit **Analyze** and the Director
  reads your plan and tells you which skills/tools to use, what permissions or
  agents are needed, and what's still open — so non-technical users can plan work
  and let the team figure out execution. Ships with three example workflows to
  learn from. (Guide: docs/guide/workflows.md)
- **Channels do more.** Conversations at the CEO seat now **mirror out** to your
  connected Telegram / Discord / LINE; agents show a **“typing…”** indicator
  while they think; and **slash commands** (`/status`, `/agents`, `/projects`,
  `/who`, `/help`) answer instantly from any channel.
- **Pick the wallpaper monitor.** A monitor picker in the display menu (and a
  `BAGIDEA_MONITOR` override) for multi-monitor setups.
- **More agent tools & gimmicks.** Exposed `Skill` / `BashOutput` / `KillShell` /
  `SlashCommand` to the tool catalog; new idle moments (yawn, lightbulb idea,
  high-five, group selfie) so the office feels livelier.

**Changed**
- **Wallpaper sits on the right monitor.** On multi-monitor desktops it now lands
  on your primary (or chosen) screen instead of missing the screen entirely.
- **Meeting board scales with zoom** — it no longer looms oversized when zoomed
  out. The server-room incident is now a **rare** treat (cooldown), not frequent.
- **Leaner tokens** — trimmed the per-turn media note and skip it for ghost
  sub-agents.

**Fixed**
- **Wallpaper no longer detaches on a desktop click** (a re-pin watcher keeps it
  embedded; it respects an intentional Hide-office). *(GitHub #7)*
- **All staff now appear in the 3D office**, not just the CEO — a roster
  reconcile re-ensures every teammate has a body. *(GitHub #6)*
- **Multi-monitor blank wallpaper** (secondary monitor at a negative X) now
  embeds correctly. *(GitHub #5)*

## [0.7.6] — Media shows inline & your atmosphere sticks

**Fixed**
- **Agents now show media inline.** When an agent shares an image, video or audio,
  it appears right in the chat as a viewer/player — click to enlarge, ⤢ pop out,
  📂 reveal in the folder — instead of replying with a raw file path. Agents are
  told to send the file itself, and the chat now recognises more path styles
  (forward-slash and macOS paths, not just backslash and uploads).
- **Your manual day/night choice sticks.** Pinning a fixed atmosphere (e.g. 🌅
  morning) no longer snaps back to the real-time clock when the wallpaper
  reconnects or restarts — the choice is now saved and restored on every reconnect.

## [0.7.5] — Smoother wallpaper, a livelier world & sponsors

**Added**
- **Sponsor the project.** A real sponsor wall with four tiers — 💛 Supporter,
  🥉 Bronze / Backer, 🥈 Silver, 👑 Gold — powered by **GitHub Sponsors**
  (recurring monthly). Sponsors appear automatically on the website and README,
  sorted by tier (amounts never shown). See the **Sponsors** page on the site.

**Changed**
- **Shadows stay crisp at the normal wallpaper zoom.** They used to nearly vanish
  unless you zoomed right in — now they read clearly and softly without zooming.
- **Warmer noon light.** Midday was a washed-out white; it's now warm daylight
  (in the wallpaper and the 3D Office Editor).
- **Smoother chase.** Agents no longer jitter before a chase — there's a quick
  "spotted you 👀" beat, then a clean dash.
- **More cinematic server-room incident.** When the server room blows, the camera
  now focuses on it with two real explosions, fire, and matching sound.

**Fixed**
- **Hiding the office no longer stutters the wallpaper.** "Hide office" hides only
  the overlay UI — your wallpaper is still the live desktop — so it now keeps
  rendering smoothly at 30 FPS instead of crawling to ~2 FPS (which looked like a
  frozen, choppy wallpaper). Agents keep working either way.

## [0.7.4] — Pop-out windows + smarter Office Ops

**Added**
- **Pop-out plugin windows.** Open any plugin's panel as its **own window** (the
  ⤢ button) — a custom dark title bar with **minimize / maximize / close**, drag
  to move, resize from the edges. Each plugin opens one window (re-clicking just
  focuses it); different plugins open side by side. Plugins can set their default
  size (and lock it) via `plugin.json` — Calculator & Music are fixed-size. The
  first step toward plugins as real standalone apps.
- **Watch an agent live.** A 👁 button on a working project opens a read-only
  window that streams what the agent is doing right now — without interrupting it.
- **Search box on the Plugins panel** (and it was already added to Projects).

**Changed**
- **Tasks tidy themselves.** A run-now or one-time scheduled task now disappears
  once it finishes (it used to linger forever); repeating tasks stay and are now
  **editable in place**. A running task shows "working on this…".
- **Project proposals moved below your task form** so they stop covering it.
- **Calendar clarity.** Past entries grey out with a ✓, a fired reminder turns
  **yellow** ("almost due"), and any upcoming entry is editable.

**Fixed**
- The date/time picker's calendar **icon is now visible** (white) on the dark
  theme, and its popup is dark-themed.

## [0.7.3] — Dogs back on the ground

**Fixed**
- **Dogs (and the cat) no longer look like they're floating.** Their billboards
  were casting a drifting shadow that read as "airborne" (more obvious after the
  v0.7.2 shadow upgrade); they now skip shadow-casting like every other character.

## [0.7.2] — Media, project fixes, a livelier office

**Added**
- **Open chat media in a real window / its folder.** Every image & file in chat
  now has **⤢** (open in a separate, resizable window — the OS viewer/player) and
  **📂** (reveal in the file manager). Click an image for a quick in-app preview,
  or ⤢ for the big window.
- **Search box on the projects list** (OFFICE OPS → Projects) — find a project
  fast as the list grows.
- **Server-room emergencies 🔥.** The server room now occasionally blows up /
  catches fire and an agent **sprints over to put it out** — a little drama that
  finally gives the room a purpose.

**Fixed**
- **Audio & video now play (and seek) in chat** — media is served with HTTP Range,
  which Chromium/WebView2 needs for `<video>`; before, clips often wouldn't play.
- **Project ⏹ Stop now really closes the work window.** It used to leave the
  window lingering so the project looked "still open" and any click re-flagged it
  as active.
- **The 📂 open-folder button works** (it was passing the path to Explorer wrong).
- **Shadows cleaned up** — the hard, jagged, striping/cut-off look is gone
  (orthogonal shadows sized to the room, higher-res map, tuned bias).
- **The projects list stops jumping to the top** every time a status icon
  changes — it remembers your scroll position (and your search).

**Changed**
- **Agents aim for useful work, not junk.** The team now builds genuinely useful
  plugins/apps (no more throwaway-plugin spam), is more selective, and explains
  proposals in enough detail for you to decide.
- **The chase/tag game actually sprints** room-to-room now (you'll see it), with
  effects — instead of a barely-visible shuffle.

**Removed** — nothing.

## [0.7.1] — Voice input fix + audio device settings

**Fixed**
- **Voice dictation now grows the chat box.** A long spoken message used to land
  as multiple lines crammed into one unreadable row (the box only auto-grew while
  *typing*). Dictated text now expands the box exactly like typing does.

**Added**
- **Audio device settings** (⚙ → AGENTS): choose which **microphone** the office
  records your voice from and which **speaker** agent voices + sound effects play
  through — fixes cases where the wrong or too-quiet mic was being used. Your
  choice is remembered. (Speaker selection needs platform support; where it isn't
  available — e.g. macOS — it's disabled with a note pointing to the OS settings.)

## [0.7.0] — Leaner & smarter: Hermes-style memory + native skills

A big efficiency pass. The office is **exactly as capable** — every feature is
still here, agents are as smart, and they keep learning — it just uses far fewer
tokens and stays fast no matter how long it runs. Everything new is reversible
behind a setting (`retrieval`, `nativeSkills`) and falls back to the old
behavior if anything goes wrong.

**Added**
- **Relevance memory (the "Hermes" way).** Instead of pasting an agent's last few
  memories into every prompt, the office now *retrieves only the memories
  relevant to the task at hand* — so answers are better-grounded and cheaper.
- **Per-project memory.** Each project grows its own memory file; agents working
  in a project recall that project's facts specifically.
- **Archive search.** A new `archive-search` skill + a `/recall` lookup let
  agents search past conversations, meetings and notes before answering, instead
  of guessing. Pure on-device keyword search — no extra API cost.
- **Chat timestamps.** Every message now shows its date & time.
- **Click an image to view it full-size**, right inside the chat.

**Changed / Upgraded**
- **Skills are now delivered natively & on demand.** Agents still learn new
  skills automatically (nothing about learning changed), but skill instructions
  are now disclosed only when a skill is actually relevant — they no longer fill
  up every prompt. Same skills, far less overhead. Skills now also reach resumed
  sessions and sub-agents (they didn't before).
- **Lighter team meetings.** Agents discuss using a rolling window of the recent
  exchange instead of re-reading the entire growing transcript each turn (the
  full minutes are still saved). This was the single biggest token drain.
- **Cheaper Director check-ins.** The hourly overview is skipped when nothing has
  changed since the last one, and the default interval moved 30 → 60 minutes.

**Fixed / Performance**
- **The activity log no longer grows forever.** `journal.jsonl` is trimmed to a
  healthy size on startup (it was read in full on every reconnect, which got
  slow over time), and stale chat threads are pruned — your latest thread per
  agent is always kept.
- Overall: dramatically fewer tokens spent during autonomous agent-to-agent
  chatter, delegation and idle check-ins.

**Removed** — nothing. All features are intact.

## [0.6.4] — Director's desk + Thai in the Security Center

- **Fixed — agents stopped stealing the Director's desk.** Freed desks were
  recycled into the shared Ops pool *including the Director's private
  workstation* (`lead_desk`). Since the host session (main) finishes work
  constantly, that desk kept re-entering the pool and other agents would sit at
  it. The Director's desk is now excluded from the pool, so staff reliably use
  the shared Ops desks and only the Director uses the Exec workstation.
- **Fixed — Thai (and other non-ASCII) text rendered as mojibake** in the
  Windows permission card. The `PreToolUse` hook now reads stdin and POSTs its
  body as UTF-8 end-to-end, and the daemon decodes request bodies as UTF-8 in a
  single pass (so multibyte characters that straddle a TCP chunk survive too).

## [0.6.3] — Right Ctrl push-to-talk

- **Changed — Right Ctrl is the default push-to-talk hotkey.** It's rarely typed,
  which makes it ideal for hold-to-talk without clashing with normal typing.

## [0.6.2] — Smooth wallpaper

- **Fixed — wallpaper stutter / idle GPU.** A mis-firing occlusion throttle was
  pinning the renderer at ~2 fps; it's disabled until it can be made reliable.

## [0.6.1] — macOS install & CLI fixes

- **Fixed — macOS installer and path execution** issues (#2, #3) and a stray
  token that broke the `bagidea` CLI on every platform (PR #4 follow-up).
- Groundwork for auto-throttling the wallpaper when it's fully covered.

## [0.6.0] — Usability, office life & cost visibility

- Multiline chat and note inputs; notes can be opened and edited in place.
- More playful ambient life and clearer hotkey discoverability.
- Cost visibility: estimated Claude / Gemini / OpenAI spend surfaced in stats.

## [0.5.0] — First macOS support (beta)

- **First macOS build (beta)** alongside Windows.
- Full internationalization across 14 languages with resilient seed loading and
  atomic i18n cache writes.
- Daemon watchdog so the office never sits brainless after a crash.
- Localized wallpaper agent status plates to match the chosen language.

## [0.4.0] — Translations, sponsors & voices

- Ship UI translations (14 languages).
- Sponsors section (WARRIX as Gold Partner).
- More agent voices and an orb watchdog.

## [0.3.1] — Uninstall & story

- `bagidea uninstall` command.
- Sharpened the product story across README and the website.

## [0.3.0] — Art in the box

- Bundle the free / CC0 art packs (characters, 3D models, sounds) directly in
  the repo, so a fresh install and `bagidea update` carry the full look out of
  the box.

---

*Earlier history predates this changelog — see `git log` for the full record.*

[0.7.4]: https://github.com/bagidea/bagidea-office/releases/tag/v0.7.4
[0.7.3]: https://github.com/bagidea/bagidea-office/releases/tag/v0.7.3
[0.7.2]: https://github.com/bagidea/bagidea-office/releases/tag/v0.7.2
[0.7.1]: https://github.com/bagidea/bagidea-office/releases/tag/v0.7.1
[0.7.0]: https://github.com/bagidea/bagidea-office/releases/tag/v0.7.0
[0.6.4]: https://github.com/bagidea/bagidea-office/releases/tag/v0.6.4
[0.6.3]: https://github.com/bagidea/bagidea-office/releases/tag/v0.6.3
[0.6.2]: https://github.com/bagidea/bagidea-office/releases/tag/v0.6.2
[0.6.1]: https://github.com/bagidea/bagidea-office/releases/tag/v0.6.1
[0.6.0]: https://github.com/bagidea/bagidea-office/releases/tag/v0.6.0
[0.5.0]: https://github.com/bagidea/bagidea-office/releases/tag/v0.5.0
[0.4.0]: https://github.com/bagidea/bagidea-office/releases/tag/v0.4.0
[0.3.1]: https://github.com/bagidea/bagidea-office/releases/tag/v0.3.1
[0.3.0]: https://github.com/bagidea/bagidea-office/releases/tag/v0.3.0
