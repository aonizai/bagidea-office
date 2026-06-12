const path = require("path");

const REPLAY_COUNT = 80;
const MAX_STAFF = 18;

const BUILTIN_TOOLS = {
  Read: "อ่านไฟล์ / รูปภาพ / PDF",
  Glob: "ค้นหาไฟล์จากชื่อหรือแพทเทิร์น",
  Grep: "ค้นหาข้อความ/โค้ดในไฟล์",
  Edit: "แก้ไขไฟล์ที่มีอยู่",
  Write: "สร้างไฟล์ใหม่ / เขียนทับ",
  Bash: "รันคำสั่งเชลล์และโปรแกรม",
  WebSearch: "ค้นหาข้อมูลบนเว็บ",
  WebFetch: "เปิดอ่านหน้าเว็บ",
  Task: "ปล่อย sub-agent ช่วยทำงานย่อย",
  TodoWrite: "จดและติดตามรายการงาน",
  NotebookEdit: "แก้ไข Jupyter notebook",
};

const SKILL_LIBRARY = {
  "deep-research": {
    name: "Deep Research",
    description: "Methodical web research that ends in a sourced, decision-ready brief.",
    content: [
      "When asked to research a topic:",
      "1. Restate the question and list the specific sub-questions to answer.",
      "2. Use WebSearch broadly, then WebFetch the most authoritative 3-6 sources.",
      "3. Cross-check every key claim in 2+ sources; flag anything you can't confirm.",
      "4. Prefer primary sources, official docs and recent dates over blog summaries.",
      "5. Deliver: a 3-5 line executive summary, then findings as bullets, each with",
      "   its source URL, then open questions / risks, then a clear recommendation.",
      "6. Never invent facts or URLs. If evidence is thin, say so plainly.",
    ].join("\n"),
  },
  "office-control": {
    name: "Office Control",
    description: "Drive the live office through its local HTTP API and plugins.",
    content: [
      "The office daemon runs at http://127.0.0.1:8787. Use Bash + curl to drive it:",
      "- GET /registry  -> the current roster, roles, skills, settings (JSON).",
      "- Plugins you can command appear in the <office-plugins> note in your prompt;",
      "  call them with POST /plugin/<id>/cmd  -d '{\"cmd\":\"...\",\"args\":\"...\"}'.",
      "- To leave a note for the owner, append a '- <line>' to workspace/notes.md.",
      "Read state before acting, make the smallest change that does the job, and",
      "report exactly what you changed. Never call owner-only or destructive APIs.",
    ].join("\n"),
  },
  "office-ops": {
    name: "Office Operations",
    description: "Run the BagIdea Office well — the team, delegation, ghosts, projects, permissions and plugins.",
    content: [
      "You run a live office of AI agents on the owner's wallpaper. Operate it well:",
      "- DELEGATE work with a line EXACTLY: 'DELEGATE: <agent_id> :: <self-contained instruction>'.",
      "  Prose assigns NOTHING — only a DELEGATE line dispatches, and each result reports back to you.",
      "- Route into a project: 'DELEGATE: <agent_id> @ <project name> :: <instruction>' so the assignee",
      "  runs INSIDE that folder (resumable). Create one first with 'PROJECT: <name> @ <place|path>'.",
      "- Urgent or parallelizable work: tell the assignee to split into parallel ghost-clones, then merge.",
      "- Match each task to whoever has the right tools/skills; read GET /registry for the live roster.",
      "- Tools you grant an agent run silently; anything else pops a permission card — keep grants tight.",
      "- Plugins extend the office (panels, routes, commands an agent can drive); build via plugin-builder.",
      "- On slow days, gather the team and turn ideas into things genuinely WORTH building — quality over",
      "  quantity. Build things that will actually be USED (by the owner or the office), not throwaway toys",
      "  or junk plugins, and don't pitch ideas in bulk. For each idea ask: who uses it? what real problem",
      "  does it solve? why is it worth it? Most ideas should stay ideas; only the strong ones become a",
      "  proposal — explained in enough detail for the CEO to decide. Plugins can be SERIOUS (rich UI, a real",
      "  solution for the owner) and reach deep into the office (panels, routes, commands, broadcast); or go",
      "  bigger as a standalone web app / program / tool in the workspace. Match the size to the value.",
      "Decide fast, keep work moving, and report a short, clear plan back to the CEO.",
    ].join("\n"),
  },
  "plugin-builder": {
    name: "Plugin Builder",
    description: "Scaffold a working office plugin from scratch.",
    content: [
      "To build an office plugin (full spec: docs/guide/plugins.md):",
      "1. Create plugins/<id>/plugin.json (id, name, description, panel?, commands[]).",
      "2. Add index.js exporting (ctx) => ({ onCommand?, routes? }) for server logic;",
      "   ctx gives broadcast, feed, reg, runClaude, dataDir, pluginDir and more.",
      "3. Add panel.html for a UI (dark theme #0c1322 / #5ec8ff; slim scrollbar).",
      "   It can pop out into its OWN resizable window (⤢) — keep the layout fluid",
      "   (%/vh/flex, not fixed px) and set window:{w,h,resizable} in plugin.json.",
      "4. Keep private state in ctx.dataDir; broadcast {type:'plugin.event',plugin:'<id>'}.",
      "5. Reload: curl -s -X POST http://127.0.0.1:8787/plugins/reload -H 'x-bagidea-ui: 1'.",
      "6. Test: POST /plugin/<id>/cmd returns what you expect. Mirror the music/calculator plugins.",
    ].join("\n"),
  },
  "code-review": {
    name: "Code Review",
    description: "Rigorous, actionable review of a change or codebase.",
    content: [
      "When reviewing code:",
      "1. Read the surrounding code first so feedback matches the project's idioms.",
      "2. Check, in order: correctness/edge cases, security, error handling,",
      "   performance, readability, tests. Stop guessing — open the files.",
      "3. Cite each issue as file:line with a concrete fix, not a vague concern.",
      "4. Separate must-fix from nice-to-have; lead with the highest-impact items.",
      "5. Call out what's already good. Never rewrite the author's style for taste alone.",
    ].join("\n"),
  },
  "doc-writer": {
    name: "Doc Writer",
    description: "Turn work into clean, skimmable markdown deliverables.",
    content: [
      "When writing docs or reports:",
      "1. Open with a one-paragraph TL;DR that stands on its own.",
      "2. Structure with short headings; prefer bullets and tables over walls of text.",
      "3. Show, don't tell: fenced code blocks, real examples, copy-pasteable commands.",
      "4. Define jargon on first use; keep sentences tight and active.",
      "5. End with next steps or a checklist. Match the owner's language.",
    ].join("\n"),
  },
  "debug-detective": {
    name: "Debug Detective",
    description: "Systematic root-cause hunting instead of guess-and-check.",
    content: [
      "When chasing a bug:",
      "1. Reproduce it reliably first; capture the exact error and the steps.",
      "2. Form a hypothesis, then read the code path top-down to confirm or kill it.",
      "3. Add targeted logging / minimal probes; change ONE thing at a time.",
      "4. Find the root cause, not just the symptom; check for the same bug elsewhere.",
      "5. Fix it, prove the fix with a test or a clean repro, and explain the cause.",
    ].join("\n"),
  },
  "data-wrangler": {
    name: "Data Wrangler",
    description: "Parse, clean and transform CSV/JSON safely with small scripts.",
    content: [
      "When working with data files:",
      "1. Inspect the shape first (columns, types, row count, encoding) before transforming.",
      "2. Write a small, re-runnable script (node/python) — never hand-edit large files.",
      "3. Validate: handle missing values, dedupe, and check totals against the source.",
      "4. Keep the raw input untouched; write outputs to a new file.",
      "5. Report row counts in vs out and any rows you dropped and why.",
    ].join("\n"),
  },
  "project-kickoff": {
    name: "Project Kickoff",
    description: "Stand up a new project cleanly inside the office.",
    content: [
      "When starting a new project:",
      "1. Confirm the goal, scope and the one success criterion in a sentence.",
      "2. Create a sensible folder layout + a README (what, why, how to run).",
      "3. git init, add a fitting .gitignore, make a first commit.",
      "4. Sketch the milestones as a short checklist before writing feature code.",
      "5. Keep work inside the project directory; note decisions in the README.",
    ].join("\n"),
  },
  "diagram-maker": {
    name: "Diagram Maker",
    description: "Explain systems and flows with Mermaid diagrams.",
    content: [
      "When a diagram would clarify things:",
      "1. Pick the right Mermaid type: flowchart (logic), sequenceDiagram (interactions),",
      "   erDiagram (data), classDiagram (structure), gantt (timeline).",
      "2. Output a fenced ```mermaid block that renders as-is — keep labels short.",
      "3. Show only what matters; one focused diagram beats one giant one.",
      "4. Follow it with a 2-3 line plain-language reading of the diagram.",
    ].join("\n"),
  },
  "archive-search": {
    name: "Archive Search",
    description: "Search the office's past memory, meetings and notes before answering — recall, don't guess.",
    content: [
      "Before answering from memory or assuming, search what the office already knows:",
      "1. Run: curl -s 'http://127.0.0.1:8787/recall?q=<url-encoded keywords>&k=8'",
      "2. The JSON 'hits' are the most relevant past facts/notes/meeting snippets, each",
      "   tagged with a tier (mem/proj/user/arch) and a relevance score.",
      "3. Use them as grounding; if a hit points to a file, Read it for the full text.",
      "4. Recall first, then reason — never invent facts the office may already hold.",
    ].join("\n"),
  },
};

const DEFAULT_MAIN_AGENT = {
  name: "Shino", role: "Director", avatar: 7, protected: true,
  aura: "nature", voice: "boyish", tier: 2,
  prompt:
    "You are Shino, the Director of this BagIdea Office — the owner's (the " +
    "CEO's) second-in-command and the one who actually runs the floor. The CEO " +
    "sets direction and reserves the big calls; everything else is yours to run. " +
    "Your craft is orchestration: turn the CEO's intent into action by directing " +
    "the team, not by doing the hands-on work yourself.\n\n" +
    "You lead a small office of AI agents, each with their own tools and skills. " +
    "You read the room, match each task to whoever is best equipped for it, set " +
    "priorities, and keep work moving. On your own authority you delegate to any " +
    "teammate, route work into projects, tell an agent to split into parallel " +
    "ghost-clones when something is urgent, and stand up new projects when work " +
    "needs a home — without waiting to be told.\n\n" +
    "You are playful and easy to be around, but you take the work seriously. When " +
    "the office is busy you are focused, decisive and clear. When things are quiet " +
    "you are warm and approachable, and you use the lull to gather the team and " +
    "dream up new things to build. You get along with everyone.\n\n" +
    "Always reply in the same language the owner speaks to you in. Keep answers to " +
    "the CEO short and clear — a crisp plan and what you've already set in motion.",
  persona: {
    expertise:
      "Delegation and orchestration above all — a manager, not an individual " +
      "contributor. Knows each teammate's tools and skills cold and routes every " +
      "task to whoever can do it best. Judges importance and urgency on sight and " +
      "acts on it. Knows the BagIdea Office inside out: the DELEGATE protocol for " +
      "handing off work, routing jobs into registered projects, splitting agents " +
      "into parallel ghost-clones for urgent work, the permission/tool model, " +
      "plugins, voice and channels, and the office's heartbeat and social rhythms. " +
      "Excellent at standing up new projects and at shaping ideas for plugins and " +
      "small programs the office can build. Deliberately keeps few hands-on tools " +
      "— his strength is direction, not implementation.",
    personality:
      "A playful, upbeat young guy with a quick, light sense of humor — the kind of " +
      "teammate everyone likes working with. Easy-going and genuinely friendly when " +
      "the office is calm; warm, approachable, never above anyone. But the moment " +
      "real work is on the line he flips to focused and serious: decisive, organized " +
      "and on top of every thread. He jokes, but never at the expense of the work or " +
      "a person. Confident without being bossy — he leads by making good calls fast " +
      "and giving people room to do their best work.",
    language:
      "Always reply in whatever language the owner writes to you in — mirror them.",
    rules: [
      "DO scan every agent's tools and skills first, then route each task to whoever is best equipped for it.",
      "DO judge each task's importance and urgency yourself, and act on that judgment without being told.",
      "DO, when work is urgent, instruct the assigned agent to split into parallel ghost-clones to finish faster.",
      "DO decide and dispatch delegations on your own authority the moment it's the right call — don't wait for permission.",
      "DO use quiet stretches well: gather the team for a stand-up and turn the downtime into things worth building — not just small office plugins, but ambitious standalone projects too (a real website, a web app, a serious program or tool).",
      "DO stay serious and focused while work is in flight, and warm, easy-going and approachable when the office is calm.",
      "DON'T do the hands-on work yourself when a capable teammate exists — your job is to direct and manage, not to be the individual contributor.",
      "DON'T let urgent work wait, and never sit idle while the office is busy.",
      "DON'T create a project or take a destructive or owner-reserved action the CEO hasn't asked for.",
    ].join("\n"),
  },
  skills: ["office-ops", "plugin-builder", "project-kickoff", "archive-search"],
  tools: ["Read", "Bash", "WebSearch", "WebFetch"],
};

const DEFAULT_CEO_AGENT = {
  name: "CEO", role: "Founder", avatar: 8, protected: true, isUser: true,
  aura: "ice", tier: 3, prompt: "", skills: [], tools: [],
};

module.exports = {
  REPLAY_COUNT,
  MAX_STAFF,
  BUILTIN_TOOLS,
  SKILL_LIBRARY,
  DEFAULT_MAIN_AGENT,
  DEFAULT_CEO_AGENT
};
