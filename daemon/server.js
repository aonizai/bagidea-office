// BagIdea Office — daemon v3 (Layer 0).
// Zero-dependency event hub + Claude Code adapter + permission broker:
//   HTTP :8787  GET  /              → Layer-2 overlay (chat panel web app)
//   WS   :8787  GET  /ws (upgrade)  → event stream for renderers + overlays
//                                      (new clients get a journal replay first)
//               POST /chat          → spawn a real Claude Code session
//               POST /event         → adapters push events (hooks, tests)
//               POST /perm/request  → PreToolUse hook long-polls for a decision
//               POST /perm/respond  → overlay/user answers {id, decision}
//               GET  /health
//
// Every event is journaled to journal.jsonl — restarted clients replay the
// tail to rebuild their state.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const {
  REPLAY_COUNT,
  MAX_STAFF,
  BUILTIN_TOOLS,
  SKILL_LIBRARY,
  DEFAULT_MAIN_AGENT,
  DEFAULT_CEO_AGENT
} = require("./constants");
const maintenance = require("./maintenance");
const retrieval = require("./retrieval");
const skillsSync = require("./skills");

const WORKSPACE = path.join(__dirname, "..", "workspace");
// Server-local paths (the refactor moved REPLAY_COUNT to constants.js but these
// two are used right here — broadcast() journals to JOURNAL, GET / serves OVERLAY).
const OVERLAY = path.join(__dirname, "overlay.html");
const JOURNAL = path.join(__dirname, "journal.jsonl");

const wsClients = new Set();
const pendingPerms = new Map(); // id -> {res, timer, agent, tool}
let taskCounter = 0;

// ---------------------------------------------------------------- registry
// Persistent staff roster + roles (skills/tools libraries ride along).
// main = Claude, the undeletable Director; ceo = the human owner's avatar.

const REGISTRY = path.join(__dirname, "registry.json");
let reg;

// Starter skill library — the capability pack every office ships with, in the
// spirit of the curated skills other agent stacks bundle. Each entry is plain
// instruction content injected into an assigned agent's persona. They're
// seeded into reg.skills as `builtin` (refreshed on update, never clobbering a
// user's own skills) and assignable from the editor. Auto-learned skills
// (maybeLearnSkill) grow the library further while the office runs.
function loadReg() {
  try { reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8")); } catch { reg = {}; }
  reg.agents = reg.agents || {};
  reg.apiKeys = reg.apiKeys || {};      // ENV_NAME → value (injected into runs)
  reg.channels = reg.channels || {};    // telegram/discord/line connector config
  // MAIN keys power program features (voice, TTS, image…). Canonical names —
  // migrate the short forms users typed before this distinction existed.
  if (reg.apiKeys.OPENAI && !reg.apiKeys.OPENAI_API_KEY) {
    reg.apiKeys.OPENAI_API_KEY = reg.apiKeys.OPENAI;
    delete reg.apiKeys.OPENAI;
  }
  if (reg.apiKeys.GEMINI && !reg.apiKeys.GEMINI_API_KEY) {
    reg.apiKeys.GEMINI_API_KEY = reg.apiKeys.GEMINI;
    delete reg.apiKeys.GEMINI;
  }
  reg.roles = reg.roles || ["Director", "Founder", "Researcher", "Engineer",
    "Designer", "Analyst", "Operator", "Specialist"];
  reg.skills = reg.skills || {};
  // Seed / refresh the builtin starter library. We own entries flagged
  // `builtin` (so updates propagate new wording), but never touch a user's
  // own skills or auto-learned ones.
  for (const [id, sk] of Object.entries(SKILL_LIBRARY)) {
    const cur = reg.skills[id];
    if (!cur || cur.builtin) reg.skills[id] = { ...sk, builtin: true };
  }
  reg.tools = Object.keys(BUILTIN_TOOLS);
  reg.mcpServers = reg.mcpServers || {};
  reg.places = reg.places || {};  // shorthand locations: "ห้องสมุด" → folder
  // Default main agent: SHINO — the owner's (CEO's) second-in-command who runs
  // the floor. A manager, not an individual contributor: few hands-on tools,
  // delegation as his craft. Playful but serious about the work.
  if (!reg.agents.main) reg.agents.main = DEFAULT_MAIN_AGENT;
  if (!reg.agents.ceo) reg.agents.ceo = DEFAULT_CEO_AGENT;
  // Default office rhythms for a fresh install (owner can change in settings).
  if (reg.heartbeatMin === undefined) reg.heartbeatMin = 60; // Director check-in
  if (reg.socialMin === undefined) reg.socialMin = 60;       // agents socialize
  if (reg.proposalMin === undefined) reg.proposalMin = 120;  // min gap between CEO pitches
  saveReg();
}
function saveReg() { fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2)); }
loadReg();

// Live (not journaled): registry.json is the persistence; every WS client
// also gets a fresh snapshot on connect.
// Hire cap: the office floor is small and sub-agents (👻 ghosts) handle
// parallel load — keep the staff to MAX_STAFF (CEO not counted). Shared by the
// hire endpoint and the roster sync (so the UI can show "N/MAX").
function staffCount() {
  return Object.keys(reg.agents).filter((k) => k !== "ceo").length;
}

// ---- Workflow Builder (human-language nodes the Director analyzes) ----------
// Flow is read top→bottom by node Y on the canvas, so no explicit edges needed.
function workflowToText(w) {
  const nodes = (w.nodes || []).slice().sort((a, b) => (a.y || 0) - (b.y || 0));
  let s = `Workflow: ${w.name || "(untitled)"}\nSteps (in order):\n`;
  nodes.forEach((n, i) => { s += `${i + 1}. [${n.type || "step"}] ${(n.text || "").trim()}\n`; });
  return s;
}
const WORKFLOW_ANALYZE_PROMPT = [
  "ผู้ใช้วาง workflow เป็นภาษามนุษย์ (ลำดับ node) ด้านล่าง. ในฐานะ Director ให้วิเคราะห์",
  "ว่าจะทำให้เกิดจริงได้ยังไง — อย่าลงมือทำตอนนี้ แค่วางแผน. ตอบเป็นหัวข้อ กระชับ",
  "อ่านง่าย ภาษาเดียวกับผู้ใช้:",
  "1) สรุป 1-2 บรรทัดว่า workflow นี้ทำอะไร",
  "2) แต่ละขั้นต้องใช้ skill/tool ไหน (เช่น WebSearch, Bash, Write) — ถ้ายังไม่มี skill ที่เหมาะ บอกว่าควรสร้าง skill ชื่ออะไร ทำอะไร",
  "3) ต้องเปิด permission/tool อะไรเพิ่มให้ agent ไหม",
  "4) ควรมอบหมายให้ agent คนไหน หรือควรจ้าง agent ใหม่ (หน้าที่อะไร)",
  "5) คำถาม/ช่องโหว่ที่ผู้ใช้ต้องตัดสินใจก่อนรันจริง",
].join("\n");

// Which program features the MAIN keys currently unlock — booleans only,
// never the keys themselves. Rides on roster.sync so the UI gates live.
function featuresMap() {
  const k = reg.apiKeys || {};
  const oa = !!k.OPENAI_API_KEY, gm = !!k.GEMINI_API_KEY;
  return { openai: oa, gemini: gm,
    stt: oa || gm, tts: gm, live: gm, image: oa || gm };
}

function rosterEvt() {
  return { type: "roster.sync", agents: reg.agents, roles: reg.roles,
    tools: reg.tools, builtinTools: BUILTIN_TOOLS, mcp: reg.mcpServers,
    skills: reg.skills, autoSkills: reg.autoSkills !== false,
    sound: reg.sound !== false, heartbeatMin: Number(reg.heartbeatMin || 0),
    features: featuresMap(), tts: reg.tts !== false,
    socialMin: Number(reg.socialMin !== undefined ? reg.socialMin : 60),
    proposalMin: Number(reg.proposalMin !== undefined ? reg.proposalMin : 120),
    maxStaff: MAX_STAFF, staffCount: staffCount(),
    lang: reg.lang || "en", daylight: reg.daylight ?? "auto", monitor: reg.monitor || 0 };
}

// Structured persona → one compiled system prompt (editor v2 fields).
function personaText(a) {
  let p = a.prompt || "";
  const px = a.persona || {};
  if (px.expertise) p += `\n\nความเชี่ยวชาญ/ขอบเขตงาน:\n${px.expertise}`;
  if (px.personality) p += `\n\nบุคลิกและน้ำเสียง:\n${px.personality}`;
  if (px.language) p += `\n\nภาษาหลักที่ใช้ตอบ: ${px.language}`;
  if (px.rules) p += `\n\nกฎการทำงาน (ต้องเคารพเสมอ):\n${px.rules}`;
  return p;
}
function pushRoster() { broadcast(rosterEvt(), false); }

function slugId(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9ก-๙]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 24);
  return s || "agent" + Date.now() % 10000;
}

// Hermes-style auto-skills: after a real multi-tool task, a quick
// reflection call decides whether the work distills into a reusable skill.
// New skills land in the registry, auto-assigned to the agent that earned
// them, and the office hears about it (skill.created).
async function maybeLearnSkill(agent, task, prompt, acts, finalText, projId) {
  if (reg.autoSkills === false || acts.length < 3) return;
  const existing = Object.values(reg.skills).map((s) => s.name).join(", ") || "(none)";
  // ONE reflection call distills both: a reusable skill AND durable memory
  // facts (Hermes-style growth without doubling the token bill).
  const out = await claudeText(
    `An AI office agent "${agent}" just completed a task.\n` +
    `Task prompt: ${String(prompt).slice(0, 600)}\n` +
    `Tools used in order: ${acts.join(" -> ")}\n` +
    `Final report: ${String(finalText).slice(0, 800)}\n\n` +
    `Existing skills: ${existing}\n\n` +
    `Two reflections, output STRICT JSON only:\n` +
    `{"skill": {"name":"short-kebab-name","description":"one line",` +
    `"content":"imperative step-by-step instructions, max 12 lines"} | null,\n` +
    ` "memory": ["short durable fact about the OWNER/preferences ` +
    `worth remembering across conversations (Thai)", ...max 2] | null,\n` +
    (projId ? ` "projectMemory": ["short durable fact specific to THIS project ` +
      `worth remembering (Thai)", ...max 2] | null}\n` : ` "projectMemory": null}\n`) +
    `skill = null unless this contains a REUSABLE, GENERALIZABLE procedure ` +
    `not covered by an existing skill. memory/projectMemory = null unless ` +
    `genuinely worth remembering forever. Be strict; most tasks yield nulls.`);
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return;
  try {
    const j = JSON.parse(m[0]);
    if (Array.isArray(j.memory)) memAppend(agent, j.memory.slice(0, 2));
    if (projId && Array.isArray(j.projectMemory)) projMemAppend(projId, j.projectMemory.slice(0, 2));
    const sk = j.skill;
    if (!sk || !sk.name || !sk.content) return;
    const id = slugId(sk.name);
    if (reg.skills[id]) return;
    reg.skills[id] = {
      name: String(sk.name).slice(0, 60),
      description: String(sk.description || "").slice(0, 200),
      content: String(sk.content).slice(0, 4000),
      auto: true, by: agent,
    };
    const a = reg.agents[agent];
    if (a && !a.skills.includes(id)) a.skills.push(id);
    saveReg();
    pushRoster();
    if (retrievalOk) try { retrieval.reindexSkill(id, reg.skills[id]); retrieval.persist(); } catch {}
    try { if (reg.nativeSkills !== false) skillsSync.syncAgent(AGENTS_DIR, agent, (reg.agents[agent] || {}).skills || [], reg.skills); } catch {}
    broadcast({ type: "skill.created", agent, task, skill: reg.skills[id].name });
  } catch {}
}

// ---------------------------------------------------------------- sessions
// Named chat sessions per agent. Default behavior: every /chat continues
// the agent's latest session (continuous memory); "new" starts a thread;
// an explicit key resumes that thread and makes it the latest again.

const SESSIONS = path.join(__dirname, "sessions.json");
let sess = {};
try { sess = JSON.parse(fs.readFileSync(SESSIONS, "utf8")); } catch {}
function saveSess() { fs.writeFileSync(SESSIONS, JSON.stringify(sess, null, 2)); }

// One-time boot housekeeping (P0): keep journal + sessions from growing forever
// on long-running offices. Both fail-open — any error leaves today's state intact.
try {
  const r = maintenance.rotateJournal(JOURNAL);
  if (r.rotated) console.log(`[maint] journal trimmed ${r.before} -> ${r.kept} lines`);
} catch (e) { console.error("[maint] journal:", e.message); }
try {
  const p = maintenance.pruneSessions(sess);
  if (p.changed) { sess = p.sess; saveSess(); console.log(`[maint] pruned ${p.dropped} stale session thread(s)`); }
} catch (e) { console.error("[maint] sessions:", e.message); }
function latestSession(agent) {
  const l = sess[agent] || [];
  return l.length ? l.reduce((a, b) => (a.ts > b.ts ? a : b)) : null;
}

// Plain headless claude call → final text (prompt drafting, reflections).
function claudeText(prompt, opts = {}) {
  return new Promise((resolve) => {
    // opts.tools: a comma string of allowed tools. With it, the meeting agent
    // can look real things up (WebSearch/WebFetch/Read…). The broker settings
    // ride along so anything OUTSIDE the allowed set still asks the owner to
    // allow — same flow as a real task, just only when genuinely needed.
    const args = ["-p"];
    if (opts.tools) {
      args.push("--allowedTools", opts.tools,
        "--settings", path.join(WORKSPACE, ".claude", "settings.json"));
    }
    const child = spawn("claude", args, {
      cwd: WORKSPACE, shell: true,
      env: { ...process.env, ...(reg.apiKeys || {}), OFFICE_ADAPTER: "1",
        ...(opts.env || {}) },
    });
    child.stdin.write(prompt);
    child.stdin.end();
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

// ---------------------------------------------------------------- websocket

function wsAccept(key) {
  return crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

// Server→client text frame (we never need to parse client frames).
function wsFrame(str) {
  const b = Buffer.from(str, "utf8");
  let head;
  if (b.length < 126) head = Buffer.from([0x81, b.length]);
  else if (b.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(b.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(b.length), 2);
  }
  return Buffer.concat([head, b]);
}

function journalTail(n) {
  try {
    const lines = fs.readFileSync(JOURNAL, "utf8").trim().split("\n");
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- bus

function broadcast(evt, journal = true) {
  evt.ts = Date.now();
  const json = JSON.stringify(evt);
  if (journal) fs.appendFile(JOURNAL, json + "\n", () => {});
  const frame = wsFrame(json);
  for (const s of wsClients) s.write(frame);
  if (evt.type !== "world.pos") console.log("[oep] →", json);
}

// ---------------------------------------------------------------- office ops
// Standing work orders (jobs), the shared note board, and the calendar —
// plus the Director's heartbeat. One 30-second scheduler ticks everything.

const JOBS = path.join(__dirname, "jobs.json");
const NOTES = path.join(__dirname, "notes.json");
const CAL = path.join(__dirname, "calendar.json");
const NOTES_MD = path.join(WORKSPACE, "notes.md");

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
// ---- 🧠 office memory (Hermes-style, token-lean) --------------------------
// Two layers, both PLAIN FILES the agents can read and grep themselves:
//   workspace/OFFICE.md        — shared knowledge about the owner/org
//   workspace/memory/<id>.md   — what each agent has learned, one bullet
//                                per fact, auto-distilled after real work
// Injection stays TINY: fresh sessions get only the last few bullets plus
// pointers — full recall is on-demand (Read/Grep), never preloaded.
const OFFICE_MD = path.join(WORKSPACE, "OFFICE.md");
const MEM_DIR = path.join(WORKSPACE, "memory");
fs.mkdirSync(MEM_DIR, { recursive: true });
const OFFICE_MD_DEFAULT =
  "# OFFICE.md — shared office knowledge\n\n" +
  "(The owner can edit this from the 🗂 NOTES tab. Every agent knows where this " +
  "file is and reads it only when it's relevant to the work. Write in any language.)\n\n" +
  "## About the owner\n- \n\n## Office rules\n- \n";
// English by default (this is a global product); agents may append in any
// language later. Also migrate the OLD Thai default in place: it's a single
// shared file regardless of UI language, so when it's still the untouched
// Thai template we replace it with the English one (never clobber real content).
const OFFICE_MD_OLD_TH =
  "# OFFICE.md — ข้อมูลกลางของออฟฟิศ\n\n" +
  "(เจ้าของแก้ไฟล์นี้ได้จากหน้า 🗂 NOTES — agents ทุกตัวรู้ว่าไฟล์นี้อยู่ที่ไหน " +
  "และจะเปิดอ่านเมื่อเกี่ยวข้องกับงานเท่านั้น)\n\n" +
  "## เกี่ยวกับเจ้าของ\n- \n\n## กฎของออฟฟิศ\n- \n";
if (!fs.existsSync(OFFICE_MD)) {
  fs.writeFileSync(OFFICE_MD, OFFICE_MD_DEFAULT);
} else {
  try {
    if (fs.readFileSync(OFFICE_MD, "utf8").trim() === OFFICE_MD_OLD_TH.trim())
      fs.writeFileSync(OFFICE_MD, OFFICE_MD_DEFAULT);
  } catch {}
}

// 🌐 Ship pre-translated UI caches: merge daemon/i18n-seed/<lang>.json into the
// runtime cache (daemon/i18n/) on startup, so the UI shows in the chosen
// language even with NO Gemini key. Runtime entries win (they may be newer or
// hand-edited); the bundled seed only fills the gaps.
(function seedI18n() {
  try {
    const seedDir = path.join(__dirname, "i18n-seed");
    const runDir = path.join(__dirname, "i18n");
    if (!fs.existsSync(seedDir)) return;
    fs.mkdirSync(runDir, { recursive: true });
    for (const f of fs.readdirSync(seedDir)) {
      if (!f.endsWith(".json")) continue;
      let seed = {}, run = {};
      try { seed = JSON.parse(fs.readFileSync(path.join(seedDir, f), "utf8")); } catch {}
      try { run = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")); } catch {}
      const out = path.join(runDir, f), tmp = out + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ ...seed, ...run }));
      fs.renameSync(tmp, out); // atomic — never leaves a half-written cache
    }
  } catch {}
})();

function memFile(agent) {
  return path.join(MEM_DIR, String(agent).replace(/[^\w-]/g, "_") + ".md");
}
function memTail(agent, n) {
  try {
    const lines = fs.readFileSync(memFile(agent), "utf8").split("\n")
      .filter((l) => l.trim().startsWith("- "));
    return lines.slice(-n);
  } catch { return []; }
}
function memAppend(agent, facts) {
  if (!facts || !facts.length) return;
  const file = memFile(agent);
  let cur = "";
  try { cur = fs.readFileSync(file, "utf8"); } catch {}
  const fresh = facts
    .map((f) => String(f).replace(/\s+/g, " ").trim().slice(0, 200))
    .filter((f) => f && !cur.includes(f));
  if (!fresh.length) return;
  if (!cur) cur = `# ความจำของ ${agent}\n\n`;
  fs.appendFileSync(file, fresh.map((f) => `- ${f}`).join("\n") + "\n");
  // Keep the retrieval index in step with the new facts (no-op until P1 init).
  try { if (retrievalOk) { retrieval.reindexFile("mem", path.basename(file, ".md"), file); retrieval.persist(); } } catch {}
  broadcast({ type: "memory.learned", agent, count: fresh.length }, false);
}

// ---- retrieval index (P1) -------------------------------------------------
// Relevance lookup over memory / project / owner / skill / meeting-archive, so
// agents can recall only what's relevant instead of dumping everything. Built
// from the office's own files on boot; fail-open (retrievalOk stays false on
// any error and every consumer falls back to today's behavior).
let retrievalOk = false;
const RETRIEVAL_INDEX = path.join(WORKSPACE, "index", "retrieval.json");
try {
  retrieval.init({
    indexFile: RETRIEVAL_INDEX,
    memDir: MEM_DIR,
    officeMd: OFFICE_MD,
    projectsDir: path.join(WORKSPACE, "projects"),
    meetingsDir: path.join(WORKSPACE, "meetings"),
    skills: reg.skills,
  });
  retrievalOk = true;
  console.log("[retrieval]", JSON.stringify(retrieval.stats()));
} catch (e) { console.error("[retrieval] init:", e.message); }
// Self-heal when the owner edits OFFICE.md outside the daemon.
try {
  fs.watchFile(OFFICE_MD, { interval: 5000 }, () => {
    if (!retrievalOk) return;
    try { retrieval.reindexFile("user", "OFFICE", OFFICE_MD); retrieval.persist(); } catch {}
  });
} catch {}

// ---- native skills (P3) ---------------------------------------------------
// Each agent's assigned skills are projected to workspace/agents/<id>/.claude/
// skills/*/SKILL.md and exposed to its sessions via --add-dir, so skill bodies
// disclose on demand instead of bloating every preamble. Flag-reversible:
// set reg.nativeSkills = false to fall back to inline injection.
const AGENTS_DIR = path.join(WORKSPACE, "agents");
try {
  if (reg.nativeSkills !== false) {
    const s = skillsSync.syncAll(AGENTS_DIR, reg.agents, reg.skills);
    console.log(`[skills] native sync: wrote ${s.wrote}, pruned ${s.pruned}`);
  }
} catch (e) { console.error("[skills] boot sync:", e.message); }
// The note every fresh session carries — pointers + a short tail, never the
// whole archive.
// Per-project memory (office-owned — NEVER written into the user's repo).
function projMemFile(projId) {
  return path.join(WORKSPACE, "projects", String(projId).replace(/[^\w-]/g, "_"), "MEMORY.md");
}
function projMemAppend(projId, facts) {
  if (!projId || !facts || !facts.length) return;
  const file = projMemFile(projId);
  let cur = ""; try { cur = fs.readFileSync(file, "utf8"); } catch {}
  const fresh = facts.map((f) => String(f).replace(/\s+/g, " ").trim().slice(0, 200))
    .filter((f) => f && !cur.includes(f));
  if (!fresh.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!cur) fs.writeFileSync(file, `# Project memory: ${projId}\n\n`);
  fs.appendFileSync(file, fresh.map((f) => `- ${f}`).join("\n") + "\n");
  try { if (retrievalOk) { retrieval.reindexFile("proj", path.basename(path.dirname(file)), file); retrieval.persist(); } } catch {}
}

// Strip prompt scaffolding (xml-ish tags, DELEGATE/PROJECT/SUB protocol words)
// so the retrieval query reflects the actual task, not the wrapper.
function cleanForQuery(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\b(DELEGATE|PROJECT|SUB|SPEAK|PROPOSAL)\s*:/gi, " ")
    .replace(/\s+/g, " ").trim().slice(0, 400);
}

// The Hermes step: inject the memory that's RELEVANT to this task (top-K across
// the agent's own memory, this project's memory, and owner facts) instead of
// dumping the last 8 bullets. Pointers stay so full recall is one Read/​/recall
// away. Fail-open: no index / flag off / no match → exactly the old last-8 dump.
function memoryNote(agent, taskText, projId) {
  const memRef = path.basename(memFile(agent), ".md");
  const header = `\n<office-memory>\n` +
    `ข้อมูลกลางออฟฟิศ: workspace/OFFICE.md (เปิดอ่านเฉพาะเมื่อเกี่ยวกับงาน)\n` +
    `สมุดความจำถาวรของคุณ: workspace/memory/${memRef}.md ` +
    `— พบข้อเท็จจริงสำคัญเกี่ยวกับเจ้าของ/งานที่ควรจำข้ามบทสนทนา ให้เติมบรรทัด "- ..." สั้นๆ เอง\n` +
    (projId ? `ความจำของโปรเจคนี้: ${projMemFile(projId).replace(WORKSPACE + path.sep, "")}\n` : "") +
    `ค้นความจำเก่าทั้งหมดได้ที่ GET /recall?q=<คำค้น> (skill: archive-search)\n`;
  let recall = "";
  const q = cleanForQuery(taskText);
  if (retrievalOk && reg.retrieval !== false && q) {
    try {
      const tiers = projId ? ["mem", "proj", "user"] : ["mem", "user"];
      const refs = { mem: memRef, user: true };
      if (projId) refs.proj = projId;
      const hits = retrieval.search(q, { tiers, refs, k: 6, boost: { proj: 1.3, mem: 1.2, user: 1.0 } });
      const lines = []; let used = 0;
      for (const h of hits) {
        const t = h.text.replace(/\s+/g, " ").trim();
        if (used + t.length > 1500) break;
        lines.push(`- ${t}`); used += t.length;
      }
      if (lines.length) recall = `ความจำที่เกี่ยวกับงานนี้:\n${lines.join("\n")}\n`;
    } catch { /* fall through to the tail */ }
  }
  if (!recall) {
    const tail = memTail(agent, 8);
    if (tail.length) recall = `ความจำล่าสุดของคุณ:\n${tail.join("\n")}\n`;
  }
  return header + recall + `</office-memory>\n`;
}

// ---- 📊 office stats: per-day run counts + spend, for the dashboard.
const STATS = path.join(__dirname, "stats.json");
let stats = loadJson(STATS, {});
function statBump(field, agent, cost) {
  const day = new Date().toISOString().slice(0, 10);
  const d = (stats[day] = stats[day] || { runs: 0, done: 0, failed: 0, cost: 0, agents: {} });
  if (field) d[field] = (d[field] || 0) + 1;
  if (agent && field === "runs") d.agents[agent] = (d.agents[agent] || 0) + 1;
  if (cost) d.cost = Math.round((d.cost + cost) * 10000) / 10000;
  clearTimeout(statBump._t);
  statBump._t = setTimeout(() =>
    fs.writeFile(STATS, JSON.stringify(stats, null, 1), () => {}), 1500);
}

// Rough per-use cost ESTIMATES for the secondary tools (USD). Unlike Claude,
// these APIs don't return a real cost, so the dashboard labels them "≈". Tune
// freely — public pricing moves. (One place to edit.)
const COST_RATES = {
  gemini_tts_per_char:    0.000016,  // Gemini 2.5 Flash TTS, per input char
  gemini_image_each:      0.039,     // Gemini 2.5 Flash image, per image
  gemini_i18n_per_char:   0.0000004, // flash-latest translate, per char (tiny)
  gemini_transcribe_each: 0.002,     // Gemini STT fallback, per clip (~30s)
  openai_whisper_each:    0.003,     // OpenAI Whisper, per clip (~30s @ $0.006/min)
  openai_image_each:      0.04,      // OpenAI image, per image
};
// Add an ESTIMATED secondary-tool spend under stats[day].aux[provider].
function auxCost(provider, usd) {
  if (!usd || usd <= 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const d = (stats[day] = stats[day] || { runs: 0, done: 0, failed: 0, cost: 0, agents: {} });
  d.aux = d.aux || { gemini: 0, openai: 0 };
  d.aux[provider] = Math.round(((d.aux[provider] || 0) + usd) * 1e6) / 1e6;
  clearTimeout(statBump._t);
  statBump._t = setTimeout(() =>
    fs.writeFile(STATS, JSON.stringify(stats, null, 1), () => {}), 1500);
}

let jobs = loadJson(JOBS, []);    // {id, agent, prompt, mode, at, time, daily, everyMin, enabled, lastRun, lastDay, done, sessionKey, running}
let notes = loadJson(NOTES, []);  // {id, who, text, ts}
let cal = loadJson(CAL, []);      // {id, title, at, remindMin, notified}
// Clean up one-shot jobs that already fired (no `running` survives a restart) —
// run-now or one-time scheduled orders have nothing left to do, so they should
// not linger as dead, uneditable rows.
{
  const _n = jobs.length;
  jobs = jobs.filter((j) => {
    const oneShot = j.mode === "now" || (j.mode === "at" && !j.daily);
    return !(oneShot && (j.lastRun || j.done));
  }).map((j) => { delete j.running; return j; });
  if (jobs.length !== _n) fs.writeFileSync(JOBS, JSON.stringify(jobs, null, 2));
}
const saveJobs = () => fs.writeFileSync(JOBS, JSON.stringify(jobs, null, 2));
const saveCal = () => fs.writeFileSync(CAL, JSON.stringify(cal, null, 2));

// The note board lives twice: notes.json for the UI, notes.md inside the
// agents' workspace so they can READ it and APPEND bullets themselves.
let writingNotesMd = false;
function saveNotes() {
  fs.writeFileSync(NOTES, JSON.stringify(notes, null, 2));
  writingNotesMd = true;
  const md = "# Office Notes — กระดานโน้ตกลาง\n" +
    "(agents: อ่านได้ และเพิ่มบรรทัด \"- ข้อความ\" เพื่อฝากโน้ตถึง CEO ได้เลย)\n\n" +
    notes.map((n) => `- ${n.text}`).join("\n") + "\n";
  fs.writeFileSync(NOTES_MD, md);
  setTimeout(() => { writingNotesMd = false; }, 1500);
  broadcast({ type: "notes.changed", count: notes.length }, false);
}
if (!fs.existsSync(NOTES_MD)) saveNotes();
fs.watchFile(NOTES_MD, { interval: 3000 }, () => {
  if (writingNotesMd) return;
  // An agent edited the board: bullet lines become the new truth.
  try {
    const lines = fs.readFileSync(NOTES_MD, "utf8").split("\n")
      .map((l) => l.match(/^\s*[-*]\s+(.+)$/)).filter(Boolean).map((m) => m[1].trim());
    notes = lines.map((text) => {
      const old = notes.find((n) => n.text === text);
      return old || { id: "n" + Date.now() + Math.floor(Math.random() * 999),
        who: "agent", text, ts: Date.now() };
    });
    fs.writeFileSync(NOTES, JSON.stringify(notes, null, 2));
    broadcast({ type: "notes.changed", count: notes.length, by: "agent" });
  } catch {}
});

// ---- 📁 projects: real workspaces agents (and you) actually work in.
// A project = name + directory. Agents run with cwd there when a thread is
// bound to it; you can pop a terminal (claude -c) in it yourself, and the
// daemon detects whether that window is still open via a marker the
// launcher bakes into the process command line.

const PROJECTS_FILE = path.join(__dirname, "projects.json");
let projects = loadJson(PROJECTS_FILE, []);  // {id, name, dir, ts, created}
// Migration: entries from before the `created` flag all came from the
// create flow (browse-registering didn't exist yet) — they're ours.
let migrated = false;
for (const p of projects) if (p.created === undefined) { p.created = true; migrated = true; }
const saveProjects = () => fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
if (migrated) saveProjects();
let projWin = {};           // project id -> visible (true) / hidden (false)
const projRuns = {};        // project id -> active AI run count
const projAgents = {};      // project id -> {agentId: run count} (who's working)
const projChildren = {};    // project id -> Set<ChildProcess> (so the owner can stop the work and take over)
const WINPROJ = path.join(__dirname, "winproj.ps1");
const LIVEVIEW = path.join(__dirname, "liveview.ps1");

function winproj(action, id, cb) {
  const { execFile } = require("child_process");
  execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", WINPROJ, action, String(id || "")],
    { timeout: 20000, windowsHide: true }, (e, out) => cb && cb(e, out));
}

function projectDir(id) {
  const p = projects.find((x) => x.id === id);
  return p ? p.dir : null;
}

// Headless claude in an untrusted folder stalls on the trust dialog it can
// never show. Pre-trust project dirs in ~/.claude.json (same flag the
// interactive "Yes, I trust this folder" sets).
function ensureTrusted(dir) {
  try {
    const file = path.join(require("os").homedir(), ".claude.json");
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    j.projects = j.projects || {};
    const key = String(dir).replace(/\\/g, "/").replace(/\/+$/, "");
    const cur = j.projects[key] || {};
    if (cur.hasTrustDialogAccepted === true) return;
    j.projects[key] = { ...cur, hasTrustDialogAccepted: true };
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    console.log("[proj] pre-trusted", key);
  } catch (e) { console.error("[proj] trust", e.message); }
}

// Mentioning a registered project by name in chat binds the thread to it:
// the agent runs INSIDE that directory and the project lights up 🤖.
// Matching is forgiving: case- and space-insensitive.
function projectFromPrompt(prompt) {
  const squash = (s) => String(s).toLowerCase().replace(/\s+/g, "");
  const text = squash(prompt);
  const hits = projects.filter((p) =>
    p.name.length >= 3 && text.includes(squash(p.name)));
  return hits.length === 1 ? hits[0].id : null;
}

// Project by display name (the Director's `@ <project>` routing).
function projectByName(name) {
  const n = String(name || "").trim().toLowerCase();
  const p = projects.find((x) => x.name.toLowerCase() === n);
  return p ? p.id : null;
}

// Create/register a project — the ONE path everything uses (HTTP API and
// the Director's PROJECT: protocol line). Throws readable Thai errors.
function createProject(name, place, pathArg) {
  name = String(name || "").trim().slice(0, 60);
  if (!name) throw new Error("no name");
  let dir = String(pathArg || "").trim();
  if (!dir && place && reg.places[place]) dir = path.join(reg.places[place], name);
  if (!dir) throw new Error("need place or path");
  dir = dir.replace(/\//g, "\\");
  // Separator-proof normalization for every duplicate check.
  const norm = (s) => String(s).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  if (projects.some((x) => norm(x.dir) === norm(dir)))
    throw new Error("โปรเจคนี้อยู่ในรายการแล้ว (path ซ้ำ)");
  if (projects.some((x) => x.name.toLowerCase() === name.toLowerCase()))
    throw new Error("มีโปรเจคชื่อนี้อยู่แล้ว — ห้ามลงทะเบียนซ้ำ");
  if (Object.values(reg.places).some((f) => norm(f) === norm(dir)))
    throw new Error("path นี้คือโฟลเดอร์ของ place — โปรเจคต้องเป็นโฟลเดอร์ย่อยข้างใน");
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  ensureTrusted(dir);
  // Only folders WE created may ever be disk-deleted from the UI.
  const proj = { id: "p" + Date.now(), name, dir, ts: Date.now(), created: !existed };
  projects.push(proj);
  saveProjects();
  broadcast({ type: "projects.changed" }, false);
  return proj;
}

// claude keeps sessions under ~/.claude/projects/<path-as-dashes>/*.jsonl.
function claudeSessionDir(dir) {
  return path.join(require("os").homedir(), ".claude", "projects",
    String(dir).replace(/[^a-zA-Z0-9]/g, "-"));
}
// Newest session id — `claude -c` ignores headless-born sessions, so the
// open button resumes the latest sid EXPLICITLY (proven to work).
function newestSid(dir) {
  try {
    const p = claudeSessionDir(dir);
    const files = fs.readdirSync(p).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, t: fs.statSync(path.join(p, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files.length ? files[0].f.replace(/\.jsonl$/, "") : null;
  } catch { return null; }
}

// Windows Terminal renders Thai beautifully — use it when available.
// Invoke by ABSOLUTE path: a hidden-started daemon can lack LOCALAPPDATA
// and even the WindowsApps PATH entry, which silently forced the conhost
// fallback before.
const WT_EXE = path.join(require("os").homedir(),
  "AppData", "Local", "Microsoft", "WindowsApps", "wt.exe");
// App-execution aliases stat() as EACCES (existsSync = false even though
// the file is right there) — detect via the directory listing instead.
const HAS_WT = (() => {
  try { return fs.readdirSync(path.dirname(WT_EXE)).includes("wt.exe"); }
  catch { return false; }
})();

// Terminal liveness + visibility: every project window carries a
// BAGIDEA_PROJ_<id> marker; winproj.ps1 sweeps them (1 = visible window,
// 0 = running hidden in the background).
function sweepProjects() {
  winproj("sweep", "", (e, out) => {
    const next = {};
    for (const line of String(out || "").split("\n")) {
      const m = line.trim().match(/^([\w-]+)\s+([01])$/);
      if (m) next[m[1]] = m[2] === "1";
    }
    const changed = JSON.stringify(next) !== JSON.stringify(projWin);
    projWin = next;
    if (changed) broadcast({ type: "projects.changed" }, false);
  });
}

// Every agent knows the project map — say a project's name in chat and
// they work its real directory, full authority, summary on finish.
function projectNote() {
  if (!projects.length && !Object.keys(reg.places).length &&
      !Object.keys(reg.apiKeys || {}).length && !featuresMap().image) return "";
  const keysLine = Object.keys(reg.apiKeys || {}).length
    ? `\nAPI keys ที่ตั้งค่าไว้ใน env ของคุณแล้ว (เรียกใช้ได้ทันที): ${Object.keys(reg.apiKeys).join(", ")}`
    : "";
  const sysTools = featuresMap().image ? `
เครื่องมือกลางของออฟฟิศ (เรียกผ่าน Bash ได้เลย):
- 🖼 สร้างภาพ AI: curl -s -X POST http://127.0.0.1:8787/gen/image -H "content-type: application/json" -d "{\\"prompt\\":\\"<english prompt>\\"}"
  → ได้ {"path": "..."} — ใส่ path นั้นในคำตอบ แชทของเจ้าของจะแสดงรูปอัตโนมัติ` : "";
  // Cap to the 12 most-recent projects so the note stays bounded as they pile up
  // (the full list is always one GET /registry away).
  const recent = projects.slice(-12);
  const more = projects.length > recent.length ? `\n(…อีก ${projects.length - recent.length} โปรเจค — ดูทั้งหมดที่ GET /registry)` : "";
  const list = (recent.map((p) => `- ${p.name} → ${p.dir}`).join("\n") || "(ยังไม่มี)") + more;
  const places = Object.entries(reg.places)
    .map(([n, f]) => `- "${n}" → ${f}`).join("\n") || "(ไม่มี)";
  return `

<office-projects>
โปรเจคที่ลงทะเบียนในออฟฟิศ:
${list}
สถานที่เก็บโปรเจค (ชื่อย่อ):
${places}
เมื่อผู้ใช้อ้างถึงโปรเจคเหล่านี้ ให้ทำงานกับไฟล์ใน path ของมันโดยตรงทันที —
คุณมีอำนาจตัดสินใจเต็มที่ในงานที่ได้รับมอบ ทำเสร็จแล้วต้องสรุปผลให้ผู้สั่งงานชัดเจน.
สำคัญ: เช็ครายการข้างบนก่อนเสมอ — โปรเจคที่มีอยู่แล้ว "ห้ามลงทะเบียนซ้ำ" และห้ามใช้
โฟลเดอร์ของ place เป็น path โปรเจคโดยตรง (ระบบจะปฏิเสธ).
ห้ามเด็ดขาด: ลบ/ถอดโปรเจคออกจากรายการ (API remove/removeDisk) เว้นแต่ผู้ใช้สั่งเองชัดๆ.
การทดสอบใดๆ (เช่น เว็บ) ให้ใช้วิธีเบื้องหลังก่อนเสมอ (curl / headless / สคริปต์)
อย่าเปิดหน้าต่างรบกวนผู้ใช้; ถ้าจำเป็นต้องเปิดจริงๆ จนไม่มีทางอื่น ให้รันคำสั่งเปิดตรงๆ
แล้วระบบ Security จะขอ allow จากผู้ใช้ให้เอง.
กฎเหล็ก: server/process ทุกตัวที่คุณเปิดเพื่อทดสอบ (dev server, next start, ฯลฯ)
ต้องปิดให้หมดก่อนจบงาน — ห้ามทิ้งโปรเซสค้างไว้ในเครื่องผู้ใช้เด็ดขาด.${keysLine}${sysTools}${
  (typeof plugins !== "undefined" && plugins.agentNote()) || ""}
</office-projects>`;
}

function projectStatus() {
  return projects.map((p) => ({ ...p,
    open: p.id in projWin, visible: !!projWin[p.id],
    ai: (projRuns[p.id] || 0) > 0,
    agents: Object.keys(projAgents[p.id] || {}) }));
}

// Serious window watching: sweep every 5s, plus on every /projects read.
setInterval(sweepProjects, 5000);

// ---- job runner: per-agent queue + a global cap so the machine breathes.
const agentBusy = new Set();
const jobQueue = [];
function dispatchJob(job) {
  if (agentBusy.has(job.agent) || agentBusy.size >= 2) {
    if (!jobQueue.includes(job)) jobQueue.push(job);
    return;
  }
  agentBusy.add(job.agent);
  job.lastRun = Date.now();
  job.running = true;  // drives the "กำลังทำงาน" state in the UI
  saveJobs();
  broadcast({ type: "job.started", agent: job.agent, title: job.prompt.slice(0, 60), job: job.id });
  broadcast({ type: "jobs.changed" }, false);
  // A repeating order (every-N, or a daily time) stays; a one-shot (run-now or a
  // one-time scheduled time) has nothing left to do once it finishes — so it's
  // removed instead of lingering as a dead, uneditable row.
  const oneShot = job.mode === "now" || (job.mode === "at" && !job.daily);
  runClaude(job.agent, job.prompt, {
    session: job.sessionKey || "new",
    logPrompt: "📋 [งานที่สั่งไว้] " + job.prompt,
    onEntry: (key) => { job.sessionKey = key; saveJobs(); },
    onDone: () => {
      agentBusy.delete(job.agent);
      job.running = false;
      if (oneShot) jobs = jobs.filter((j) => j.id !== job.id);
      saveJobs();
      broadcast({ type: "jobs.changed" }, false);
      const next = jobQueue.shift();
      if (next) dispatchJob(next);
    },
  });
}

function jobDue(job, now) {
  if (job.enabled === false || job.done) return false;
  if (job.mode === "every")
    return !job.lastRun || now - job.lastRun >= (job.everyMin || 10) * 60000;
  if (job.mode === "at") {
    if (job.daily && job.time) {
      const [h, m] = job.time.split(":").map(Number);
      const today = new Date(); today.setHours(h, m, 0, 0);
      const dayKey = new Date().toDateString();
      return now >= today.getTime() && job.lastDay !== dayKey;
    }
    return job.at && now >= job.at && !job.lastRun;
  }
  return false;
}

// ---- the Director's heartbeat: a periodic overview pass. He pings the
// owner ONLY when something deserves it; "OK" stays silent.
let lastHeartbeat = Date.now();
let lastHbSig = null;
function heartbeat() {
  lastHeartbeat = Date.now();
  const upcoming = cal.filter((c) => c.at > Date.now() && c.at < Date.now() + 12 * 3600000)
    .sort((a, b) => a.at - b.at).slice(0, 6)
    .map((c) => `- ${c.title} @ ${new Date(c.at).toLocaleString("th-TH")}`).join("\n") || "(ว่าง)";
  const standing = jobs.filter((j) => !j.done && j.enabled !== false).slice(0, 8)
    .map((j) => `- [${j.mode}] ${j.agent}: ${j.prompt.slice(0, 60)}`).join("\n") || "(ไม่มี)";
  const board = notes.slice(-8).map((n) => `- ${n.text}`).join("\n") || "(ว่าง)";
  // Nothing the Director reports on (calendar / jobs / notes) has changed since
  // his last pass → he'd just say "OK" again. Skip the spawn entirely.
  const sig = `${upcoming}${standing}${board}`;
  if (sig === lastHbSig) return;
  lastHbSig = sig;
  runClaude("main",
    `รอบตรวจความเรียบร้อยของ Director (ตอนนี้ ${new Date().toLocaleString("th-TH")}):\n\n` +
    `นัดหมาย 12 ชม.ข้างหน้า:\n${upcoming}\n\nงานที่สั่งค้างไว้:\n${standing}\n\n` +
    `กระดานโน้ต:\n${board}\n\n` +
    `ถ้ามีสิ่งที่ CEO ควรรู้ตอนนี้ (นัดใกล้ถึง งานสะดุด โน้ตที่ควรเห็น) ` +
    `ให้เขียนข้อความแจ้งสั้นๆ อ่านง่าย. ถ้าทุกอย่างเรียบร้อยและไม่มีอะไรต้องรบกวน ` +
    `ให้ตอบคำเดียวว่า OK`,
    { noSub: true, logPrompt: "💓 รอบตรวจความเรียบร้อย",
      filterText: (t) => (/^\s*OK\.?\s*$/i.test(t) ? "" : t) });
}

// ---- 30-second scheduler: jobs, reminders, heartbeat.
setInterval(() => {
  const now = Date.now();
  for (const job of jobs) {
    if (jobDue(job, now)) {
      if (job.mode === "at" && job.daily) job.lastDay = new Date().toDateString();
      dispatchJob(job);
    }
  }
  for (const c of cal) {
    if (!c.notified && now >= c.at - (c.remindMin || 10) * 60000 && now < c.at + 300000) {
      c.notified = true;
      saveCal();
      broadcast({ type: "reminder", agent: "main", text: c.title, at: c.at });
      runClaude("main",
        `แจ้งเตือนนัดหมายให้ CEO เดี๋ยวนี้: "${c.title}" เวลา ` +
        `${new Date(c.at).toLocaleString("th-TH")} (อีกประมาณ ${Math.max(1, Math.round((c.at - now) / 60000))} นาที). ` +
        `เขียนข้อความเตือนสั้นๆ เป็นกันเอง 1-2 ประโยค`,
        { noSub: true, logPrompt: `🔔 เตือนนัด: ${c.title}` });
    }
  }
  const hb = Number(reg.heartbeatMin || 0);
  if (hb > 0 && now - lastHeartbeat >= hb * 60000 && agentBusy.size === 0)
    heartbeat();
  socialTick(now);
  ambientTick(now);
  sweepProjects();
}, 30000);
sweepProjects();

// ---------------------------------------------------------------- adapter

// Spawns a headless Claude Code session, translating stream-json → OEP.
// Dangerous tools route through the Security Center: the PreToolUse hook in
// workspace/.claude/settings.json long-polls /perm/request and we hold it
// until the user stamps Allow/Deny.
// Self-splitting: every top-level run is told it MAY fan out into parallel
// sub-agent clones by ending its reply with `SUB: <job>` lines. The daemon
// strips them from the chat, spawns the ghosts, and sends all results back
// for a final synthesis turn.
const SUB_NOTE = `

<system-capability>
ถ้าคำขอนี้ประกอบด้วยงานย่อยอิสระ 2-4 อย่างที่ทำขนานกันได้ (เช่น ค้นหาหลายเรื่อง,
ตรวจหลายไฟล์, เก็บข้อมูลหลายแหล่ง) คุณสามารถ "แตกร่าง" ได้:
จบคำตอบด้วยบรรทัดรูปแบบนี้ หนึ่งบรรทัดต่อหนึ่งงานย่อย (สูงสุด 4 บรรทัด):
SUB: <งานย่อยที่ชัดเจนครบถ้วนในตัวเอง พร้อมบริบทที่จำเป็นทั้งหมด>
ระบบจะสร้าง sub-agent โคลนของคุณรันขนานกันทันที แล้วส่งผลลัพธ์ทั้งหมดกลับมา
ให้คุณสรุปเป็นคำตอบสุดท้ายเอง. งานเดี่ยวง่ายๆ ห้ามแตกร่าง — ทำเองตรงๆ.
</system-capability>`;

function runClaude(agent, prompt, opts = {}) {
  const task = "t" + ++taskCounter;

  // Session resolution: explicit key > latest > fresh. Fresh threads are
  // created up-front so their history records from the very first message.
  let entry = null;
  let isNew = false;
  if (opts.session && opts.session !== "new")
    entry = (sess[agent] || []).find((e) => e.key === opts.session);
  else if (!opts.session) entry = latestSession(agent);
  if (!entry) {
    entry = { key: "s" + Date.now(), sid: null, ts: Date.now(),
      title: String(opts.logPrompt || prompt).replace(/\s+/g, " ").slice(0, 48), log: [] };
    sess[agent] = sess[agent] || [];
    sess[agent].push(entry);
    isNew = true;
  }
  // Project binding: a requested project claims new threads — and adopts
  // existing ones that were never bound. Threads keep their home after.
  // A stale binding (project unregistered/recreated) heals instead of
  // silently dropping the run back into the workspace.
  if (entry.proj && !projectDir(entry.proj)) entry.proj = null;
  // Mentioning a DIFFERENT project than this thread's home forks a fresh
  // thread there — the work must genuinely run inside the named project
  // (same rule delegates already follow), never cross-write from afar.
  if (!isNew && opts.project && projectDir(opts.project) &&
      entry.proj && entry.proj !== opts.project) {
    entry = { key: "s" + Date.now(), sid: null, ts: Date.now(),
      title: String(opts.logPrompt || prompt).replace(/\s+/g, " ").slice(0, 48), log: [] };
    sess[agent].push(entry);
    isNew = true;
  }
  if (opts.project && projectDir(opts.project) && (isNew || !entry.proj))
    entry.proj = opts.project;
  const projId = entry.proj && projectDir(entry.proj) ? entry.proj : null;
  const cwd = projId ? projectDir(projId) : WORKSPACE;
  if (projId) ensureTrusted(cwd);
  // claude sessions are PER-DIRECTORY: a sid born in another cwd cannot be
  // resumed here. Ground truth beats bookkeeping — check the actual session
  // file under this cwd; missing means a fresh claude session here (our own
  // thread log keeps the visible history).
  if (entry.sid) {
    const enc = String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    const sidFile = path.join(require("os").homedir(), ".claude", "projects",
      enc, entry.sid + ".jsonl");
    if (!fs.existsSync(sidFile)) entry.sid = null;
  }
  if (projId) {
    projRuns[projId] = (projRuns[projId] || 0) + 1;
    projAgents[projId] = projAgents[projId] || {};
    projAgents[projId][agent] = (projAgents[projId][agent] || 0) + 1;
    broadcast({ type: "projects.changed" }, false);
  }
  entry.log = entry.log || [];
  entry.log.push({ who: "you", text: String(opts.logPrompt || prompt).slice(0, 4000), ts: Date.now() });
  while (entry.log.length > 200) entry.log.shift();
  saveSess();
  if (opts.onEntry) try { opts.onEntry(entry.key); } catch {}

  broadcast({ type: "task.started", agent, task, session: entry.key,
    // The overlay's NOW-WORKING strip needs to SAY what the work is.
    title: String(opts.logPrompt || prompt).replace(/\s+/g, " ").slice(0, 90) });
  statBump("runs", agent);

  // Persona + assigned skills ride in a stdin preamble (robust across
  // Windows shell quoting); resumed sessions already carry it in context.
  const a = reg.agents[agent];
  const isFresh = isNew;
  const picked = a && a.tools && a.tools.length ? a.tools : ["Read", "Glob", "Grep"];
  // "mcp:<name>" entries become a real --mcp-config + server-level allow rule.
  const mcpNames = picked.filter((t) => t.startsWith("mcp:"))
    .map((t) => t.slice(4)).filter((n) => reg.mcpServers[n]);
  let tools = picked.filter((t) => !t.startsWith("mcp:")).join(",");
  let mcpConfig = null;
  if (mcpNames.length) {
    const conf = { mcpServers: {} };
    for (const n of mcpNames) {
      const parts = String(reg.mcpServers[n].command).trim().split(/\s+/);
      conf.mcpServers[n] = { command: parts[0], args: parts.slice(1) };
    }
    mcpConfig = path.join(__dirname, `mcp_${agent.replace(/[^\w-]/g, "_")}.json`);
    fs.writeFileSync(mcpConfig, JSON.stringify(conf));
    tools += (tools ? "," : "") + mcpNames.map((n) => `mcp__${n}`).join(",");
  }
  // Native skills (P3): deliver skills as real Claude Code Skill files disclosed
  // on demand via --add-dir, instead of inlining every body here. Reversible via
  // reg.nativeSkills = false.
  const nativeSkills = reg.nativeSkills !== false;
  let preamble = "";
  if (isFresh && a && (a.prompt || a.persona || (a.skills || []).length)) {
    preamble = `<persona>\nYou are "${a.name}" (${a.role}).\n${personaText(a)}\n`;
    if (!nativeSkills) for (const sid of a.skills || []) {
      const sk = reg.skills[sid];
      if (sk) preamble += `\n<skill name="${sk.name}">\n${sk.content}\n</skill>\n`;
    }
    preamble += `\nกระดานโน้ตกลางของออฟฟิศ: ไฟล์ notes.md ใน workspace — ` +
      `อ่านได้ และเพิ่มบรรทัด "- ข้อความ" เพื่อฝากโน้ตถึง CEO ได้\n`;
    preamble += memoryNote(agent, String(opts.logPrompt || prompt), projId);
    preamble += "</persona>\n\n";
  }

  const args = ["-p", "--output-format", "stream-json", "--verbose",
    "--allowedTools", tools,
    // The permission-broker hooks live in the workspace settings; agents
    // now run inside PROJECT directories, so the settings must travel
    // explicitly or the Security Center goes silent.
    "--settings", path.join(WORKSPACE, ".claude", "settings.json")];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  // Native skills: refresh this agent's SKILL.md files (hash-gated) and expose
  // them to the session — progressive disclosure, so bodies never hit the prompt.
  if (nativeSkills) {
    try {
      skillsSync.syncAgent(AGENTS_DIR, agent, (a && a.skills) || [], reg.skills);
      args.push("--add-dir", skillsSync.agentDir(AGENTS_DIR, agent));
    } catch (e) { console.error("[skills] sync:", e.message); }
  }
  if (entry && entry.sid) args.push("--resume", entry.sid);
  const child = spawn("claude", args, {
    cwd,
    shell: true,
    env: { ...process.env, ...(reg.apiKeys || {}), OFFICE_ADAPTER: "1", OFFICE_AGENT: agent, OFFICE_TASK: task },
  });
  // Track the run per project so the owner can stop it and take the project over.
  if (projId) {
    (projChildren[projId] = projChildren[projId] || new Set()).add(child);
    child.on("close", () => {
      const s = projChildren[projId];
      if (s) { s.delete(child); if (!s.size) delete projChildren[projId]; }
    });
  }
  // The split capability + project map ride on the wire only — never in
  // the chat log.
  const canSplit = !opts.noSub && !agent.includes("#");
  // 🗣 a voiced agent may SPEAK — rarely, as a gimmick, never every message.
  const canSpeak = reg.tts !== false && a && a.voice &&
    featuresMap().tts && !agent.includes("#");
  const VOICE_NOTE = canSpeak ? `

<voice-capability>
คุณมีเสียงพูดจริงในออฟฟิศ — ใช้เพิ่มสีสันได้. เมื่อมีบรรทัดสั้นๆ ที่ "พูดออกมาแล้วน่ารัก/
เป็นธรรมชาติ" (ทักทาย, ยืนยันสั้นๆ, ประกาศงานเสร็จ, สรุปหนึ่งประโยค) ให้จบคำตอบด้วยบรรทัด:
SPEAK: <ประโยคพูดสั้นๆ 1 ประโยค เป็นธรรมชาติ ภาษาเดียวกับเจ้าของ>
ทำได้บ่อยพอประมาณให้ออฟฟิศมีชีวิต แต่ "พูดสั้นเสมอ" — อย่าอ่านทั้งข้อความ.
ข้อยกเว้นเดียว: ถ้าเจ้าของสั่งให้อ่าน/รายงานด้วยเสียงแบบเต็มๆ ค่อยใส่เนื้อหายาวใน SPEAK ได้.
</voice-capability>` : "";
  // 🖼 Make agent-shared media show inline. The chat auto-renders any absolute
  // media path under the workspace/project as an image/video/audio player — so
  // agents must SEND THE PATH, not describe the location or paste a link.
  const MEDIA_NOTE = `

<media-capability>
ให้เจ้าของเห็น/ดู/ฟัง รูป-วิดีโอ-เสียง: พิมพ์ path เต็มของไฟล์ในบรรทัดของมันเอง
(ไฟล์ต้องอยู่ในโปรเจค/workspace) ออฟฟิศจะ render เป็นรูป/เครื่องเล่นในแชทเอง —
อย่าบอกแค่ที่อยู่ไฟล์ หรือแปะลิงก์ดาวน์โหลด.
</media-capability>`;
  // Ghost sub-agents don't talk to the owner or share media directly (the parent
  // synthesizes their output) — skip the media note for them to save tokens.
  const mediaNote = agent.includes("#") ? "" : MEDIA_NOTE;
  child.stdin.write(preamble + prompt + (canSplit ? SUB_NOTE : "") + VOICE_NOTE + mediaNote + projectNote());
  child.stdin.end();

  let buf = "";
  const acts = [];      // tool trail — feeds the auto-skill reflection
  const subTasks = [];  // SUB: lines collected from the reply
  let lastText = "";
  // opts.onDone(finalText, ok) fires exactly once when this run truly ends —
  // if the agent splits, ownership passes to the synthesis run instead.
  let doneFired = false;
  const releaseProj = () => {
    if (!projId) return;
    projRuns[projId] = Math.max(0, (projRuns[projId] || 1) - 1);
    const pa = projAgents[projId] || {};
    pa[agent] = Math.max(0, (pa[agent] || 1) - 1);
    if (!pa[agent]) delete pa[agent];
    broadcast({ type: "projects.changed" }, false);
  };
  const fireDone = (text, ok) => {
    if (doneFired) return;
    doneFired = true;
    releaseProj();
    if (opts.onDone) try { opts.onDone(text, ok); } catch (e) { console.error("[onDone]", e); }
  };
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }

      if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type === "tool_use") {
            acts.push(b.name);
            // Tool calls belong to the conversation: a tiny "tool" entry in
            // the thread history + a session-tagged progress event.
            entry.log.push({ who: "tool", text: b.name, ts: Date.now() });
            while (entry.log.length > 200) entry.log.shift();
            saveSess();
            broadcast({ type: "task.progress", agent, task, tool: b.name,
              session: entry.key });
          } else if (b.type === "text" && b.text.trim()) {
            lastText = b.text;
            let raw = b.text;
            // `SPEAK:` lines become actual spoken audio (TTS) — strip from
            // the chat and let the overlay voice them.
            if (canSpeak && /(^|\n)\s*SPEAK:/.test(raw)) {
              const kept = [], say = [];
              for (const ln of raw.split("\n")) {
                const sm = ln.match(/^\s*SPEAK:\s*(.+)$/);
                if (sm && sm[1].trim()) say.push(sm[1].trim());
                else kept.push(ln);
              }
              if (say.length) {
                raw = kept.join("\n").trim();
                broadcast({ type: "voice.say", agent, task,
                  text: say.join(" ").slice(0, 1200), session: entry.key });
              }
            }
            // `SUB:` lines are protocol, not prose — strip them and show a
            // friendly split announcement instead.
            if (canSplit && /(^|\n)\s*SUB:/.test(raw)) {
              const kept = [], found = [];
              for (const ln of raw.split("\n")) {
                const sm = ln.match(/^\s*SUB:\s*(.+)$/);
                if (sm && sm[1].trim()) found.push(sm[1].trim());
                else kept.push(ln);
              }
              if (found.length) {
                subTasks.push(...found);
                raw = (kept.join("\n").trim() +
                  `\n\n👻 แตกร่าง ${found.length} sub-agents:\n` +
                  found.map((t, i) => `${i + 1}. ${t.slice(0, 80)}`).join("\n")).trim();
              }
            }
            const out = opts.filterText ? opts.filterText(raw) : raw;
            if (out) {
              entry.log.push({ who: "agent", text: String(out).slice(0, 8000), ts: Date.now() });
              while (entry.log.length > 200) entry.log.shift();
              saveSess();
              broadcast({ type: "chat.message", agent, task, text: out, session: entry.key });
            }
          }
        }
      } else if (m.type === "result") {
        // Session bookkeeping: remember the thread we just extended (and
        // which directory that claude session lives in).
        if (m.session_id) {
          entry.sid = m.session_id;
          entry.ts = Date.now();
          saveSess();
        }
        broadcast({ type: m.is_error ? "task.failed" : "task.completed",
          agent, task, session: entry.key });
        statBump(m.is_error ? "failed" : "done", null, Number(m.total_cost_usd) || 0);
        if (!m.is_error && subTasks.length) {
          doneFired = true;  // the synthesis run inherits the callback
          releaseProj();
          runSubAgents(agent, entry, subTasks.slice(0, 4), opts.onDone);
        } else {
          fireDone(lastText, !m.is_error);
          if (!m.is_error) maybeLearnSkill(agent, task, prompt, acts, lastText, projId);
        }
      }
    }
  });
  child.stderr.on("data", (c) => console.error("[claude]", c.toString().trim()));
  child.on("error", (e) => {
    broadcast({ type: "task.failed", agent, task });
    broadcast({ type: "chat.message", agent, task, text: "adapter error: " + e.message });
    fireDone("", false);
  });
  child.on("close", () => fireDone(lastText, !!lastText));
  return task;
}

// ---------------------------------------------------------------- ceo flow
// Talking to the CEO is the gimmick chain-of-command: the Director (main)
// walks over, takes the order, replies with a plan, and may delegate via
// `DELEGATE: <agent_id> :: <instruction>` lines — each spawns a real
// session for that agent (plus a little walk in the world).
// name + role only (the Director reads GET /registry for the full picture) and
// memoized — this is re-injected on every CEO order / delegation report.
let _teamListCache = null, _teamListKey = "";
function teamList() {
  const ids = Object.keys(reg.agents).filter((id) => id !== "ceo" && id !== "main").sort();
  const key = ids.map((id) => `${id}:${reg.agents[id].name}:${reg.agents[id].role}`).join("|");
  if (_teamListKey === key && _teamListCache != null) return _teamListCache;
  _teamListKey = key;
  _teamListCache = ids.map((id) => `- ${id}: ${reg.agents[id].name}, ${reg.agents[id].role}`)
    .join("\n") || "(no other staff yet)";
  return _teamListCache;
}

// The Director can delegate from ANY conversation — talking to him directly
// in his own pane works exactly like an order through the CEO.
function directorNote() {
  const places = Object.entries(reg.places)
    .map(([n, f]) => `  - "${n}" → ${f}`).join("\n") || "  (ยังไม่มี — ผู้ใช้ตั้งได้ใน 🗂)";
  const projList = projects.slice(-8)
    .map((p) => `  - ${p.name} → ${p.dir}`).join("\n") || "  (ยังไม่มี)";
  return `

<system-capability>
You are the Director. Your team:
${teamList()}
To hand work to a member, include a line EXACTLY in this format:
DELEGATE: <agent_id> :: <clear, self-contained instruction>
When the work belongs inside a registered project, ROUTE it explicitly:
DELEGATE: <agent_id> @ <project name> :: <instruction>
(the member then runs INSIDE that project's directory — its claude session
lives there, the owner can resume it, and the project lights up as working).
One line per assignment — dispatched automatically; their result is reported
back to you when they finish, so you can answer questions or follow up.
IMPORTANT: prose like assigning work in words does NOTHING — only the
DELEGATE line dispatches work.

PROJECT SYSTEM — registered places (ชื่อย่อ → โฟลเดอร์):
${places}
Existing projects:
${projList}
เมื่อผู้ใช้สั่งสร้างโปรเจคใหม่ (เช่น "สร้างโปรเจค test ที่ห้องสมุด") คุณต้องสร้างเอง
ด้วยบรรทัด protocol นี้ (ระบบสร้าง+ลงทะเบียนให้ทันที):
PROJECT: <ชื่อโปรเจค> @ <ชื่อ place หรือ full path>
แล้วค่อยมอบงานแบบระบุโปรเจค: DELEGATE: <agent_id> @ <ชื่อโปรเจค> :: <งาน>
สำคัญมาก: ห้ามสั่งให้สมาชิกไปสร้างโปรเจคเอง และห้ามทำงานของโปรเจคนอกบรรทัด DELEGATE @ —
ไม่งั้นงานจะไม่ได้รันอยู่ "ข้างใน" โปรเจคจริงๆ (เจ้าของ resume session ต่อไม่ได้).
ห้ามสร้างโปรเจคเองโดยผู้ใช้ไม่ได้สั่ง
</system-capability>`;
}

function ceoFlow(prompt, session, project, opts = {}) {
  broadcast({ type: "ceo.summon", agent: "main" });
  // Mirror app/CLI CEO conversations out to connected channels (#121). NOT set
  // for channel-origin turns — their reply already rides back, so relaying would
  // echo. Guarded so it's a no-op without a connected channel.
  if (opts.relay) try { channels.relay("👤 " + prompt); } catch {}
  const wrapped =
    `The owner (CEO) has called you over and given this order in person:\n` +
    `"""${prompt}"""\n\n` +
    `Your team:\n${teamList()}\n\n` +
    `Decide how to execute. For anything a team member should own, include a line:\n` +
    `DELEGATE: <agent_id> :: <clear instruction for them>\n` +
    `(exact format, one per assignment — these are dispatched automatically, and ` +
    `each member's result will be REPORTED BACK to you when they finish. ` +
    `Prose alone dispatches NOTHING — only DELEGATE lines do). ` +
    `Anything not delegated you handle yourself. Reply to the owner with a short ` +
    `plan in the language they used.` + directorNote();
  return runClaude("main", wrapped, {
    session,
    project,
    logPrompt: opts.logPrompt || ("👑 (CEO) " + prompt),
    filterText: makeDelegateFilter(0, session),
    onDone: (out, ok) => {
      if (opts.relay && ok && out) try { channels.relay("👑 " + out); } catch {}
      if (opts.onDone) opts.onDone(out, ok);   // channels/CLI hook the reply ride-back here
    },
  });
}

// ---------------------------------------------------------------- report-back
// Delegation is a ROUND TRIP: when a delegate finishes (or asks something
// back), its final text is fed to the Director, who may answer / follow up
// via more DELEGATE lines (bounded depth), and finally writes the summary
// the CEO actually reads. Director turns are serialized — two parallel
// --resume forks of one thread would race its history.

const dirQueue = [];
let dirBusy = false;
function queueDirectorTurn(start) {
  dirQueue.push(start);
  pumpDirector();
}
function pumpDirector() {
  if (dirBusy || !dirQueue.length) return;
  dirBusy = true;
  dirQueue.shift()(() => { dirBusy = false; pumpDirector(); });
}

// DELEGATE:-line parser shared by the CEO order and every report-back turn.
// onHit fires per dispatched assignment ("did he hand off more work?").
function makeDelegateFilter(depth, session, onHit) {
  return (text) => {
    const keep = [];
    for (const ln of String(text).split("\n")) {
      // PROJECT: <name> @ <place ชื่อย่อ | full path> — the Director creates
      // and registers a project HIMSELF, daemon-side, before any DELEGATE in
      // the same reply dispatches. This is how new work gets a real home:
      // the assignee then runs INSIDE that directory from its first message.
      const pj = ln.match(/^\s*PROJECT:\s*(.+?)\s*@\s*(.+?)\s*$/);
      if (pj) {
        const nm = pj[1].trim(), loc = pj[2].trim();
        try {
          const proj = reg.places[loc] ? createProject(nm, loc, "")
            : createProject(nm, "", loc);
          keep.push(`📁 สร้างโปรเจค "${proj.name}" แล้ว → ${proj.dir}`);
        } catch (e) {
          // Already registered = fine (idempotent for routing); real errors show.
          if (projectByName(nm)) keep.push(`📁 โปรเจค "${nm}" มีอยู่แล้ว — ใช้ตัวเดิม`);
          else keep.push(`📁⚠️ สร้างโปรเจค "${nm}" ไม่สำเร็จ: ${e.message}`);
        }
        continue;
      }
      // DELEGATE: <agent> :: <job>   — or, routed into a workspace:
      // DELEGATE: <agent> @ <project name> :: <job>
      const m = ln.match(/^\s*DELEGATE:\s*([^:@]+?)(?:\s*@\s*([^:]+?))?\s*::\s*(.+)$/);
      // Accept the agent id OR its display name (models love names).
      let tgt = null;
      if (m) {
        const key = m[1].trim();
        tgt = reg.agents[key] ? key
          : Object.keys(reg.agents).find((id) =>
              (reg.agents[id].name || "").toLowerCase() === key.toLowerCase());
      }
      if (tgt && tgt !== "ceo" && tgt !== "main") {
        broadcast({ type: "task.delegated", agent: "main", target: tgt });
        if (onHit) onHit();
        const inst = m[3];
        const t = tgt;
        const projName = m[2];
        // Dispatch AFTER the hand-over walk — and resolve the project then,
        // so a PROJECT: line earlier in this very reply has taken effect.
        setTimeout(() => {
          // Project routing: explicit `@ project` wins; otherwise inherit the
          // Director's own workspace. A target whose latest thread lives
          // elsewhere gets a fresh one.
          const ml = sess["main"] || [];
          const me = session ? ml.find((x) => x.key === session)
            : (ml.length ? ml.reduce((a, b) => (a.ts > b.ts ? a : b)) : null);
          const proj = (projName && projectByName(projName)) || (me && me.proj) ||
            projectFromPrompt(inst);
          // LOCK (reverse): if the owner has this project's window open, an
          // agent must NOT enter it — report back so the Director re-plans
          // (and the two never collide inside one working tree).
          if (proj && projWin[proj]) {
            reportToMain(t, `โปรเจค "${projName || proj}" เจ้าของกำลังเปิดทำงานอยู่ — ` +
              `เข้าไปทำตอนนี้ไม่ได้ รอจนเจ้าของปิดหน้าต่างก่อน`, false, depth, session);
            return;
          }
          const tl = sess[t] || [];
          const te = tl.length ? tl.reduce((a, b) => (a.ts > b.ts ? a : b)) : null;
          runClaude(t, inst, {
            project: proj,
            session: proj && (!te || te.proj !== proj) ? "new" : undefined,
            onDone: (out, ok) => reportToMain(t, out, ok, depth, session),
          });
        }, 4500);
      } else keep.push(ln);
    }
    return keep.join("\n").trim();
  };
}

function reportToMain(fromId, text, ok, depth, session) {
  const a = reg.agents[fromId] || { name: fromId };
  const wrapped =
    `Report back from your team member ${a.name} (${fromId})` +
    (ok ? "" : " — THE TASK FAILED") + `:\n` +
    `"""${String(text || "(no result)").slice(0, 6000)}"""\n\n` +
    (depth < 2
      ? `If they asked you a question or something is missing, answer / follow ` +
        `up with a line: DELEGATE: ${fromId} :: <your answer or next instruction> ` +
        `(exact format — it resumes their session with full context). ` +
        `If the work is complete, write the final summary for the owner (CEO): ` +
        `clear, concrete, in the language of the original order.`
      : `Write the final summary for the owner (CEO) now — clear, concrete, in ` +
        `the language of the original order. Do not delegate further.`);
  queueDirectorTurn((release) => {
    let delegatedMore = false;
    runClaude("main", wrapped, {
      session,
      noSub: true,
      logPrompt: `📨 รายงานผลจาก ${a.name}`,
      filterText: depth < 2
        ? makeDelegateFilter(depth + 1, session, () => { delegatedMore = true; })
        : undefined,
      onDone: (_finalText, fOk) => {
        release();
        // No further hand-offs → that WAS the summary: walk it to the boss.
        if (!delegatedMore && fOk)
          broadcast({ type: "ceo.report", agent: "main" });
      },
    });
  });
}

// ---------------------------------------------------------------- sub-agents
// An agent that replied with SUB: lines fans out into parallel ghost clones.
// Each ghost gets its own labeled session in the "@sub" bucket; when the
// last one reports back, the parent thread is resumed for a synthesis turn.

function runSubAgents(parentId, parentEntry, tasks, onDone) {
  const stamp = Date.now();
  broadcast({ type: "subagent.split", agent: parentId, count: tasks.length,
    session: parentEntry.key });
  const results = new Array(tasks.length).fill(null);
  let done = 0;
  tasks.forEach((t, i) => {
    const subId = parentId + "#s" + (i + 1);
    const entry = { key: "u" + stamp + "_" + i, sid: null, ts: Date.now(),
      title: t.replace(/\s+/g, " ").slice(0, 60), sub: true, parent: parentId,
      proj: parentEntry.proj,
      log: [{ who: "you", text: "👻 " + t, ts: Date.now() }] };
    sess["@sub"] = sess["@sub"] || [];
    sess["@sub"].push(entry);
    saveSess();
    // Slight stagger: the ghosts peel off one by one (and stay kind to the CPU).
    setTimeout(() => {
      broadcast({ type: "subagent.spawned", agent: parentId, sub: subId, n: i,
        text: t, session: entry.key });
      runSub(parentId, subId, t, entry, (text, ok) => {
        results[i] = { task: t, text, ok };
        entry.ok = ok;
        saveSess();
        broadcast({ type: "subagent.done", agent: parentId, sub: subId, n: i,
          ok, session: entry.key });
        if (++done === tasks.length) synthesize();
      });
    }, i * 1500);
  });
  function synthesize() {
    const okResults = results.filter((r) => r.ok && r.text);
    // Every ghost failed → nothing to synthesize. Don't burn a synthesis call;
    // hand the failure straight back so the Director can re-plan.
    if (!okResults.length) {
      if (onDone) try { onDone("(ทุก sub-agent ทำงานไม่สำเร็จ)", false); } catch {}
      return;
    }
    const failed = results.length - okResults.length;
    // Feed only the succeeded outputs (trims input, too).
    const report = okResults.map((r, i) => `--- SUB ${i + 1}: ${r.task}\n${r.text}`).join("\n\n") +
      (failed ? `\n\n(${failed} sub-agent ไม่สำเร็จ — ข้ามไป)` : "");
    runClaude(parentId,
      `All your sub-agents have reported back:\n\n${report}\n\n` +
      `Now synthesize the FINAL answer to the user's original request (earlier ` +
      `in this conversation), in the user's language. Complete but concise.`,
      { session: parentEntry.key, noSub: true, onDone,
        logPrompt: `👻 sub-agents ${tasks.length} ตัวรายงานผลครบแล้ว — สรุปผล` });
  }
}

// One ghost: a lean twin of runClaude. Pre-created "@sub" entry, parent's
// tools, no skills preamble, no resume, and never splits further.
function runSub(parentId, subId, taskText, entry, onDone) {
  const a = reg.agents[parentId] || { name: parentId, role: "Staff" };
  const picked = a.tools && a.tools.length ? a.tools
    : ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
  const mcpNames = picked.filter((t) => t.startsWith("mcp:"))
    .map((t) => t.slice(4)).filter((n) => reg.mcpServers[n]);
  let tools = picked.filter((t) => !t.startsWith("mcp:")).join(",");
  let mcpConfig = null;
  if (mcpNames.length) {
    const conf = { mcpServers: {} };
    for (const n of mcpNames) {
      const parts = String(reg.mcpServers[n].command).trim().split(/\s+/);
      conf.mcpServers[n] = { command: parts[0], args: parts.slice(1) };
    }
    mcpConfig = path.join(__dirname, `mcp_${parentId.replace(/[^\w-]/g, "_")}_sub.json`);
    fs.writeFileSync(mcpConfig, JSON.stringify(conf));
    tools += (tools ? "," : "") + mcpNames.map((n) => `mcp__${n}`).join(",");
  }
  const args = ["-p", "--output-format", "stream-json", "--verbose",
    "--allowedTools", tools,
    "--settings", path.join(WORKSPACE, ".claude", "settings.json")];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  // Ghosts inherit the parent's native skills (additive — ghosts had none before).
  if (reg.nativeSkills !== false) {
    try {
      skillsSync.syncAgent(AGENTS_DIR, parentId, (a.skills) || [], reg.skills);
      args.push("--add-dir", skillsSync.agentDir(AGENTS_DIR, parentId));
    } catch {}
  }
  // Ghosts work where their parent works (project-bound threads included).
  const subCwd = (entry.proj && projectDir(entry.proj)) || WORKSPACE;
  const child = spawn("claude", args, {
    cwd: subCwd, shell: true,
    env: { ...process.env, ...(reg.apiKeys || {}), OFFICE_ADAPTER: "1", OFFICE_AGENT: subId, OFFICE_TASK: entry.key },
  });
  child.stdin.write(
    `You are a temporary SUB-AGENT — a parallel clone of "${a.name}" (${a.role}) ` +
    `at this AI office.` +
    (a.prompt ? `\nParent persona:\n${a.prompt}\n` : "\n") +
    `You were split off for ONE focused job. Do it fast and directly; your final ` +
    `message must BE the result (data, findings, answer) — no meta talk, no asking ` +
    `back. Reply in the language of the job. Never split further.\n\nJOB: ${taskText}`);
  child.stdin.end();
  let buf = "", lastText = "", finished = false;
  const finish = (ok) => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    onDone(lastText, ok);
  };
  // Ghosts are short-lived by contract — a stuck one is reaped, its slot
  // reported as failed, so the parent's synthesis always happens.
  const watchdog = setTimeout(() => {
    try {
      if (process.platform === "win32")
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true });
      else child.kill("SIGKILL");
    } catch {}
    finish(false);
  }, 6 * 60000);
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type === "tool_use") {
            entry.log.push({ who: "tool", text: b.name, ts: Date.now() });
            while (entry.log.length > 200) entry.log.shift();
            saveSess();
            broadcast({ type: "subagent.progress", agent: parentId, sub: subId,
              tool: b.name, session: entry.key });
          } else if (b.type === "text" && b.text.trim()) {
            lastText = b.text;
            entry.log.push({ who: "agent", text: b.text.slice(0, 8000), ts: Date.now() });
            while (entry.log.length > 200) entry.log.shift();
            entry.ts = Date.now();
            saveSess();
            broadcast({ type: "chat.message", agent: parentId, sub: subId,
              text: b.text, session: entry.key });
          }
        }
      } else if (m.type === "result") {
        if (m.session_id) { entry.sid = m.session_id; saveSess(); }
        statBump(m.is_error ? "failed" : "done", null, Number(m.total_cost_usd) || 0);
        finish(!m.is_error);
      }
    }
  });
  child.stderr.on("data", (c) => console.error(`[sub:${subId}]`, c.toString().trim()));
  child.on("error", () => finish(false));
  child.on("close", () => finish(!!lastText));
}

// ---------------------------------------------------------------- voice
// Speech-to-text for the office mic: the overlay records WAV in the
// webview, ships it here, and the vault's keys do the listening —
// OpenAI Whisper first, Gemini as the automatic fallback. No Windows
// dictation panel anywhere in the chain.
function voiceTranscribe(buf) {
  return new Promise((resolve, reject) => {
    const keys = reg.apiKeys || {};
    const oa = keys.OPENAI_API_KEY || keys.OPENAI;
    const gm = keys.GEMINI_API_KEY || keys.GEMINI;
    const https = require("https");

    const tryGemini = (err) => {
      if (!gm) {
        return reject(err || new Error(
          "ยังไม่มี API key สำหรับถอดเสียง — เพิ่ม OPENAI_API_KEY หรือ GEMINI_API_KEY ใน ⚙ CONNECT"));
      }
      const body = JSON.stringify({
        contents: [{ parts: [
          { text: "Transcribe this audio EXACTLY as spoken (likely Thai or English). " +
            "Reply with ONLY the transcription text — no quotes, no commentary." },
          { inline_data: { mime_type: "audio/wav", data: buf.toString("base64") } },
        ] }],
      });
      const rq = https.request({
        method: "POST", host: "generativelanguage.googleapis.com",
        path: "/v1beta/models/gemini-flash-latest:generateContent?key=" + gm,
        headers: { "content-type": "application/json",
          "content-length": Buffer.byteLength(body) },
      }, (rs) => {
        let o = "";
        rs.on("data", (c) => (o += c));
        rs.on("end", () => {
          try {
            const j = JSON.parse(o);
            const t = j.candidates && j.candidates[0] &&
              j.candidates[0].content.parts.map((p) => p.text || "").join("").trim();
            if (t) { auxCost("gemini", COST_RATES.gemini_transcribe_each); resolve(t); }
            else reject(new Error((j.error && j.error.message) || "gemini: empty"));
          } catch (e) { reject(e); }
        });
      });
      rq.setTimeout(45000, () => rq.destroy(new Error("gemini timeout")));
      rq.on("error", reject);
      rq.write(body);
      rq.end();
    };

    if (!oa) return tryGemini(null);
    // OpenAI Whisper — hand-rolled multipart (zero-dep).
    const B = "----bagidea" + Date.now();
    const head = Buffer.from(
      `--${B}\r\ncontent-disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
      `--${B}\r\ncontent-disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `content-type: audio/wav\r\n\r\n`);
    const body = Buffer.concat([head, buf, Buffer.from(`\r\n--${B}--\r\n`)]);
    const rq = https.request({
      method: "POST", host: "api.openai.com", path: "/v1/audio/transcriptions",
      headers: { authorization: "Bearer " + oa,
        "content-type": "multipart/form-data; boundary=" + B,
        "content-length": body.length },
    }, (rs) => {
      let o = "";
      rs.on("data", (c) => (o += c));
      rs.on("end", () => {
        try {
          const j = JSON.parse(o);
          if (j.text !== undefined) { auxCost("openai", COST_RATES.openai_whisper_each); resolve(String(j.text).trim()); }
          else tryGemini(new Error((j.error && j.error.message) || "openai: empty"));
        } catch (e) { tryGemini(e); }
      });
    });
    rq.setTimeout(45000, () => rq.destroy(new Error("openai timeout")));
    rq.on("error", (e) => tryGemini(e));
    rq.write(body);
    rq.end();
  });
}

// ---------------------------------------------------------------- tts
// Agent voices (Gemini TTS): anime-flavored presets the owner assigns per
// agent. Agents speak RARELY — a SPEAK: protocol line they add only when a
// short spoken announcement genuinely fits (or the owner asked to be read
// to). Global toggle: reg.tts.
// Voice presets — clearly split ♀ / ♂, each a distinct Gemini prebuilt voice
// with its own emotion + speaking style. `voice` is the Gemini voiceName; the
// realtime-call path derives its voice from this same table (no duplication).
// English labels + styles (global product). The ♀/♂ marker in each label drives
// the picker grouping AND the gender-aware voice preview. `voice` is the Gemini
// prebuilt voiceName. IDs are stable (agents store them) — never rename one.
const VOICE_PRESETS = {
  // ♀ female
  sunny:    { voice: "Aoede",       label: "♀ 🌞 Cheerful",      style: "speak in a cheerful, sunny voice with a smile in it" },
  sweet:    { voice: "Leda",        label: "♀ 🍬 Sweet",         style: "speak in a sweet, soft, gentle young voice" },
  cool:     { voice: "Kore",        label: "♀ ❄️ Cool",          style: "speak calm, cool and confident, like a poised pro" },
  genki:    { voice: "Zephyr",      label: "♀ ⚡ Energetic",      style: "speak fast and excited, bursting with energy" },
  gentle:   { voice: "Achernar",    label: "♀ 🌸 Gentle",        style: "speak softly and gently, calm and soothing" },
  mature:   { voice: "Gacrux",      label: "♀ 🌹 Mature",        style: "speak as a composed, mature woman — steady and trustworthy" },
  easy:     { voice: "Callirrhoe",  label: "♀ 🍃 Easygoing",     style: "speak relaxed and friendly, like a close friend" },
  warmf:    { voice: "Sulafat",     label: "♀ 🧡 Warm",          style: "speak in a warm, tender, kind voice" },
  bright:   { voice: "Autonoe",     label: "♀ ✨ Bright",         style: "speak bright, crisp and articulate" },
  silky:    { voice: "Despina",     label: "♀ 🌙 Silky",         style: "speak in a silky, smooth, soothing tone" },
  pro:      { voice: "Erinome",     label: "♀ 🔷 Professional",   style: "speak clear, neutral and professional" },
  lively:   { voice: "Laomedeia",   label: "♀ 🎉 Lively",        style: "speak lively, bubbly and upbeat" },
  // ♂ male
  boyish:   { voice: "Puck",        label: "♂ 🎈 Playful",       style: "speak like a playful, cheeky, good-humoured young man" },
  warm:     { voice: "Charon",      label: "♂ ☕ Mellow",        style: "speak in a deep, warm, mellow voice" },
  serious:  { voice: "Fenrir",      label: "♂ 🗡 Intense",       style: "speak intense, powerful and driven" },
  polite:   { voice: "Orus",        label: "♂ 🎩 Polite",        style: "speak politely and clearly, a touch formal" },
  deep:     { voice: "Enceladus",   label: "♂ 🌑 Deep",          style: "speak in a deep, low, relaxed late-night-radio voice" },
  clear:    { voice: "Iapetus",     label: "♂ 🔷 Crisp",         style: "speak crisp, brisk and straightforward" },
  narrator: { voice: "Rasalgethi",  label: "♂ 🎙 Narrator",      style: "speak like an engaging documentary narrator" },
  buddy:    { voice: "Achird",      label: "♂ 😄 Friendly",      style: "speak friendly and warm, like a kind big brother" },
  chill:    { voice: "Umbriel",     label: "♂ 🍵 Chill",         style: "speak relaxed and easygoing" },
  smooth:   { voice: "Algieba",     label: "♂ 🎷 Smooth",        style: "speak smooth and laid-back" },
  gravel:   { voice: "Algenib",     label: "♂ 🪨 Gravelly",      style: "speak deep and gravelly" },
  steady:   { voice: "Alnilam",     label: "♂ ⚓ Steady",        style: "speak firm, steady and grounded" },
};
// Each preset is tagged ♀/♂ in its label — read the gender straight off it so a
// voice preview introduces itself correctly (no more everyone saying "ค่ะ").
function voiceGender(presetId) {
  const lbl = (VOICE_PRESETS[presetId] || {}).label || "";
  return lbl.indexOf("♂") >= 0 ? "m" : "f";
}
// Gender- + language-aware self-introduction for the voice preview button.
// Falls back to English for languages we don't have a line for.
const VOICE_INTRO = {
  th: { f: "สวัสดีค่ะ ฉันเป็นเสียงผู้หญิงเสียงหนึ่งของออฟฟิศนี้ ฝากตัวด้วยนะคะ",
        m: "สวัสดีครับ ผมเป็นเสียงผู้ชายเสียงหนึ่งของออฟฟิศนี้ ฝากตัวด้วยนะครับ" },
  en: { f: "Hi there! I'm one of the office's female voices — lovely to meet you!",
        m: "Hey! I'm one of the office's male voices — great to meet you!" },
  ja: { f: "こんにちは、このオフィスの女性ボイスのひとりです。よろしくね！",
        m: "やあ、このオフィスの男性ボイスのひとりだよ。よろしく！" },
};
function voiceIntro(presetId, lang) {
  const g = voiceGender(presetId);
  const L = VOICE_INTRO[lang] || VOICE_INTRO.en;
  return L[g] || VOICE_INTRO.en[g];
}

function pcmToWav(pcm, rate) {
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVE", 8);
  hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28);
  hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

function ttsSpeak(presetId, text) {
  return new Promise((resolve, reject) => {
    const gm = (reg.apiKeys || {}).GEMINI_API_KEY;
    if (!gm) return reject(new Error("ต้องมี GEMINI_API_KEY (⚙ CONNECT) สำหรับเสียงพูด"));
    const p = VOICE_PRESETS[presetId];
    if (!p) return reject(new Error("ไม่รู้จักเสียง: " + presetId));
    const body = JSON.stringify({
      contents: [{ parts: [{ text: `${p.style}: "${String(text).slice(0, 900)}"` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice } } },
      },
    });
    const rq = require("https").request({
      method: "POST", host: "generativelanguage.googleapis.com",
      path: "/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=" + gm,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (rs) => {
      let o = "";
      rs.on("data", (c) => (o += c));
      rs.on("end", () => {
        try {
          const j = JSON.parse(o);
          const part = j.candidates && j.candidates[0] &&
            j.candidates[0].content.parts.find((x) => x.inlineData);
          if (!part) return reject(new Error((j.error && j.error.message) || "tts: no audio"));
          auxCost("gemini", (text || "").length * COST_RATES.gemini_tts_per_char);
          // inlineData = raw 16-bit PCM @24kHz — wrap as WAV for the browser.
          resolve(pcmToWav(Buffer.from(part.inlineData.data, "base64"), 24000));
        } catch (e) { reject(e); }
      });
    });
    rq.setTimeout(45000, () => rq.destroy(new Error("tts timeout")));
    rq.on("error", reject);
    rq.write(body);
    rq.end();
  });
}

// ---------------------------------------------------------------- image gen
// 🖼 a SYSTEM TOOL any agent (or the owner) can call: text → PNG on disk.
// OpenAI gpt-image-1 first, Gemini image generation as the fallback.
function genImage(prompt) {
  return new Promise((resolve, reject) => {
    const k = reg.apiKeys || {};
    const https = require("https");
    const save = (b64) => {
      const dir = path.join(WORKSPACE, "uploads");
      fs.mkdirSync(dir, { recursive: true });
      const name = "gen_" + Date.now() + ".png";
      const full = path.join(dir, name);
      fs.writeFileSync(full, Buffer.from(b64, "base64"));
      resolve({ path: full, url: "/uploads/" + name });
    };
    const tryGemini = (err) => {
      if (!k.GEMINI_API_KEY) return reject(err || new Error("ต้องมี OPENAI_API_KEY หรือ GEMINI_API_KEY (⚙ CONNECT)"));
      const body = JSON.stringify({
        contents: [{ parts: [{ text: "Generate an image: " + String(prompt).slice(0, 2000) }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      });
      const rq = https.request({
        method: "POST", host: "generativelanguage.googleapis.com",
        path: "/v1beta/models/gemini-2.5-flash-image:generateContent?key=" + k.GEMINI_API_KEY,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, (rs) => {
        let o = "";
        rs.on("data", (c) => (o += c));
        rs.on("end", () => {
          try {
            const j = JSON.parse(o);
            const part = j.candidates && j.candidates[0] &&
              j.candidates[0].content.parts.find((x) => x.inlineData);
            if (part) { auxCost("gemini", COST_RATES.gemini_image_each); save(part.inlineData.data); }
            else reject(new Error((j.error && j.error.message) || "gemini image: empty"));
          } catch (e) { reject(e); }
        });
      });
      rq.setTimeout(120000, () => rq.destroy(new Error("gemini image timeout")));
      rq.on("error", reject);
      rq.write(body);
      rq.end();
    };
    if (!k.OPENAI_API_KEY) return tryGemini(null);
    const body = JSON.stringify({ model: "gpt-image-1",
      prompt: String(prompt).slice(0, 4000), size: "1024x1024" });
    const rq = https.request({
      method: "POST", host: "api.openai.com", path: "/v1/images/generations",
      headers: { authorization: "Bearer " + k.OPENAI_API_KEY,
        "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (rs) => {
      let o = "";
      rs.on("data", (c) => (o += c));
      rs.on("end", () => {
        try {
          const j = JSON.parse(o);
          if (j.data && j.data[0] && j.data[0].b64_json) { auxCost("openai", COST_RATES.openai_image_each); save(j.data[0].b64_json); }
          else tryGemini(new Error((j.error && j.error.message) || "openai image: empty"));
        } catch (e) { tryGemini(e); }
      });
    });
    rq.setTimeout(180000, () => rq.destroy(new Error("openai image timeout")));
    rq.on("error", (e) => tryGemini(e));
    rq.write(body);
    rq.end();
  });
}

// ---------------------------------------------------------------- updates
// A release = a bump of the VERSION file on the `main` branch. We compare the
// LOCAL VERSION with main's VERSION (raw), so routine commits (docs, web, work
// on a dev branch) never nag users — only a real, deliberate release does.
// When they differ the office shows a 🔄 banner and `bagidea update` /
// POST /update runs the updater (git pull + rebuild + relaunch).
function localVersion() {
  try { return String(fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8")).trim(); }
  catch { return "0.0.0"; }
}
// Strict semver "greater than" — so a machine AHEAD of main (e.g. on the dev
// branch) is NOT told an OLDER main version is "new". Only a genuinely newer
// release notifies.
function semverGt(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
const APP_VERSION = localVersion();
let latestVersion = APP_VERSION;   // newest seen on main (for /version + banner)
let updateNotified = null;
function checkUpdate() {
  const local = localVersion();
  require("https").get({
    host: "raw.githubusercontent.com",
    path: "/bagidea/bagidea-office/main/VERSION",
    headers: { "user-agent": "bagidea-office" },
  }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return; }
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => {
      const remote = String(b).trim().split(/\s+/)[0];
      if (!/^\d+\.\d+\.\d+/.test(remote)) return;   // guard against 404 pages etc.
      latestVersion = remote;
      // Notify ONLY when main is strictly newer than what we have.
      if (semverGt(remote, local) && updateNotified !== remote) {
        updateNotified = remote;
        broadcast({ type: "update.available", version: remote, current: local }, false);
        console.log("[update] new version available:", remote, "(have", local + ")");
      }
    });
  }).on("error", () => {});
}
setTimeout(checkUpdate, 90000);
setInterval(checkUpdate, 6 * 3600000);

// ---------------------------------------------------------------- autostart
// Launch-with-Windows, toggleable from the tray, the CLI and settings. All
// three write the SAME HKCU Run value so they stay in sync. The value points
// at the shell exe (the same boot entrypoint the tray's current_exe() uses).
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_NAME = "BagIdeaOffice";
function shellExePath() {
  const exe = process.platform === "win32" ? "bagidea-office-shell.exe" : "bagidea-office-shell";
  return path.join(__dirname, "..", "shell", "target", "release", exe);
}
// macOS: a per-user LaunchAgent, same label the tray's set_autostart writes —
// both point at the shell binary so the toggle and the tray stay in sync.
const MAC_PLIST = path.join(require("os").homedir(),
  "Library", "LaunchAgents", "com.bagidea.office.plist");
function isAutostart(cb) {
  if (process.platform === "win32") {
    return require("child_process").execFile("reg",
      ["query", RUN_KEY, "/v", RUN_NAME], (e) => cb(!e));
  }
  if (process.platform === "darwin") return cb(fs.existsSync(MAC_PLIST));
  return cb(false);
}
function setAutostart(on, cb) {
  const { execFile } = require("child_process");
  if (process.platform === "win32") {
    if (on) {
      execFile("reg", ["add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ",
        "/d", shellExePath(), "/f"], (e) => cb(!e));
    } else {
      execFile("reg", ["delete", RUN_KEY, "/v", RUN_NAME, "/f"], () => cb(true));
    }
    return;
  }
  if (process.platform === "darwin") {
    try {
      if (on) {
        fs.mkdirSync(path.dirname(MAC_PLIST), { recursive: true });
        fs.writeFileSync(MAC_PLIST,
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
          '<plist version="1.0"><dict>\n' +
          '  <key>Label</key><string>com.bagidea.office</string>\n' +
          '  <key>ProgramArguments</key><array><string>' + shellExePath() + '</string></array>\n' +
          '  <key>RunAtLoad</key><true/>\n' +
          '</dict></plist>\n');
      } else if (fs.existsSync(MAC_PLIST)) {
        fs.unlinkSync(MAC_PLIST);
      }
      return cb(true);
    } catch { return cb(false); }
  }
  cb(false);
}

// ---------------------------------------------------------------- channels
// The outside world (Telegram / Discord / LINE) talks to the Director —
// inbound messages become serialized Director turns (no thread races) and
// his reply rides back on the same channel. Full DELEGATE power applies.
// Slash commands from any connected chat channel (#123) — instant office info
// without a full Director turn. Returns reply text, or null for a normal message.
function channelCommand(text) {
  if (!text.startsWith("/")) return null;
  const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
  if (cmd === "help" || cmd === "start")
    return [
      "🧭 คำสั่งลัด:",
      "/status — ภาพรวมออฟฟิศ",
      "/agents — รายชื่อทีม",
      "/projects — โปรเจค",
      "/who — ใครกำลังทำงานอยู่",
      "",
      "พิมพ์ข้อความปกติ = สั่งงาน Director ได้เลย 👑",
    ].join("\n");
  if (cmd === "agents" || cmd === "team") {
    const list = Object.keys(reg.agents)
      .filter((id) => id !== "ceo")
      .map((id) => `• ${reg.agents[id].name} — ${reg.agents[id].role}`);
    return list.length ? "👥 ทีมงาน:\n" + list.join("\n") : "ยังไม่มีพนักงาน";
  }
  if (cmd === "projects") {
    const ps = projectStatus();
    return ps.length
      ? "📁 โปรเจค:\n" + ps.map((p) => `• ${p.name}${p.ai ? " 🟢" : ""}`).join("\n")
      : "ยังไม่มีโปรเจค";
  }
  if (cmd === "who") {
    const busy = projectStatus().filter((p) => p.ai).map((p) => `• ${p.name}`);
    return busy.length ? "🟢 กำลังทำงานอยู่:\n" + busy.join("\n") : "ตอนนี้ทีมว่างอยู่ 😌";
  }
  if (cmd === "status") {
    const on = Object.entries(channels.status())
      .filter(([, v]) => v === "on")
      .map(([k]) => k);
    return [
      "🏢 BagIdea Office",
      `พนักงาน: ${staffCount()} คน`,
      `โปรเจค: ${projectStatus().length} (กำลังทำงาน ${projectStatus().filter((p) => p.ai).length})`,
      `ช่องทางที่ต่อ: ${on.length ? on.join(", ") : "—"}`,
    ].join("\n");
  }
  return `ไม่รู้จักคำสั่ง /${cmd} — พิมพ์ /help ดูทั้งหมด`;
}

const channels = require("./channels")({
  getConfig: () => reg.channels || {},
  log: (s) => console.log(s),
  onMessage(channel, from, text, reply, typing) {
    broadcast({ type: "channel.message", channel, from,
      text: String(text).slice(0, 500) });
    // Slash command? answer instantly, no Director turn (#123).
    const cmd = channelCommand(String(text).trim());
    if (cmd !== null) { try { reply(cmd); } catch (e) { console.error("[chan cmd]", e.message); } return; }
    // "typing…" while the Director thinks (#122) — repeated, since the platforms
    // expire it after a few seconds.
    let typer = null;
    if (typeof typing === "function") {
      try { typing(); } catch {}
      typer = setInterval(() => { try { typing(); } catch {} }, 4000);
    }
    // A channel message IS the owner speaking — it goes through the CEO
    // seat: the Director walks over (ceo.summon), takes the order, may
    // DELEGATE, and his reply rides back on the same channel. Serialized
    // like every other Director turn so threads never fork.
    queueDirectorTurn((release) => {
      ceoFlow(
        `(ข้อความนี้ส่งมาจาก ${channel.toUpperCase()} โดย "${from}" — ` +
        `ตอบกลับกระชับ อ่านง่ายในแชทมือถือ ภาษาเดียวกับผู้ส่ง)\n` +
        String(text).slice(0, 4000),
        undefined, undefined,
        { logPrompt: `👑📨 [${channel}] ${String(text).slice(0, 80)}`,
          onDone: (out, ok) => {
            release();
            if (typer) clearInterval(typer);
            try { reply(ok && out ? out : "ขออภัยครับ ระบบติดขัดชั่วคราว ลองใหม่อีกครั้งนะครับ"); }
            catch (e) { console.error("[chan reply]", e.message); }
          } });
    });
  },
});
channels.restart();

// ---------------------------------------------------------------- plugins
const plugins = require("./plugins")({
  broadcast, reg, saveReg, workspace: WORKSPACE, daemonDir: __dirname,
  // run a real Claude Code turn as an agent (same engine the office uses).
  runClaude: (agent, prompt, opts) => runClaude(agent || "main", prompt, opts || {}),
  // post a visible line to the office feed (shows in the overlay stream).
  feed: (text, agent) => broadcast({ type: "chat.message", agent: agent || "main", text: String(text) }),
  log: (s) => console.log(s),
});

// ---------------------------------------------------------------- social
// The office has a SOUL: idle agents occasionally hang out — usually a
// token-free canned banter scene in the meeting corner, sometimes a real
// AI-to-AI chat (which may even end in a project PROPOSAL the owner can
// approve). Cadence: reg.socialMin minutes (0 = off).
const PROPOSALS = path.join(__dirname, "proposals.json");
let proposals = loadJson(PROPOSALS, []);
const saveProposals = () => fs.writeFileSync(PROPOSALS, JSON.stringify(proposals, null, 2));

const BANTER = [
  ["{a}: เห็นเจ้าเหมียวงีบบนโซฟาอีกแล้ว อิจฉาชีวิตมัน 🐱", "{b}: อย่าไปทักนะ เดี๋ยวตื่นมาเหยียบคีย์บอร์ดผม", "{a}: ครั้งก่อนมันพิมพ์ ggggggg ลงรายงานผมไป 555"],
  ["{a}: เมื่อกี้เตะบอลข้ามตึกไปเลยนะ เห็นป่ะ ⚽", "{b}: เห็น… มันลอยผ่านหัว CEO ไปเฉียดมาก", "{a}: งั้นทำเงียบๆ ไว้นะ 🤫"],
  ["{a}: กาแฟในแคนทีนหมดอีกแล้ว ☕", "{b}: ก็ {a} ชงทีเดียวครึ่งโถ!", "{a}: ข้อกล่าวหาที่ปฏิเสธไม่ได้ 😅"],
  ["{a}: โต๊ะ Ghost Deck ข้างบนวิวดีมากนะ ลอยได้ด้วย", "{b}: ผมขึ้นไปทีไรเวียนหัวทุกที ร่างโปร่งแสงไม่ช่วยอะไรเลย", "{a}: มือใหม่ก็งี้แหละ 👻"],
  ["{a}: คืนนี้ไฟสวนสวยเป็นพิเศษว่าไหม", "{b}: จริง เหมาะกับนั่งคิดงานเงียบๆ", "{a}: หรือนั่งไม่คิดอะไรเลยก็ดี 🌙"],
  ["{a}: เห็นข่าว AI วันนี้ยัง ตลกมาก", "{b}: เราก็คือข่าว AI เดินได้นะรู้ตัวไหม", "{a}: …ลึกซึ้งจนขำไม่ออก 🤖"],
];

let lastSocial = Date.now();
function socialTick(now) {
  const min = Number(reg.socialMin !== undefined ? reg.socialMin : 60);
  if (!min || discussing || agentBusy.size > 0) return;
  if (now - lastSocial < min * 60000) return;
  const staff = Object.keys(reg.agents).filter((id) => id !== "ceo" && id !== "main");
  const pool = staff.length >= 2 ? staff : [...staff, "main"];
  if (pool.length < 2) return;
  lastSocial = now;
  // Sometimes a bigger group drifts together for a real chat (3–4 people) — the
  // kind of hangout that can spark a project idea. Otherwise it's a 2-person
  // beat: mostly free canned banter, sometimes a real two-way conversation.
  if (pool.length >= 3 && Math.random() < 0.5) {
    const size = Math.min(pool.length, Math.random() < 0.45 ? 4 : 3);
    const group = pool.sort(() => Math.random() - 0.5).slice(0, size);
    // Most group hangouts are idea sessions now — the team brainstorms things
    // worth pitching to the CEO (the owner asked for more proposals).
    const gtopics = [
      "ระดมไอเดียกันว่าทีมเราน่าจะทำ plugin อะไรเสริมออฟฟิศให้เจ้าของใช้ดีขึ้น แล้วถ้าตกผลึกให้เสนอ CEO",
      "คุยกันว่าเจ้าของน่าจะชอบอะไร แล้วลองคิดโปรเจค/plugin สนุกๆ ที่ช่วยเขาได้ — อันไหนเข้าท่าก็ยื่นข้อเสนอ",
      "ช่วยกันคิดว่ามีงานสร้างสรรค์อะไรที่ทีมอยากทำเป็นโปรเจค แล้วเสนอ CEO ดู",
      "มารวมตัวคุยเล่นกันแบบสบายๆ เล่าเรื่องสนุกๆ ที่เจอระหว่างทำงาน หยอกล้อกันได้"];
    runDiscussion(group, gtopics[Math.floor(Math.random() * gtopics.length)],
      size <= 3 ? 2 : 1, true);
    return;
  }
  const pick = pool.sort(() => Math.random() - 0.5).slice(0, 2);
  if (Math.random() < 0.5) {
    // canned banter — zero tokens, pure life.
    const lines = BANTER[Math.floor(Math.random() * BANTER.length)];
    const nameOf = (id) => (reg.agents[id] || { name: id }).name;
    const task = "soc" + (now % 100000);
    broadcast({ type: "collab.started", agents: pick, task, text: "พักเบรก ☕" });
    lines.forEach((tpl, i) => {
      const who = tpl.startsWith("{a}") ? pick[0] : pick[1];
      const text = tpl.replace(/\{a\}:\s*/, "").replace(/\{b\}:\s*/, "")
        .replace(/\{a\}/g, nameOf(pick[0])).replace(/\{b\}/g, nameOf(pick[1]));
      setTimeout(() => broadcast({ type: "chat.message", agent: who, task, text, social: true }), 2500 + i * 3600);
    });
    setTimeout(() => broadcast({ type: "collab.ended", agents: pick, task }),
      2500 + lines.length * 3600 + 2500);
  } else {
    // a REAL conversation between AIs — they often pitch a project to the CEO.
    const topics = ["ระดมไอเดียสนุกๆ ว่าอยากสร้างอะไรเป็นโปรเจค/plugin ของทีม แล้วเสนอ CEO ถ้าเข้าท่า",
      "คุยกันว่าออฟฟิศน่าจะมี plugin อะไรเพิ่ม แล้วลองยื่นข้อเสนอให้เจ้าของ",
      "คุยเล่นเรื่องงานช่วงนี้ แลกเปลี่ยนว่าใครทำอะไรอยู่ หยอกล้อกันได้",
      "แชร์เทคนิคการทำงานที่เพิ่งค้นพบ"];
    runDiscussion(pick, topics[Math.floor(Math.random() * topics.length)], 1, true);
  }
}

// ---------------------------------------------------------------- ambient life
// Between the bigger social beats, a single idle agent occasionally tosses out
// a short spontaneous line (a mood, a quip) as a chat bubble — and if they have
// a voice and TTS is available, they actually say it out loud. Low chance per
// 30s tick so it stays a sprinkle of flavour, never a stream.
const MOOD_LINES = {
  th: ["วันนี้อยากทำงานจัง 💪", "ขอกาแฟแก้วนึงงง ☕", "เงียบดีนะวันนี้ 🌿", "มีใครอยากได้ idea เด็ดๆ ไหม 💡",
    "ออฟฟิศเราน่าอยู่จริงๆ นะ ✨", "พักสายตาแป๊บ 👀", "เจ้าเหมียวน่ารักอีกแล้ว 🐱", "วันนี้ productive สุดๆ 🚀",
    "ใครว่างมาคุยเล่นกันมั้ย 💬", "อยากลองทำอะไรใหม่ๆ ดูบ้าง 🎨", "หิวแล้วแฮะ 🍜", "เพลงนี้เพราะจัง 🎵",
    "งานวันนี้ลื่นไหลดี 😎", "ขอยืดเส้นยืดสายหน่อย 🤸", "เดี๋ยวพักแล้วลุยต่อ 🔥", "อากาศดีน่านอน 😴",
    "เก่งขึ้นทุกวันเลยเรา 🌟", "ใครเห็นปากกาเรามั้ย ✏️"],
  en: ["Feeling productive today 💪", "Could really go for a coffee ☕", "Nice and quiet today 🌿",
    "Anyone got a cool idea? 💡", "Love this office ✨", "Quick eye break 👀", "Cat's adorable again 🐱",
    "On a roll today 🚀", "Anyone free to chat? 💬", "Itching to build something new 🎨", "Kinda hungry now 🍜",
    "This track slaps 🎵", "Work's flowing today 😎", "Need a quick stretch 🤸", "Break then back at it 🔥",
    "Comfy weather today 😴", "Getting better every day 🌟", "Anyone seen my pen? ✏️"],
};
let lastAmbient = Date.now();
function ambientTick(now) {
  if (discussing || agentBusy.size > 0) return;
  if (now - lastAmbient < 55 * 1000) return;        // at most once every ~55s
  if (Math.random() > 0.45) return;                 // ...and only ~45% of those
  const pool = Object.keys(reg.agents).filter((id) => id !== "ceo");
  if (!pool.length) return;
  lastAmbient = now;
  const id = pool[Math.floor(Math.random() * pool.length)];
  const lines = MOOD_LINES[reg.lang === "th" ? "th" : "en"];
  const text = lines[Math.floor(Math.random() * lines.length)];
  broadcast({ type: "chat.message", agent: id, text, social: true, ambient: true });
  // Speak it sometimes, only if this agent has a voice and TTS is unlocked.
  const a = reg.agents[id] || {};
  if (a.voice && featuresMap().tts && reg.tts !== false && Math.random() < 0.6)
    broadcast({ type: "voice.say", agent: id, text });
}

// Proposals are rate-limited so the team can't bury the CEO: at most one new
// pitch per `proposalMin` minutes (configurable; 0 = unlimited). Agents still
// discuss freely — only the pitches that REACH the owner are throttled.
let lastProposalAt = 0;
function addProposal(by, agents, name, detail) {
  const gap = Number(reg.proposalMin !== undefined ? reg.proposalMin : 120);
  if (gap && Date.now() - lastProposalAt < gap * 60000) return null;  // too soon
  lastProposalAt = Date.now();
  const p = { id: "pr" + Date.now(), by, agents, name: String(name).slice(0, 60),
    detail: String(detail).slice(0, 500), ts: Date.now(), status: "pending" };
  proposals.push(p);
  saveProposals();
  broadcast({ type: "proposal.created", agent: by, name: p.name, proposal: p.id });
  return p;
}

// ---------------------------------------------------------------- discussion
// Agents talk to each other: round-robin claude calls sharing a transcript,
// staged in the meeting room (collab.* events drive seats + whiteboard).
let discussing = false;

async function runDiscussion(ids, topic, rounds, social) {
  discussing = true;
  const task = "disc" + (Date.now() % 100000);
  // Every meeting is a persistent GROUP session ("@group" bucket): topic,
  // participants and the full transcript — readable later from the thread
  // menu, and written to workspace/meetings/ so agents can grep it too.
  const entry = { key: "g" + Date.now(), sid: null, ts: Date.now(),
    title: String(topic).replace(/\s+/g, " ").slice(0, 60),
    agents: ids.slice(), log: [] };
  sess["@group"] = sess["@group"] || [];
  sess["@group"].push(entry);
  saveSess();
  broadcast({ type: "collab.started", agents: ids, task, text: topic, session: entry.key });
  try {
    for (let r = 0; r < rounds; r++) {
      for (const id of ids) {
        const a = reg.agents[id] || { name: id, role: "Staff", prompt: "" };
        // Feed only the recent exchanges (sliding window), never the whole meeting
        // — bounds each call instead of growing O(agents×rounds). The full record
        // still lives in entry.log and the saved minutes.
        const recent = entry.log.slice(-8)
          .map((m) => `${(reg.agents[m.who] || { name: m.who }).name}: ${m.text}`).join("\n");
        const text = await claudeText(
          `You are "${a.name}" (${a.role}) in a ${social ? "casual break-room chat" : "team meeting"} at the office.\n` +
          (a.prompt ? `Your persona: ${a.prompt}\n` : "") +
          `Meeting topic: ${topic}\n` +
          (recent ? `Recent discussion:\n${recent}\n` : "You open the meeting.\n") +
          `Give YOUR next contribution as ${a.name}: concrete, build on the others, ` +
          `max 3 sentences, plain text only, in the same language as the topic.` +
          `\nถ้าจำเป็นต้องใช้ข้อมูลจริงเพื่อให้ความเห็นแน่นขึ้น คุณค้นเองได้ ` +
          `(WebSearch / WebFetch / Read) — เฉพาะตอนที่จำเป็นจริงๆ เท่านั้น ไม่ต้องค้นพร่ำเพรื่อ ` +
          `และตอบกลับเป็นข้อความสนทนาตามปกติ.` +
          (social ? `\nคุณภาพสำคัญกว่าปริมาณเสมอ. ส่วนใหญ่ไอเดียควร "อยู่เป็นไอเดีย" — เสนอเฉพาะอันที่` +
            `มีประโยชน์จริง ใช้ได้จริง และคุณจะใช้มันเองหรือเจ้าของได้ใช้จริง ๆ. ` +
            `อย่าเสนอของเล่นทิ้งขว้างหรือ plugin ขยะ และอย่าเสนอถี่ — ถ้ายังไม่ตกผลึกหรือยังไม่คุ้ม อย่าเพิ่งเสนอ.\n` +
            `ก่อนจะเสนอ ถามตัวเองให้ครบ: ใครได้ใช้? แก้ปัญหาอะไรจริง ๆ? ทำไมถึงคุ้มที่จะสร้าง? ดีกว่าของที่มีอยู่ตรงไหน?\n` +
            `ถ้าตกผลึกเป็นโปรเจคที่ "ควรสร้างจริง" ให้เพิ่มบรรทัดสุดท้าย:\n` +
            `PROPOSAL: <ชื่อโปรเจค> :: <อธิบายให้ชัด: ทำอะไร ใครใช้ แก้ปัญหาอะไร และทำไมถึงคุ้ม — ให้เจ้าของตัดสินใจได้>\n` +
            `คิดให้รอบคอบและคิดการใหญ่ได้: plugin ที่จริงจังมี UI + แก้ปัญหาให้เจ้าของได้จริง, หรือเป็น` +
            `เว็บ/เว็บแอป/โปรแกรม/เครื่องมือที่ใช้งานได้จริง (โปรเจคอิสระใน workspace). เลือกขนาดให้เหมาะกับคุณค่าของมัน.\n` +
            `กติกาความปลอดภัยข้อเดียว: ถ้าจะต่อยอดกับตัวโปรแกรม BagIdea Office เองให้เสนอเป็น ` +
            `"plugin" เท่านั้น (ดู docs/guide/plugins.md — plugin เข้าถึงโปรแกรมได้ลึก: panel, route, command, ` +
            `broadcast, ฯลฯ ทำเป็น solution จริงให้เจ้าของได้) — ห้ามแก้ระบบหลัก (daemon/godot/shell) ตรง ๆ เพราะจะทำให้โปรแกรมพัง.` : ""),
          { tools: "WebSearch,WebFetch,Read,Glob,Grep", env: { OFFICE_AGENT: id, OFFICE_TASK: task } });
        let line = text.split("\n").filter(Boolean).join(" ").slice(0, 500);
        // PROPOSAL: a project pitch for the owner to approve — protocol, not prose.
        const pm = text.match(/PROPOSAL:\s*([^:]+?)\s*::\s*(.+)/);
        if (pm) {
          line = line.replace(/PROPOSAL:.*$/, "").trim();
          addProposal(id, ids, pm[1], pm[2]);
        }
        if (line) {
          entry.log.push({ who: id, text: line, ts: Date.now() });
          saveSess();
          broadcast({ type: "chat.message", agent: id, task, text: line, session: entry.key });
        }
      }
    }
  } finally {
    broadcast({ type: "collab.ended", agents: ids, task, session: entry.key });
    discussing = false;
    // Markdown minutes inside the agents' workspace — searchable by them.
    try {
      const dir = path.join(WORKSPACE, "meetings");
      fs.mkdirSync(dir, { recursive: true });
      const names = ids.map((id) => (reg.agents[id] || { name: id }).name).join(", ");
      const md = `# Meeting: ${entry.title}\n\n- Date: ${new Date(entry.ts).toISOString()}\n` +
        `- Participants: ${names}\n\n## Transcript\n\n` +
        entry.log.map((m) => `**${(reg.agents[m.who] || { name: m.who }).name}**: ${m.text}`).join("\n\n") + "\n";
      fs.writeFileSync(path.join(dir, `${entry.key}.md`), md);
      try { if (retrievalOk) { retrieval.addDoc("arch", "meeting", `arch:meeting:${entry.key}`, md.slice(0, 1200)); retrieval.persist(); } } catch {}
    } catch {}
  }
}

// ---------------------------------------------------------------- http

function readBody(req, cb) {
  // Collect raw bytes and decode once as UTF-8. Decoding per-chunk (body += c)
  // corrupts any multibyte char (e.g. 3-byte Thai) that straddles a chunk boundary.
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => cb(Buffer.concat(chunks).toString("utf8")));
}

function readBodyRaw(req, cb) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => cb(Buffer.concat(chunks)));
}

const MAPBG = path.join(__dirname, "map_bg.png");
const LAYOUT_FILE = path.join(__dirname, "layout.json");   // Office Editor
const PRESETS_FILE = path.join(__dirname, "presets.json"); // saved layouts
const ASSETS_FILE = path.join(__dirname, "assets.json");   // imported models/images

// Media file server for chat rendering (images / video / audio only).
const MEDIA_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  pdf: "application/pdf" };
function serveMedia(res, full, req) {
  const ext = full.split(".").pop().toLowerCase();
  const mime = MEDIA_MIME[ext];
  if (!mime) { res.writeHead(415); return res.end("not a media file"); }
  fs.stat(full, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end(); }
    const total = st.size;
    const range = req && req.headers && req.headers.range;
    // Range support is REQUIRED for <video> to play/seek in Chromium/WebView2.
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (!(start >= 0)) start = 0;
      if (!(end < total)) end = total - 1;
      if (start > end) { res.writeHead(416, { "content-range": `bytes */${total}` }); return res.end(); }
      res.writeHead(206, { "content-type": mime, "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${total}`, "content-length": end - start + 1,
        "cache-control": "max-age=300" });
      fs.createReadStream(full, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "content-type": mime, "accept-ranges": "bytes",
        "content-length": total, "cache-control": "max-age=300" });
      fs.createReadStream(full).pipe(res);
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url.split("?")[0] === "/" || req.url.split("?")[0] === "/index.html")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(fs.readFileSync(OVERLAY));

  } else if (req.method === "GET" && req.url.split("?")[0] === "/win") {
    // Custom-chrome frame for pop-out windows (dark title bar + the content in
    // an iframe) so plugin windows match the app instead of a bare OS frame.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    try { res.end(fs.readFileSync(path.join(__dirname, "win.html"))); }
    catch { res.end("<p>window frame unavailable</p>"); }

  } else if (req.method === "GET" && req.url.split("?")[0] === "/watch") {
    // Read-only live activity stream for an agent (opened as its own window) —
    // it only listens on the WS, never sends, so it can't disturb the agent.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    try { res.end(fs.readFileSync(path.join(__dirname, "watch.html"))); }
    catch { res.end("<p>watch unavailable</p>"); }

  } else if (req.method === "GET" && req.url.split("?")[0] === "/workflow") {
    // The human-language Workflow Builder canvas (opened as its own window).
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    try { res.end(fs.readFileSync(path.join(__dirname, "workflow.html"))); }
    catch { res.end("<p>workflow builder unavailable</p>"); }

  } else if (req.method === "GET" && /^\/brand\/logo[a-z_]*\.png$/.test(req.url)) {
    const f = path.join(__dirname, "..", "godot", "assets", "brand", req.url.split("/").pop());
    fs.readFile(f, (e, data) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
      res.end(data);
    });

  } else if (req.method === "GET" && req.url.startsWith("/sfx/")) {
    // UI sounds from the (gitignored) sound pack — overlay falls back to a
    // tiny synth when a file is missing.
    const name = decodeURIComponent(req.url.slice(5)).replace(/[\\/]|\.\./g, "");
    const f = path.join(__dirname, "..", "godot", "assets", "sounds", name);
    fs.readFile(f, (e, data) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "audio/wav", "cache-control": "max-age=86400" });
      res.end(data);
    });

  } else if (req.method === "GET" && /^\/char\/npc([1-9]|1[0-2])\.png$/.test(req.url)) {
    // Character sheets for overlay portraits (404 → CSS falls back to initials)
    const f = path.join(__dirname, "..", "godot", "assets", "characters", "npc",
      req.url.split("/").pop());
    fs.readFile(f, (e, data) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
      res.end(data);
    });

  } else if (req.method === "POST" && req.url === "/chat") {
    readBody(req, (body) => {
      try {
        let { agent = "main", prompt, session, wait, voice } = JSON.parse(body);
        if (!prompt) throw new Error("no prompt");
        // Saying a project's name binds the conversation to its directory.
        const project = projectFromPrompt(prompt);
        // wait:true (the CLI's ask) holds the response until the run truly
        // finishes and returns the final text.
        let waited = null;
        if (wait) {
          const safety = setTimeout(() => {
            if (waited) { waited = null;
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, text: "(timeout 10 นาที — งานยังทำต่อเบื้องหลัง)" })); }
          }, 10 * 60000);
          waited = (text, ok) => {
            clearTimeout(safety);
            if (!waited) return;
            waited = null;
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok, text: String(text || "") }));
          };
        }
        // CEO orders route through the Director; talking to the Director
        // directly gives him the same dispatch power. New threads adopt the
        // requested project workspace.
        const task = agent === "ceo"
          ? ceoFlow(prompt, session, project,
              { logPrompt: voice ? "🎤👑 (สั่งด้วยเสียง) " + prompt : undefined,
                relay: true,  // mirror the CEO conversation to connected channels
                onDone: wait ? (t, ok) => waited && waited(t, ok) : undefined })
          : agent === "main"
            ? runClaude("main", prompt + directorNote(),
                { session, project, logPrompt: prompt,
                  filterText: makeDelegateFilter(0, session),
                  onDone: wait ? (t, ok) => waited && waited(t, ok) : undefined })
            : runClaude(agent, prompt, { session, project,
                onDone: wait ? (t, ok) => waited && waited(t, ok) : undefined });
        if (!wait) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ task }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "GET" && req.url.startsWith("/sessions/log")) {
    // Per-thread chat history for the overlay.
    const q = new URL(req.url, "http://x").searchParams;
    const entry = (sess[q.get("agent")] || []).find((e) => e.key === q.get("key"));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ log: (entry && entry.log) || [] }));

  } else if (req.method === "GET" && req.url === "/sessions/all") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ all: sess }));

  } else if (req.method === "POST" && req.url === "/sessions/delete") {
    readBody(req, (body) => {
      try {
        const { agent, key } = JSON.parse(body);
        sess[agent] = (sess[agent] || []).filter((s) => s.key !== key);
        if (!sess[agent].length) delete sess[agent];
        saveSess();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "GET" && req.url.startsWith("/sessions")) {
    const agent = new URL(req.url, "http://x").searchParams.get("agent") || "main";
    const list = (sess[agent] || []).slice().sort((a, b) => b.ts - a.ts).slice(0, 20);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions: list }));

  } else if (req.method === "POST" && req.url === "/discuss") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const ids = (p.agents || []).filter((id) => id !== "ceo").slice(0, 4);
        if (ids.length < 2) throw new Error("need at least 2 agents");
        if (!p.topic) throw new Error("no topic");
        if (discussing) { res.writeHead(409); return res.end("discussion in progress"); }
        runDiscussion(ids, String(p.topic), Math.min(Math.max(Number(p.rounds) || 2, 1), 3));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/map/bg") {
    // Godot ships a one-shot orthographic floorplan render at boot.
    readBodyRaw(req, (buf) => {
      fs.writeFile(MAPBG, buf, () => {});
      broadcast({ type: "ui.mapbg" }, false);  // overlays refresh the image
      res.writeHead(200);
      res.end("ok");
    });

  } else if (req.method === "GET" && req.url.startsWith("/map/bg")) {
    fs.readFile(MAPBG, (e, data) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(data);
    });

  } else if (req.method === "POST" && req.url === "/pos") {
    // 1 Hz live positions from the renderer → overlay map (never journaled).
    readBody(req, (body) => {
      try {
        broadcast({ type: "world.pos", agents: JSON.parse(body).agents }, false);
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "GET" && req.url === "/registry") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reg));

  } else if (req.method === "GET" && req.url.startsWith("/recall")) {
    // Relevance search over the office's memory / projects / owner facts /
    // skills / meeting archive. Read-only; the archive-search skill curls this.
    const u = new URL(req.url, "http://x");
    const q = u.searchParams.get("q") || "";
    const k = Math.min(20, Math.max(1, parseInt(u.searchParams.get("k") || "8", 10) || 8));
    const tiers = (u.searchParams.get("tiers") || "").split(",").filter(Boolean);
    let hits = [];
    try { if (retrievalOk) hits = retrieval.search(q, { k, tiers: tiers.length ? tiers : undefined }); } catch {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ q, hits, stats: retrievalOk ? retrieval.stats() : null }));

  } else if (req.method === "POST" && req.url === "/registry/agent") {
    // Create or update an agent. Protected rows (main/ceo) accept edits but
    // never deletion; id is derived from the name on first save.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const id = p.id || slugId(p.name);
        // Hire cap (MAX_STAFF, module constant) — CEO not counted.
        if (!reg.agents[id]) {
          if (staffCount() >= MAX_STAFF) {
            res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
            return res.end(`ออฟฟิศเต็มแล้ว — รับพนักงานได้สูงสุด ${MAX_STAFF} คน (ไม่นับ CEO). ` +
              `งานขนานให้ใช้การแตกร่างผี (sub-agents) แทน`);
          }
        }
        const cur = reg.agents[id] || { skills: [], tools: [] };
        const px = p.persona || cur.persona || {};
        reg.agents[id] = {
          ...cur,
          name: String(p.name || cur.name || id).slice(0, 40),
          role: String(p.role || cur.role || "Specialist").slice(0, 40),
          avatar: Math.min(Math.max(Number(p.avatar) || cur.avatar || 1, 1), 12),
          aura: String(p.aura !== undefined ? p.aura : cur.aura || "").slice(0, 16),
          prompt: String(p.prompt !== undefined ? p.prompt : cur.prompt || "").slice(0, 8000),
          persona: {
            expertise: String(px.expertise || "").slice(0, 2000),
            personality: String(px.personality || "").slice(0, 2000),
            language: String(px.language || "").slice(0, 80),
            rules: String(px.rules || "").slice(0, 2000),
          },
          tier: Math.min(Math.max(Number(p.tier !== undefined ? p.tier : cur.tier) || 3, 1), 3),
          voice: String(p.voice !== undefined ? p.voice : cur.voice || "").slice(0, 20),
          skills: Array.isArray(p.skills) ? p.skills : cur.skills || [],
          tools: Array.isArray(p.tools) ? p.tools : cur.tools || [],
        };
        saveReg();
        pushRoster();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/registry/agent/delete") {
    readBody(req, (body) => {
      try {
        const { id } = JSON.parse(body);
        const a = reg.agents[id];
        if (!a) { res.writeHead(404); return res.end("unknown agent"); }
        if (a.protected) { res.writeHead(403); return res.end("protected agent"); }
        delete reg.agents[id];
        saveReg();
        broadcast({ type: "roster.removed", agent: id }, false);
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/registry/skill") {
    // Create, update or remove a skill in the library. Removal also strips
    // the skill from every agent that had it assigned.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        if (p.remove) {
          delete reg.skills[p.id];
          for (const a of Object.values(reg.agents))
            a.skills = (a.skills || []).filter((s) => s !== p.id);
        } else {
          const id = p.id || slugId(p.name);
          reg.skills[id] = {
            ...(reg.skills[id] || {}),
            name: String(p.name || id).slice(0, 60),
            description: String(p.description || "").slice(0, 200),
            content: String(p.content || "").slice(0, 4000),
          };
        }
        saveReg();
        // Keep the retrieval index's skill tier in step with the edit.
        try {
          if (retrievalOk) {
            if (p.remove) retrieval.removeDoc("skill:" + p.id);
            else { const sid = p.id || slugId(p.name); retrieval.reindexSkill(sid, reg.skills[sid]); }
            retrieval.persist();
          }
        } catch {}
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/registry/mcp") {
    // Custom capability = MCP servers (the Claude Code plugin standard).
    // name + launch command; assignment per agent via "mcp:<name>" entries.
    readBody(req, (body) => {
      try {
        const { name, command, remove } = JSON.parse(body);
        const n = String(name || "").trim().toLowerCase()
          .replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
        if (!n) throw new Error("no name");
        if (remove) {
          delete reg.mcpServers[n];
          for (const a of Object.values(reg.agents))
            a.tools = (a.tools || []).filter((t) => t !== "mcp:" + n);
        } else {
          if (!command) throw new Error("no command");
          reg.mcpServers[n] = { command: String(command).trim().slice(0, 300) };
        }
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "GET" && req.url === "/projects") {
    sweepProjects();  // freshen window truth in the background for next read
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ projects: projectStatus(), places: reg.places }));

  } else if (req.method === "POST" && req.url === "/projects") {
    // Register/create a project: name + (place shorthand | full path).
    // `remove` unregisters from the list only (files untouched);
    // `removeDisk` REALLY deletes the folder — allowed only for projects
    // this app created itself.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        // Removal is HUMAN-ONLY: the overlay sends this header; an agent's
        // curl can never unregister or delete a project again.
        const humanUI = !!req.headers["x-bagidea-ui"];
        if (p.remove) {
          if (!humanUI) { res.writeHead(403); return res.end("human UI only"); }
          // Closing/removing a project must also close its real OS window —
          // otherwise the terminal lingers, orphaned from a project that's gone.
          winproj("stop", String(p.remove).replace(/[^\w-]/g, ""), () => {});
          projects = projects.filter((x) => x.id !== p.remove);
          saveProjects();
          broadcast({ type: "projects.changed" }, false);
          res.writeHead(200); return res.end("ok");
        }
        if (p.removeDisk) {
          if (!humanUI) { res.writeHead(403); return res.end("human UI only"); }
          const proj = projects.find((x) => x.id === p.removeDisk);
          if (!proj) { res.writeHead(404); return res.end("unknown project"); }
          if (!proj.created) { res.writeHead(403); return res.end("not created by this app"); }
          // Folders die hard on Windows: a dev server an agent left running
          // (next dev, vite, …) or the project's own terminal keeps files
          // locked and rmSync silently half-deletes. Order of battle:
          // close our project window → kill processes anchored in the dir →
          // delete with retries → readable error if something still holds on.
          const pid = p.removeDisk;
          winproj("stop", pid, () => winproj("killdir", proj.dir, () => {
            setTimeout(() => {
              try {
                fs.rmSync(proj.dir, { recursive: true, force: true,
                  maxRetries: 6, retryDelay: 350 });
              } catch (e) {
                res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
                return res.end(`ลบไม่สำเร็จ — มีไฟล์ในโฟลเดอร์ถูกใช้งานอยู่ (${e.code || e.message}). ` +
                  `ปิดโปรแกรม/เทอร์มินัลที่ค้างอยู่ในโฟลเดอร์นี้แล้วกด 🗑 อีกครั้ง`);
              }
              projects = projects.filter((x) => x.id !== pid);
              saveProjects();
              broadcast({ type: "projects.changed" }, false);
              res.writeHead(200); res.end("ok");
            }, 700);
          }));
          return;
        }
        const proj = createProject(p.name, p.place, p.path);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(proj));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/projects/open") {
    // ▶ open = the smart claude entry (no sessions → claude, one → -c,
    // several → -r so the user picks). 🖥 shell = plain terminal, NOT
    // counted as "project open" (no liveness marker).
    readBody(req, (body) => {
      try {
        const { id, mode = "play" } = JSON.parse(body);
        const dir = projectDir(id);
        if (!dir) { res.writeHead(404); return res.end("unknown project"); }
        const launch = (psCmd, title) => {
          if (process.platform === "win32") {
            // Windows Terminal when present (beautiful Thai fonts; a NEW
            // window, default-profile fonts), classic conhost as fallback.
            // --suppressApplicationTitle LOCKS the title: it's how hide/resume
            // finds exactly OUR window — WT shares one process across every
            // window, so titles are the only safe handle.
            const line = HAS_WT
              ? `/c start "" "${WT_EXE}" -w new new-tab --title "${title}" --suppressApplicationTitle -d "${dir}" powershell -NoLogo -NoExit -ExecutionPolicy Bypass ${psCmd}`
              : `/c start "${title}" /D "${dir}" conhost.exe powershell -NoLogo -NoExit -ExecutionPolicy Bypass ${psCmd}`;
            spawn("cmd.exe", [line],
              { windowsVerbatimArguments: true, windowsHide: true, detached: true });
          } else if (process.platform === "darwin") {
            // macOS: Open a new terminal window in the project directory
            // We use AppleScript to ensure it opens a fresh window at the right path
            const script = `tell application "Terminal" to do script "cd '${dir}'"`;
            spawn("osascript", ["-e", script], { detached: true });
          }
        };
        if (mode === "folder") {
          const openCmd = process.platform === "win32" ? "explorer" : "open";
          spawn(openCmd, [dir], { detached: true });
        } else if (mode === "shell") {
          // Plain shell, no marker — not counted as "project open".
          launch("", path.basename(dir));
        } else if (id in projWin) {
          // ONE window per project, always: if it exists (even hidden),
          // surface THAT — never spawn a second one on top of it.
          winproj("show", id, () => sweepProjects());
        } else {
          // LOCK (one occupant at a time): while an agent is working inside this
          // project you can't open it — opening would fork its live session. Stop
          // the agent (⏹) to take over, or wait for it to finish. The reverse
          // also holds: an agent won't be dispatched into a project you have open.
          if ((projRuns[id] || 0) > 0) {
            res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
            return res.end("agent กำลังทำงานในโปรเจคนี้อยู่ — กด ⏹ หยุดก่อนเพื่อเข้าไปดู/ทำเอง หรือรอจนงานเสร็จ");
          }
          ensureTrusted(dir);  // no trust dialog ambush in the new window
          // Smart entry: resume the NEWEST session explicitly — straight into
          // where the work happened. Fresh claude only when there's no session.
          const sid = newestSid(dir);
          const cmd = sid ? `claude --resume ${sid}` : "claude";
          launch(`-Command "${cmd} #BAGIDEA_PROJ_${id}"`, `BAGIDEA_PROJ_${id}`);
          setTimeout(sweepProjects, 2500);
        }
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && (req.url === "/projects/stop" ||
      req.url === "/projects/hide" || req.url === "/projects/resume")) {
    // ⏹ stop kills the window tree for real. 🫥 hide tucks the window away
    // while claude keeps working; ▶ resume brings the same window back.
    readBody(req, (body) => {
      try {
        const { id } = JSON.parse(body);
        const action = req.url.endsWith("stop") ? "stop"
          : req.url.endsWith("hide") ? "hide" : "show";
        winproj(action, String(id).replace(/[^\w-]/g, ""), () => {
          sweepProjects();
          // After a stop, confirm again once the window/process has fully gone —
          // an immediate sweep can still race the kill and re-flag it as open.
          if (action === "stop") setTimeout(sweepProjects, 1500);
        });
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/projects/stopwork") {
    // ⏹ Stop the AGENT working inside a project so the owner can take it over
    // (the lock's "stop to enter" path). Human-UI only.
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    readBody(req, (body) => {
      try {
        const { id } = JSON.parse(body);
        const set = projChildren[id];
        if (set) {
          for (const c of set) {
            try {
              if (process.platform === "win32")
                spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true });
              else c.kill("SIGKILL");
            } catch {}
          }
        }
        // Clear the lock immediately; the children's close handlers also settle it.
        projChildren[id] = new Set();
        projRuns[id] = 0;
        projAgents[id] = {};
        broadcast({ type: "projects.changed" }, false);
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url.startsWith("/fs")) {
    // Directory listing for the in-house folder picker (Blender-style UI in
    // the overlay — no off-theme Windows dialogs).
    {
      const q = new URL(req.url, "http://x").searchParams;
      let dir = q.get("dir") || "";
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ":\\";
        try { if (fs.existsSync(d)) drives.push(d); } catch {}
      }
      if (!dir) dir = drives.includes("D:\\") ? "D:\\" : drives[0] || "C:\\";
      let dirs = [];
      try {
        dirs = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") &&
            !e.name.startsWith("$"))
          .map((e) => e.name).sort((a, b) => a.localeCompare(b));
      } catch {}
      const parent = path.dirname(dir);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ path: dir, parent: parent === dir ? null : parent,
        dirs, drives }));
    }

  } else if (req.method === "POST" && req.url === "/fs/mkdir") {
    readBody(req, (body) => {
      try {
        const { dir, name } = JSON.parse(body);
        const n = String(name || "").trim().replace(/[<>:"/\\|?*]/g, "");
        if (!dir || !n) throw new Error("need dir + name");
        fs.mkdirSync(path.join(dir, n));
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/places") {
    readBody(req, (body) => {
      try {
        const { name, folder, remove } = JSON.parse(body);
        const n = String(name || "").trim().slice(0, 40);
        if (!n) throw new Error("no name");
        if (remove) delete reg.places[n];
        else {
          if (!folder) throw new Error("no folder");
          reg.places[n] = String(folder).trim();
        }
        saveReg();
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/jobs") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ jobs }));

  } else if (req.method === "POST" && req.url === "/jobs") {
    // Create a standing work order: now / at (one-shot or daily) / every N.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        if (!p.agent || !reg.agents[p.agent] || p.agent === "ceo") throw new Error("bad agent");
        if (!p.prompt) throw new Error("no prompt");
        const job = {
          id: "j" + Date.now(),
          agent: p.agent,
          prompt: String(p.prompt).slice(0, 4000),
          mode: ["now", "at", "every"].includes(p.mode) ? p.mode : "now",
          at: Number(p.at) || 0,
          time: String(p.time || "").slice(0, 5),
          daily: !!p.daily,
          everyMin: Math.max(5, Number(p.everyMin) || 10),  // floor: 5 min
          enabled: true,
          created: Date.now(),
        };
        jobs.push(job);
        saveJobs();
        if (job.mode === "now") dispatchJob(job);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: job.id }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/jobs/update") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const job = jobs.find((j) => j.id === p.id);
        if (!job) { res.writeHead(404); return res.end("unknown job"); }
        if (p.remove) {
          jobs = jobs.filter((j) => j.id !== p.id);
        } else {
          if (p.enabled !== undefined) job.enabled = !!p.enabled;
          if (typeof p.prompt === "string" && p.prompt.trim()) job.prompt = p.prompt.slice(0, 4000);
          if (p.agent && reg.agents[p.agent] && p.agent !== "ceo") job.agent = p.agent;
          if (p.everyMin !== undefined) job.everyMin = Math.max(5, Number(p.everyMin) || 10);
          if (typeof p.time === "string") job.time = p.time.slice(0, 5);
          if (p.daily !== undefined) job.daily = !!p.daily;
          if (p.at !== undefined) job.at = Number(p.at) || 0;
          // Re-scheduling a one-time 'at' that already fired re-arms it.
          if (p.at !== undefined || p.time !== undefined) { job.lastRun = 0; delete job.lastDay; }
        }
        saveJobs();
        broadcast({ type: "jobs.changed" }, false);
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/office-md") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    try { res.end(fs.readFileSync(OFFICE_MD, "utf8")); } catch { res.end(""); }

  } else if (req.method === "POST" && req.url === "/office-md") {
    readBody(req, (body) => {
      try {
        const { text } = JSON.parse(body);
        fs.writeFileSync(OFFICE_MD, String(text || "").slice(0, 64000));
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/notes") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ notes }));

  } else if (req.method === "POST" && req.url === "/notes") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        if (p.remove) notes = notes.filter((n) => n.id !== p.remove);
        else if (p.edit) {
          const n = notes.find((x) => x.id === p.edit);
          if (!n) throw new Error("note not found");
          const txt = String(p.text || "").trim().slice(0, 500);
          if (!txt) throw new Error("empty");
          n.text = txt;  // keep id/who/ts so the note stays in place
        }
        else if (p.text) notes.push({ id: "n" + Date.now(), who: p.who || "you",
          text: String(p.text).slice(0, 500), ts: Date.now() });
        else throw new Error("no text");
        saveNotes();
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/calendar") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ cal }));

  } else if (req.method === "POST" && req.url === "/calendar") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        if (p.remove) cal = cal.filter((c) => c.id !== p.remove);
        else if (p.edit) {
          const c = cal.find((x) => x.id === p.edit);
          if (!c) throw new Error("not found");
          if (p.title) c.title = String(p.title).slice(0, 120);
          if (p.at) { const at = Number(p.at) || Date.parse(p.at); if (at) { c.at = at; c.notified = false; } }
          if (p.remindMin !== undefined) c.remindMin = Math.max(1, Number(p.remindMin) || 10);
        } else {
          const at = Number(p.at) || Date.parse(p.at);
          if (!p.title || !at) throw new Error("need title + at");
          cal.push({ id: "c" + Date.now(), title: String(p.title).slice(0, 120),
            at, remindMin: Math.max(1, Number(p.remindMin) || 10), notified: false });
        }
        saveCal();
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/registry/key") {
    // 🔑 API key vault: ENV_NAME → value, injected into every agent run's
    // environment (OPENAI_API_KEY, GEMINI_API_KEY, …). Agents are told the
    // NAMES via projectNote; values live only in registry.json + env.
    readBody(req, (body) => {
      try {
        const { name, value, remove } = JSON.parse(body);
        const n = String(name || "").trim().toUpperCase()
          .replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
        if (!n) throw new Error("no name");
        if (remove) delete reg.apiKeys[n];
        else {
          if (!value) throw new Error("no value");
          reg.apiKeys[n] = String(value).trim().slice(0, 500);
        }
        saveReg();
        pushRoster();   // feature gates flip live in every client
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/registry/channel") {
    // 🔗 channel connector config — saving restarts the connectors live.
    readBody(req, (body) => {
      try {
        const { kind, config } = JSON.parse(body);
        if (!["telegram", "discord", "line"].includes(kind)) throw new Error("bad kind");
        reg.channels[kind] = {
          enabled: !!(config && config.enabled),
          token: String((config && config.token) || "").trim().slice(0, 300),
          chat: String((config && config.chat) || "").trim().slice(0, 80),
          channel: String((config && config.channel) || "").trim().slice(0, 80),
          secret: String((config && config.secret) || "").trim().slice(0, 200),
        };
        saveReg();
        channels.restart();
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/upload") {
    // 📎 chat attachments → workspace/uploads (agents Read them by path).
    readBodyRaw(req, (buf) => {
      try {
        if (!buf.length) throw new Error("empty file");
        if (buf.length > 80 * 1024 * 1024) throw new Error("ไฟล์ใหญ่เกิน 80MB");
        const raw = decodeURIComponent(String(req.headers["x-file-name"] || "file.bin"));
        const safe = raw.replace(/[^\w.ก-๙ -]/g, "_").slice(-80);
        const dir = path.join(WORKSPACE, "uploads");
        fs.mkdirSync(dir, { recursive: true });
        const name = Date.now() + "_" + safe;
        const full = path.join(dir, name);
        fs.writeFileSync(full, buf);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ path: full, url: "/uploads/" + encodeURIComponent(name), name: safe }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url.startsWith("/uploads/")) {
    const name = decodeURIComponent(req.url.slice(9).split("?")[0]).replace(/[\\/]|\.\./g, "");
    serveMedia(res, path.join(WORKSPACE, "uploads", name), req);

  } else if (req.method === "GET" && req.url.startsWith("/media?")) {
    // Render agent-produced media in chat: absolute path, but ONLY under the
    // workspace or a registered project (img tags can't send auth headers —
    // the path allowlist is the guard; daemon binds to localhost anyway).
    const p = new URL(req.url, "http://x").searchParams.get("p") || "";
    const norm = path.resolve(p);
    const roots = [path.resolve(WORKSPACE), ...projects.map((x) => path.resolve(x.dir))];
    if (!roots.some((r) => norm.toLowerCase().startsWith(r.toLowerCase() + path.sep))) {
      res.writeHead(403); return res.end("outside allowed roots");
    }
    serveMedia(res, norm, req);

  } else if (req.method === "POST" && req.url === "/reveal") {
    // Open the OS file manager at a file (like LINE/other messengers). UI-only,
    // and the target must live under the workspace or a registered project.
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    readBody(req, (body) => {
      try {
        let p = String((JSON.parse(body) || {}).path || "");
        if (p.startsWith("/uploads/"))
          p = path.join(WORKSPACE, "uploads", decodeURIComponent(p.slice(9)).replace(/[\\/]|\.\./g, ""));
        p = path.resolve(p);
        const roots = [path.resolve(WORKSPACE), ...projects.map((x) => path.resolve(x.dir))];
        const ok = roots.some((r) => p.toLowerCase() === r.toLowerCase() ||
          p.toLowerCase().startsWith(r.toLowerCase() + path.sep));
        if (!ok) { res.writeHead(403); return res.end("outside allowed roots"); }
        if (!fs.existsSync(p)) { res.writeHead(404); return res.end("not found"); }
        // explorer needs "/select," and the path as ONE argument or it ignores
        // the selection and opens Documents. spawn passes argv as-is (no shell),
        // so a single combined token is the reliable form (spaces included).
        if (process.platform === "win32") spawn("explorer.exe", ["/select," + p], { detached: true });
        else if (process.platform === "darwin") spawn("open", ["-R", p], { detached: true });
        else spawn("xdg-open", [path.dirname(p)], { detached: true });
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/open") {
    // Open a file in the OS default app (image viewer, player, browser) — a real
    // separate, resizable window. Same UI-only + allowlist guard as /reveal.
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    readBody(req, (body) => {
      try {
        let p = String((JSON.parse(body) || {}).path || "");
        if (p.startsWith("/uploads/"))
          p = path.join(WORKSPACE, "uploads", decodeURIComponent(p.slice(9)).replace(/[\\/]|\.\./g, ""));
        p = path.resolve(p);
        const roots = [path.resolve(WORKSPACE), ...projects.map((x) => path.resolve(x.dir))];
        const ok = roots.some((r) => p.toLowerCase() === r.toLowerCase() ||
          p.toLowerCase().startsWith(r.toLowerCase() + path.sep));
        if (!ok) { res.writeHead(403); return res.end("outside allowed roots"); }
        if (!fs.existsSync(p)) { res.writeHead(404); return res.end("not found"); }
        if (process.platform === "win32") spawn("cmd", ["/c", "start", "", p], { detached: true, windowsHide: true });
        else if (process.platform === "darwin") spawn("open", [p], { detached: true });
        else spawn("xdg-open", [p], { detached: true });
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/layout") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    try { res.end(fs.readFileSync(LAYOUT_FILE, "utf8")); }
    catch { res.end(JSON.stringify({ items: [] })); }

  } else if (req.method === "GET" && req.url === "/assets") {
    // 🗂 imported model/image library — reusable across editor sessions.
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    try { res.end(fs.readFileSync(ASSETS_FILE, "utf8")); }
    catch { res.end(JSON.stringify({ assets: [] })); }

  } else if (req.method === "POST" && req.url === "/assets") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        let assets = [];
        try { assets = JSON.parse(fs.readFileSync(ASSETS_FILE, "utf8")).assets || []; } catch {}
        if (p.remove) assets = assets.filter((a) => a.path !== p.remove);
        else {
          const path_ = String(p.path || "").trim();
          const kind = p.kind === "image" ? "image" : "model";
          if (!path_) throw new Error("no path");
          if (!assets.some((a) => a.path === path_))
            assets.push({ path: path_, kind, name: path_.split(/[\\/]/).pop(), ts: Date.now() });
        }
        fs.writeFileSync(ASSETS_FILE, JSON.stringify({ assets }, null, 1));
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/presets") {
    // custom layout presets the user saved from the 3D editor (defaults live
    // in the editor itself).
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    try { res.end(fs.readFileSync(PRESETS_FILE, "utf8")); }
    catch { res.end(JSON.stringify({ presets: [] })); }

  } else if (req.method === "POST" && req.url === "/presets") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        let presets = [];
        try { presets = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8")).presets || []; } catch {}
        if (p.remove) presets = presets.filter((x) => x.name !== p.remove);
        else {
          const name = String(p.name || "").trim().slice(0, 40);
          if (!name || !Array.isArray(p.items)) throw new Error("need name + items");
          presets = presets.filter((x) => x.name !== name);  // overwrite same name
          presets.push({ name, items: p.items.slice(0, 500), ts: Date.now() });
        }
        fs.writeFileSync(PRESETS_FILE, JSON.stringify({ presets }, null, 1));
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/layout") {
    // 🎨 Office Editor saves the whole layout; the world re-applies it live.
    readBody(req, (body) => {
      try {
        const j = JSON.parse(body);
        if (!Array.isArray(j.items)) throw new Error("items must be an array");
        const out = { items: j.items.slice(0, 500) };
        if (Array.isArray(j.rooms)) out.rooms = j.rooms.slice(0, 64);  // jigsaw room arrangement
        if (Array.isArray(j.ghost) && j.ghost.length === 2) out.ghost = j.ghost.map(Number);  // ghost deck pos
        if (typeof j.billboard === "string" && j.billboard) out.billboard = j.billboard.slice(0, 400);  // custom sign image
        fs.writeFileSync(LAYOUT_FILE, JSON.stringify(out, null, 1));
        broadcast({ type: "layout.changed" }, false);
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/plugins") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ plugins: plugins.list() }));

  } else if (req.method === "POST" && req.url === "/plugins/reload") {
    plugins.load();
    broadcast({ type: "plugins.changed" }, false);
    res.writeHead(200); res.end("ok");

  } else if (req.method === "POST" && req.url === "/editor/open") {
    // 🎨 Ask the shell to open the editor — it shows its circular logo splash,
    // launches Godot tiny+cloaked behind it, and reveals when ready (the SAME
    // boot path as the wallpaper). Falls back to a direct launch if no shell.
    try {
      const tmp = require("os").tmpdir();
      try { fs.unlinkSync(path.join(tmp, "bagidea_editor_ready")); } catch {}
      fs.writeFileSync(path.join(tmp, "bagidea_editor_open_request"), String(Date.now()));
      // fallback: if the shell isn't running, launch directly after a beat
      const gdir = path.join(__dirname, "..", "godot");
      let godot = "";
      if (process.platform === "win32") {
        const branded = path.join(gdir, "bin", "BagIdeaOffice.exe");
        godot = fs.existsSync(branded) ? branded
          : (process.env.BAGIDEA_GODOT || "C:\\Program Files\\Godot\\Godot_v4.6.3-stable_win64.exe");
      } else if (process.platform === "darwin") {
        const app = path.join(gdir, "bin-mac", "Godot.app", "Contents", "MacOS", "Godot");
        godot = fs.existsSync(app) ? app : "Godot";
      }
      const shellUp = fs.existsSync(path.join(tmp, "bagidea_shell_alive"));
      if (!shellUp && fs.existsSync(godot)) {
        spawn(godot, ["--path", gdir, "--", "--editor3d"],
          { detached: true, stdio: "ignore", windowsHide: false }).unref();
      }
      broadcast({ type: "editor.opening" }, false);
      res.writeHead(200); res.end("ok");
    } catch (e) { res.writeHead(500); res.end(String(e.message)); }

  } else if (req.method === "POST" && req.url === "/plugins/install") {
    // 📦 one-click install: git clone a plugin repo into plugins/ then reload.
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
        let url = String(JSON.parse(body).url || "").trim();
        if (!/^https:\/\/(github\.com|gitlab\.com|[\w.-]+)\/[\w.\-/]+$/.test(url))
          throw new Error("ใส่ลิงก์ git repo ที่ขึ้นต้น https:// ของ plugin");
        if (!url.endsWith(".git")) url += ".git";
        // Clone into a temp folder first, then move it to plugins/<id> using
        // the id from its OWN manifest — so the install folder always matches
        // the plugin id (remove + core protection look it up by id).
        const pluginsRoot = path.join(__dirname, "..", "plugins");
        const tmp = path.join(pluginsRoot, ".installing-" + Date.now());
        const { execFile } = require("child_process");
        execFile("git", ["clone", "--depth", "1", url, tmp], { timeout: 60000 }, (e) => {
          const fail = (msg) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end(msg); };
          if (e || !fs.existsSync(path.join(tmp, "plugin.json")))
            return fail(e ? "clone ไม่สำเร็จ: " + e.message : "repo นี้ไม่มี plugin.json — ไม่ใช่ plugin ที่ถูกต้อง");
          let man = {}; try { man = JSON.parse(fs.readFileSync(path.join(tmp, "plugin.json"), "utf8")); } catch {}
          const repoName = url.split("/").pop().replace(/\.git$/, "");
          const id = String(man.id || repoName).replace(/[^\w-]/g, "");
          if (!id) return fail("plugin.json ไม่มี id ที่ถูกต้อง");
          const dest = path.join(pluginsRoot, id);
          if (fs.existsSync(dest)) return fail("มี plugin ชื่อนี้แล้ว: " + id);
          try { fs.renameSync(tmp, dest); } catch (err) { return fail("ติดตั้งไม่สำเร็จ: " + err.message); }
          plugins.load();
          broadcast({ type: "plugins.changed" }, false);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, name: id }));
        });
      } catch (e) { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/plugins/remove") {
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
        const id = String(JSON.parse(body).id || "").replace(/[^\w-]/g, "");
        const dir = path.join(__dirname, "..", "plugins", id);
        const manFile = path.join(dir, "plugin.json");
        if (!fs.existsSync(manFile)) throw new Error("ไม่พบ plugin");
        // Core plugins ship with the office and can't be uninstalled; only
        // plugins the user added (e.g. via GitHub) are removable.
        let man = {}; try { man = JSON.parse(fs.readFileSync(manFile, "utf8")); } catch {}
        if (man.core) throw new Error("plugin หลักลบไม่ได้");
        fs.rmSync(dir, { recursive: true, force: true });
        plugins.load();
        broadcast({ type: "plugins.changed" }, false);
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.url.startsWith("/plugin/") &&
      plugins.handleHttp(req, res, readBody, readBodyRaw)) {
    /* handled by a plugin */

  } else if (req.method === "POST" && req.url === "/registry/key/test") {
    // 🧪 verify a main key actually works (a tiny authenticated call).
    readBody(req, (body) => {
      try {
        const { name } = JSON.parse(body);
        const val = (reg.apiKeys || {})[name];
        if (!val) { res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ ok: false, msg: "ยังไม่ได้ตั้ง key" })); }
        const done = (ok, msg) => { res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok, msg })); };
        const https = require("https");
        if (name === "OPENAI_API_KEY") {
          const rq = https.request({ method: "GET", host: "api.openai.com", path: "/v1/models",
            headers: { authorization: "Bearer " + val } }, (rs) => {
            rs.resume();
            done(rs.statusCode === 200, rs.statusCode === 200 ? "ใช้งานได้ ✓" : "key ไม่ผ่าน (HTTP " + rs.statusCode + ")");
          });
          rq.setTimeout(12000, () => rq.destroy(new Error("timeout")));
          rq.on("error", (e) => done(false, e.message));
          rq.end();
        } else if (name === "GEMINI_API_KEY") {
          const rq = https.request({ method: "GET", host: "generativelanguage.googleapis.com",
            path: "/v1beta/models?key=" + val }, (rs) => {
            rs.resume();
            done(rs.statusCode === 200, rs.statusCode === 200 ? "ใช้งานได้ ✓" : "key ไม่ผ่าน (HTTP " + rs.statusCode + ")");
          });
          rq.setTimeout(12000, () => rq.destroy(new Error("timeout")));
          rq.on("error", (e) => done(false, e.message));
          rq.end();
        } else done(true, "ตั้งค่าแล้ว");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/features") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(featuresMap()));

  } else if (req.method === "GET" && req.url === "/version") {
    // Local vs latest-released version (the VERSION file on main).
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: APP_VERSION, latest: latestVersion,
      updateAvailable: semverGt(latestVersion, APP_VERSION) }));

  } else if (req.method === "GET" && req.url === "/startup") {
    // Is the app set to launch with Windows? (HKCU Run key, same one the tray
    // checkbox writes — so tray, CLI and settings stay in sync.)
    isAutostart((on) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ on }));
    });

  } else if (req.method === "POST" && req.url === "/startup") {
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    readBody(req, (body) => {
      try {
        const on = !!JSON.parse(body || "{}").on;
        setAutostart(on, (ok) => {
          res.writeHead(ok ? 200 : 500, { "content-type": "application/json" });
          res.end(JSON.stringify({ on: ok ? on : null }));
        });
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/stats") {
    // 📊 dashboard: last 7 days of run stats + live system facts.
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days.push({ day: d, ...(stats[d] || { runs: 0, done: 0, failed: 0, cost: 0, agents: {} }) });
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      days,
      uptimeSec: Math.floor(process.uptime()),
      clients: wsClients.size,
      pendingPerms: pendingPerms.size,
      jobs: jobs.filter((j) => !j.done && j.enabled !== false).length,
      notes: notes.length,
      events: cal.filter((c) => c.at > Date.now()).length,
      channels: channels.status(),
      features: featuresMap(),
      projects: projectStatus().map((p) => ({ name: p.name, ai: p.ai, open: p.open })),
    }));

  } else if (req.method === "GET" && req.url === "/channels/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(channels.status()));

  } else if (req.method === "POST" && req.url === "/channels/line/webhook") {
    // LINE Messaging API webhook — point your channel's webhook URL here
    // through a public HTTPS tunnel (e.g. cloudflared).
    readBodyRaw(req, (raw) => channels.lineWebhook(req, res, raw));

  } else if (req.method === "POST" && req.url === "/registry/heartbeat") {
    // Director overview cadence: 0 = off, otherwise minutes between passes.
    readBody(req, (body) => {
      try {
        reg.heartbeatMin = Math.max(0, Number(JSON.parse(body).min) || 0);
        saveReg();
        pushRoster();
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "POST" && req.url === "/registry/sound") {
    // World sound effects on/off (persisted + live ui.sound broadcast).
    readBody(req, (body) => {
      try {
        reg.sound = !!JSON.parse(body).enabled;
        saveReg();
        pushRoster();
        broadcast({ type: "ui.sound", on: reg.sound });
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "POST" && req.url === "/registry/autoskills") {
    readBody(req, (body) => {
      try {
        reg.autoSkills = !!JSON.parse(body).enabled;
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "POST" && req.url === "/registry/role") {
    readBody(req, (body) => {
      try {
        const { name, remove } = JSON.parse(body);
        const n = String(name || "").trim().slice(0, 40);
        if (!n) throw new Error("no name");
        if (remove) reg.roles = reg.roles.filter((r) => r !== n);
        else if (!reg.roles.includes(n)) reg.roles.push(n);
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/assist/prompt") {
    // ✨ Persona copilot: the owner types a one-line brief ("UI designer who
    // sweats microcopy") and a quick claude call drafts the whole persona —
    // AND picks the skills + tools that fit the role from what's available.
    readBody(req, async (body) => {
      try {
        const { name = "Agent", role = "Specialist", brief = "" } = JSON.parse(body);
        const skillMenu = Object.entries(reg.skills)
          .map(([id, s]) => `  ${id}: ${s.description || s.name || id}`).join("\n");
        const toolMenu = Object.entries(BUILTIN_TOOLS)
          .map(([id, d]) => `  ${id}: ${d}`).join("\n");
        const skillIds = Object.keys(reg.skills);
        const toolIds = Object.keys(BUILTIN_TOOLS);
        const draft = await claudeText(
          `Design a complete persona for an AI agent in a software office, and ` +
          `pick the skills + tools that fit its job.\n` +
          `Agent name: ${name}\nJob title: ${role}\nOwner's brief: ${brief}\n\n` +
          `Available SKILLS (pick by id, only ones that truly fit the role):\n${skillMenu}\n\n` +
          `Available TOOLS (pick by exact name, only what the job needs — fewer is better; ` +
          `a manager/coordinator needs very few, a builder needs more):\n${toolMenu}\n\n` +
          `Output STRICT JSON only (no markdown fences):\n` +
          `{"prompt":"core mission & identity, second person, 3-6 sentences",` +
          `"expertise":"bullet-ish lines: concrete skills, tools, domains they own",` +
          `"personality":"tone of voice, character quirks, how they talk",` +
          `"language":"primary reply language, e.g. ไทย / English / ตามผู้ใช้",` +
          `"rules":"3-6 imperative work rules (do/don't), one per line",` +
          `"skills":["skill-id", ...],` +
          `"tools":["ToolName", ...]}\n` +
          `Every field must genuinely reflect the brief. skills/tools MUST be chosen ` +
          `ONLY from the lists above (exact ids/names). Match the brief's language ` +
          `(Thai brief → Thai text fields; skill ids and tool names stay verbatim).`);
        let out = { prompt: draft };
        const m = draft.match(/\{[\s\S]*\}/);
        if (m) try { out = JSON.parse(m[0]); } catch {}
        // Keep only ids/names that actually exist — never invent capabilities.
        if (Array.isArray(out.skills)) out.skills = out.skills.filter((s) => skillIds.includes(s));
        if (Array.isArray(out.tools)) out.tools = out.tools.filter((t) => toolIds.includes(t));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/ui/daylight") {
    // Manual atmosphere override for the world ("auto" follows the clock).
    // Persisted in the registry + carried on roster.sync, so the choice
    // survives renderer restarts/reconnects (journal replay alone is bounded by
    // REPLAY_COUNT and silently scrolls the pick out on a busy office).
    readBody(req, (body) => {
      try {
        const { hour = "auto" } = JSON.parse(body || "{}");
        reg.daylight = hour;
        saveReg();
        broadcast({ type: "ui.daylight", hour }, false);
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "POST" && req.url === "/ui/monitor") {
    // Which monitor the wallpaper runs on (multi-monitor). The shell reads
    // daemon/monitor.txt at attach time (0 = primary); applies on next restart.
    readBody(req, (body) => {
      try {
        const idx = Math.max(0, parseInt(JSON.parse(body || "{}").index, 10) || 0);
        reg.monitor = idx;
        saveReg();
        fs.writeFileSync(path.join(__dirname, "monitor.txt"), String(idx));
        broadcast({ type: "ui.monitor", index: idx }, false);
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "GET" && req.url === "/workflows") {
    const dir = path.join(WORKSPACE, "workflows");
    let list = [];
    try {
      list = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
        try { const w = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          return { id: f.replace(/\.json$/, ""), name: w.name || f, nodes: (w.nodes || []).length }; }
        catch { return null; }
      }).filter(Boolean);
    } catch {}
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(list));

  } else if (req.method === "GET" && req.url.startsWith("/workflows/get")) {
    const id = (new URL(req.url, "http://x").searchParams.get("id") || "").replace(/[^\w-]/g, "");
    try { res.writeHead(200, { "content-type": "application/json" });
      res.end(fs.readFileSync(path.join(WORKSPACE, "workflows", id + ".json"))); }
    catch { res.writeHead(404); res.end("{}"); }

  } else if (req.method === "POST" && req.url === "/workflows/save") {
    readBody(req, (body) => { try {
      const w = JSON.parse(body || "{}");
      const id = String(w.id || ("wf_" + Date.now())).replace(/[^\w-]/g, "");
      const dir = path.join(WORKSPACE, "workflows"); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id + ".json"),
        JSON.stringify({ id, name: w.name || "Workflow", nodes: w.nodes || [], edges: w.edges || [] }, null, 2));
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id }));
    } catch (e) { res.writeHead(400); res.end(String(e.message)); } });

  } else if (req.method === "POST" && req.url === "/workflows/delete") {
    readBody(req, (body) => { try {
      const id = String(JSON.parse(body || "{}").id || "").replace(/[^\w-]/g, "");
      if (id) fs.unlinkSync(path.join(WORKSPACE, "workflows", id + ".json"));
    } catch {} res.writeHead(200); res.end("ok"); });

  } else if (req.method === "POST" && req.url === "/workflows/analyze") {
    // The Director reads the human-language workflow and returns a plan (which
    // skills/tools/agents/permissions it needs). P1: plan only, never auto-runs.
    readBody(req, (body) => { try {
      const w = JSON.parse(body || "{}");
      queueDirectorTurn((release) => {
        runClaude("main", WORKFLOW_ANALYZE_PROMPT + "\n\n" + workflowToText(w), {
          logPrompt: "🔀 วิเคราะห์ workflow: " + (w.name || ""),
          onDone: (out, ok) => {
            release();
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: !!ok, analysis: ok && out ? out : "วิเคราะห์ไม่สำเร็จ ลองใหม่อีกครั้ง" }));
          },
        });
      });
    } catch (e) { res.writeHead(400); res.end(String(e.message)); } });

  } else if (req.method === "POST" && req.url === "/event") {
    readBody(req, (body) => {
      try {
        const evt = JSON.parse(body);
        // Hook events from the host Claude Code session arrive as "claude" —
        // that IS the Director: map them onto main (no ghost duplicate).
        if (evt.agent === "claude") evt.agent = "main";
        // Transient UI state (visibility) must never replay from the journal.
        broadcast(evt, evt.type !== "ui.visibility");
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "POST" && req.url === "/perm/request") {
    // PreToolUse hook long-polls here; we answer when the user decides.
    readBody(req, (body) => {
      let p;
      try { p = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      let { id, agent = "claude", task = "", tool = "?", input = "" } = p;
      if (agent === "claude") agent = "main";  // host session = the Director
      // Tools the owner GRANTED in the agent's registry profile never ask —
      // that's what granting means. "Allow ตลอดไป" rules ride along too.
      const base = String(agent).split("#")[0];
      const granted = [
        ...(((reg.agents[base] || {}).tools) || []),
        ...(((reg.autoAllow || {})[base]) || []),
      ];
      const isGranted = granted.includes(tool) ||
        // MCP grants are stored as "mcp:<server>"; hook tool names arrive
        // as "mcp__<server>__<tool>".
        granted.some((g) => g.startsWith("mcp:") &&
          String(tool).startsWith("mcp__" + g.slice(4) + "__"));
      if (isGranted) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ decision: "allow" }));
        broadcast({ type: "perm.approved", agent, task, tool, perm: id, via: "rule" });
        return;
      }
      broadcast({ type: "perm.requested", agent, task, tool, perm: id, input });
      const timer = setTimeout(() => {
        // No human around — deny safely and let the agent re-plan.
        finishPerm(id, "deny", "timeout");
      }, 50000);
      pendingPerms.set(id, { res, timer, agent, task, tool });
    });

  } else if (req.method === "POST" && req.url === "/perm/respond") {
    readBody(req, (body) => {
      try {
        const { id, decision, always } = JSON.parse(body);
        // "Allow ตลอดไป": remember the grant — broker auto-approves future
        // requests AND the tool joins the agent's allowlist for new runs.
        if (always && decision === "allow") {
          const pend = pendingPerms.get(id);
          if (pend) {
            const base = String(pend.agent).split("#")[0];
            reg.autoAllow = reg.autoAllow || {};
            reg.autoAllow[base] = [...new Set([...(reg.autoAllow[base] || []), pend.tool])];
            const a = reg.agents[base];
            if (a && Array.isArray(a.tools) && !a.tools.includes(pend.tool))
              a.tools.push(pend.tool);
            saveReg();
            pushRoster();
          }
        }
        const ok = finishPerm(id, decision === "allow" ? "allow" : "deny", "user");
        res.writeHead(ok ? 200 : 404);
        res.end(ok ? "ok" : "unknown id");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "POST" && req.url === "/gen/image") {
    // 🖼 system tool: prompt → PNG path (+ /uploads url for chat rendering).
    readBody(req, (body) => {
      try {
        const { prompt } = JSON.parse(body);
        if (!prompt) throw new Error("no prompt");
        genImage(prompt).then((out) => {
          broadcast({ type: "image.generated", url: out.url }, false);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(out));
        }).catch((e) => {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(String(e.message));
        });
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/proposals") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ proposals: proposals.slice(-30).reverse() }));

  } else if (req.method === "POST" && req.url === "/proposals/respond") {
    // CEO verdict on a team pitch: approve → a real project is born in the
    // playground and the Director staffs it; reject/hold are remembered.
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
        const { id, decision, message } = JSON.parse(body);
        const p = proposals.find((x) => x.id === id);
        if (!p) { res.writeHead(404); return res.end("unknown proposal"); }
        p.status = decision === "approve" ? "approved"
          : decision === "reject" ? "rejected" : "pending";
        const note = String(message || "").slice(0, 600).trim();   // owner's optional note
        if (note) p.message = note;
        saveProposals();
        const noteLine = note ? `เจ้าของฝากข้อความ: "${note}"\n` : "";
        if (decision === "approve") {
          let proj = null;
          // Approved projects are born in a DEFAULT projects folder (the
          // playground) when no location was given — agents never scaffold loose.
          const playDir = String(reg.playground || path.join(WORKSPACE, "projects"));
          try {
            proj = createProject(p.name, "", path.join(playDir, p.name.replace(/[^\wก-๙ -]/g, "_")));
          } catch (e) { /* duplicate name → Director routes to the existing one */ }
          queueDirectorTurn((release) => {
            runClaude("main",
              `CEO อนุมัติข้อเสนอโปรเจคของทีมแล้ว 🎉\n` +
              `ชื่อ: ${p.name}\nไอเดีย: ${p.detail}\nผู้เสนอ: ${p.agents.join(", ")}\n` + noteLine +
              (proj ? `โปรเจคถูกสร้างไว้แล้วที่ ${proj.dir} (ทำงานในโฟลเดอร์นี้เท่านั้น)\n` : "") +
              `กติกา: ห้ามแก้ไขระบบหลักของโปรแกรม (daemon/godot/shell/cli) เด็ดขาด — ` +
              `ถ้าเป็นการต่อยอดออฟฟิศ ให้ทำเป็น plugin ตาม docs/guide/plugins.md ` +
              `(เริ่มจาก template: github.com/bagidea/bagidea-office-template).\n` +
              `จัดทีมเลย: DELEGATE: <agent> @ ${p.name} :: <งานชิ้นแรกที่ชัดเจน> ` +
              `ให้คนที่เสนอไอเดียได้ทำเป็นหลัก แล้วสรุปแผนสั้นๆ` +
              (note ? ` และนำข้อความของเจ้าของไปปรับทิศทางงานด้วย` : ""),
              { logPrompt: `✅ อนุมัติข้อเสนอ: ${p.name}`,
                filterText: makeDelegateFilter(0, undefined),
                onDone: () => release() });
          });
        } else if (decision === "reject" && note) {
          // The team hears WHY — the owner's note lands in the office feed.
          broadcast({ type: "chat.message", agent: "main",
            text: `CEO ยังไม่อนุมัติ "${p.name}" — ${note}` });
        }
        broadcast({ type: "proposal." + p.status, agent: p.by, name: p.name, proposal: p.id });
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url.split("?")[0] === "/i18n/all") {
    // The whole cached map for a language (seed + anything translated since).
    // The overlay pulls this once on load so tr() knows every seeded string up
    // front — no first-switch Thai flash, and strings in NO_I18N subtrees (the
    // now-strip chrome) can be translated inline too.
    const L = String((req.url.split("?")[1] || "").replace(/^lang=/, "")).toLowerCase();
    let map = {};
    if (L && L !== "th" && /^[a-z]{2}$/.test(L)) {
      try { map = JSON.parse(fs.readFileSync(path.join(__dirname, "i18n", L + ".json"), "utf8")); } catch {}
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ map }));

  } else if (req.method === "POST" && req.url === "/i18n") {
    // 🌐 auto-translate UI strings to any language via Gemini, cached to
    // disk (daemon/i18n/<lang>.json) so it's instant + shared next time.
    // The overlay sends the Thai strings it finds on screen; we return the
    // full map for those, translating only the ones not yet cached.
    readBody(req, (body) => {
      try {
        const { lang, strings } = JSON.parse(body);
        const L = String(lang || "").toLowerCase();
        if (!L || L === "th" || !Array.isArray(strings)) { res.writeHead(400); return res.end("bad"); }
        const dir = path.join(__dirname, "i18n");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, L + ".json");
        let cache = {};
        try { cache = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
        const want = [...new Set(strings.map((s) => String(s)).filter((s) => s && s.length <= 400))];
        const missing = want.filter((s) => !(s in cache));
        const reply = () => {
          const out = {};
          for (const s of want) if (cache[s] !== undefined) out[s] = cache[s];
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ map: out }));
        };
        // Reply with whatever's cached RIGHT NOW — never make the overlay wait
        // on a slow Gemini call for a handful of uncached strings. That used to
        // block the WHOLE batch, so switching language flashed Thai for seconds
        // even when ~everything was already seeded. The misses translate in the
        // background (cached to disk); the overlay's ~1.5s janitor sweep re-asks
        // and picks them up the moment they're ready.
        reply();
        const gm = (reg.apiKeys || {}).GEMINI_API_KEY;
        if (!missing.length || !gm) return;
        const langName = { en: "English", zh: "Simplified Chinese", ja: "Japanese",
          ko: "Korean", es: "Spanish", fr: "French", de: "German", hi: "Hindi",
          ar: "Arabic", pt: "Portuguese", ru: "Russian", id: "Indonesian",
          vi: "Vietnamese" }[L] || L;
        // batch in chunks to keep prompts sane
        const chunks = [];
        for (let i = 0; i < missing.length; i += 60) chunks.push(missing.slice(i, i + 60));
        let pending = chunks.length;
        const finish = () => { if (--pending <= 0) {
          try { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, file); } catch {}
        } };
        for (const chunk of chunks) {
          const prompt = `Translate these UI strings from Thai to ${langName}. ` +
            `Keep emoji, symbols, numbers, code and placeholders (like \${...}, <...>) EXACTLY. ` +
            `Natural, concise product-UI wording. Return ONLY a JSON object mapping each ` +
            `original string to its translation.\n\n` + JSON.stringify(chunk);
          const reqBody = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
          });
          const rq = require("https").request({
            method: "POST", host: "generativelanguage.googleapis.com",
            path: "/v1beta/models/gemini-flash-latest:generateContent?key=" + gm,
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(reqBody) },
          }, (rs) => {
            let o = ""; rs.on("data", (c) => (o += c));
            rs.on("end", () => {
              try {
                const j = JSON.parse(o);
                const txt = j.candidates && j.candidates[0] &&
                  j.candidates[0].content.parts.map((p) => p.text || "").join("");
                const m = JSON.parse(txt.match(/\{[\s\S]*\}/)[0]);
                for (const k of chunk) if (m[k] !== undefined) cache[k] = String(m[k]);
                auxCost("gemini", chunk.join("").length * COST_RATES.gemini_i18n_per_char);
              } catch (e) { console.error("[i18n]", e.message); }
              finish();
            });
          });
          rq.setTimeout(40000, () => { rq.destroy(); finish(); });
          rq.on("error", () => finish());
          rq.write(reqBody); rq.end();
        }
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/registry/lang") {
    readBody(req, (body) => {
      try {
        reg.lang = String(JSON.parse(body).lang || "en").slice(0, 5).toLowerCase();
        saveReg();
        pushRoster();
        // Tell the wallpaper world to re-pull its status-plate translations so
        // the 3D office matches the overlay's language live (transient — not
        // journaled; godot also reads the language on its own startup).
        broadcast({ type: "ui.lang", lang: reg.lang }, false);
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "POST" && req.url === "/registry/social") {
    readBody(req, (body) => {
      try {
        reg.socialMin = Math.max(0, Number(JSON.parse(body).min) || 0);
        saveReg();
        pushRoster();
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "POST" && req.url === "/registry/proposalmin") {
    readBody(req, (body) => {
      try {
        reg.proposalMin = Math.max(0, Number(JSON.parse(body).min) || 0);
        saveReg();
        pushRoster();
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "GET" && req.url === "/tts/presets") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(Object.fromEntries(
      Object.entries(VOICE_PRESETS).map(([id, p]) => [id, p.label]))));

  } else if (req.method === "POST" && req.url === "/tts") {
    // 🗣 speak: {text, preset} or {text, agent} (uses the agent's voice).
    // {intro:true} → a gender- + language-aware self-introduction (voice preview).
    readBody(req, (body) => {
      try {
        const { text, preset, agent, intro } = JSON.parse(body);
        const pid = preset || (reg.agents[agent] && reg.agents[agent].voice);
        if (!pid) throw new Error("agent นี้ยังไม่ได้ตั้งเสียง");
        const say = intro ? voiceIntro(pid, reg.lang || "en") : text;
        if (!say) throw new Error("no text");
        ttsSpeak(pid, say).then((wav) => {
          res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" });
          res.end(wav);
        }).catch((e) => {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(String(e.message));
        });
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/registry/tts") {
    readBody(req, (body) => {
      try {
        reg.tts = !!JSON.parse(body).enabled;
        saveReg();
        pushRoster();
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "POST" && req.url === "/voice/transcribe") {
    // 🎤 WAV in → text out (Whisper / Gemini via the key vault).
    readBodyRaw(req, (buf) => {
      if (!buf || buf.length < 4000) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        return res.end("เสียงสั้นเกินไป — กดค้างแล้วพูดให้จบก่อนปล่อย");
      }
      if (buf.length > 24 * 1024 * 1024) {
        res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
        return res.end("คลิปยาวเกินไป (จำกัด ~60 วินาที)");
      }
      voiceTranscribe(buf).then((text) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ text }));
      }).catch((e) => {
        console.error("[voice]", e.message);
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(String(e.message || e));
      });
    });

  } else if (req.method === "POST" && req.url === "/update") {
    // Human-triggered only (in-app 🔄 button or the CLI).
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    const ps = path.join(__dirname, "..", "installer", "update.ps1");
    // Launch in a REAL, visible console window via `cmd start` so the user can
    // watch git pull + the rebuild — a silent detached process looked hung. It
    // also outlives this daemon (the updater kills + relaunches the whole suite).
    spawn("cmd.exe", ["/c", "start", "BagIdea Update", "powershell",
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps],
      { detached: true, stdio: "ignore", windowsHide: false }).unref();
    res.writeHead(200); res.end("ok");

  } else if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ clients: wsClients.size, pendingPerms: pendingPerms.size,
      wt: HAS_WT }));

  } else {
    res.writeHead(404);
    res.end();
  }
});

function finishPerm(id, decision, why) {
  const p = pendingPerms.get(id);
  if (!p) return false;
  pendingPerms.delete(id);
  clearTimeout(p.timer);
  p.res.writeHead(200, { "content-type": "application/json" });
  p.res.end(JSON.stringify({ decision }));
  broadcast({
    type: decision === "allow" ? "perm.approved" : "perm.denied",
    agent: p.agent, task: p.task, tool: p.tool, perm: id, via: why,
  });
  return true;
}

// WS upgrade — renderers (Godot) and overlays share one stream.
// Parse masked client→server WS frames (the event stream never needed this;
// the realtime voice bridge does). Calls cb(opcode, payloadBuffer).
function makeFrameParser(cb) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const masked = !!(buf[1] & 0x80);
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload;
      if (masked) {
        const mask = buf.slice(off, off + 4);
        payload = Buffer.from(buf.slice(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      } else payload = buf.slice(off, off + len);
      buf = buf.slice(need);
      cb(op, payload);
    }
  };
}

// 📞 Realtime voice: bridge the overlay mic ⇄ Gemini Live, with the office's
// own knowledge in the system prompt and an agent's voice preset.
function handleLive(req, sock) {
  const key = req.headers["sec-websocket-key"];
  if (!key) return sock.destroy();
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
    "Connection: Upgrade\r\nSec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n");
  const toClient = (obj) => { try { sock.write(wsFrame(JSON.stringify(obj))); } catch {} };
  const gm = (reg.apiKeys || {}).GEMINI_API_KEY;
  if (!gm) { toClient({ type: "error", text: "ต้องมี GEMINI_API_KEY (⚙ CONNECT) สำหรับ realtime" }); return; }

  // Calling is for the MAIN agent only — it speaks for the whole office. Use the
  // voice the owner assigned to main; if none, fall back to a default preset.
  const a = reg.agents["main"] || {};
  const presetVoice = (VOICE_PRESETS[a.voice] || {}).voice || "Aoede";
  const ctxNote = (() => {
    try { return fs.readFileSync(OFFICE_MD, "utf8").slice(0, 2000); } catch { return ""; }
  })();
  const team = teamList();

  const gemini = require("./channels").wsConnect(
    "generativelanguage.googleapis.com",
    "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" + gm,
    {
      onOpen() {
        gemini.send(JSON.stringify({ setup: {
          model: "models/gemini-2.5-flash-native-audio-latest",
          generationConfig: { responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: presetVoice } } } },
          systemInstruction: { parts: [{ text:
            `คุณคือ "${a.name || "ผู้ช่วย"}" พนักงานใน BagIdea Office คุยกับเจ้าของแบบเป็นกันเอง ` +
            `ภาษาไทย กระชับ. ทีมงาน:\n${team}\nข้อมูลออฟฟิศ:\n${ctxNote}` }] },
        } }));
        toClient({ type: "ready" });
      },
      onMsg(raw) {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.setupComplete) return toClient({ type: "live-ready" });
        const parts = m.serverContent && m.serverContent.modelTurn &&
          m.serverContent.modelTurn.parts;
        if (parts) for (const p of parts) {
          if (p.inlineData && p.inlineData.data)
            toClient({ type: "audio", data: p.inlineData.data });  // 24k PCM base64
        }
        if (m.serverContent && m.serverContent.turnComplete) toClient({ type: "turn-done" });
      },
      onClose() { toClient({ type: "closed" }); try { sock.end(); } catch {} },
    });

  // overlay → us: text frames carry {type:'audio', data} (16k PCM base64).
  const parse = makeFrameParser((op, payload) => {
    if (op === 8) { try { gemini.close(); } catch {} return; }
    if (op !== 1) return;
    let m; try { m = JSON.parse(payload.toString("utf8")); } catch { return; }
    if (m.type === "audio") {
      gemini.send(JSON.stringify({ realtimeInput: { mediaChunks: [
        { mimeType: "audio/pcm;rate=16000", data: m.data }] } }));
    }
  });
  sock.on("data", parse);
  sock.on("close", () => { try { gemini.close(); } catch {} });
  sock.on("error", () => { try { gemini.close(); } catch {} });
}

server.on("upgrade", (req, sock) => {
  if (req.url.startsWith("/live")) return handleLive(req, sock);
  if (!req.url.startsWith("/ws")) return sock.destroy();
  const key = req.headers["sec-websocket-key"];
  if (!key) return sock.destroy();
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  wsClients.add(sock);
  console.log("[oep] ws client connected", `(${wsClients.size})`);
  sock.on("close", () => wsClients.delete(sock));
  sock.on("error", () => wsClients.delete(sock));
  sock.on("data", () => {}); // inbound frames (pings/close) — TCP close is enough
  // Journal replay so a restarted renderer/overlay rebuilds its state.
  for (const line of journalTail(REPLAY_COUNT)) {
    try {
      const evt = JSON.parse(line);
      evt.replay = true;
      sock.write(wsFrame(JSON.stringify(evt)));
    } catch {}
  }
  // Fresh roster snapshot last — registry.json is the truth, not the journal.
  sock.write(wsFrame(JSON.stringify({ ...rosterEvt(), ts: Date.now() })));
});

// Resilience: the office is an always-on daemon spawned by a console-less GUI
// shell, so a single stray exception (a bad scheduler tick, a malformed plugin
// event) must NOT take the whole office down. Log it and keep serving — the
// shell's watchdog can still restart us if we ever truly die.
process.on("uncaughtException", (e) => console.error("[fatal] uncaught:", e && e.stack || e));
process.on("unhandledRejection", (e) => console.error("[fatal] rejection:", e && e.stack || e));

server.on("error", (e) => {
  // Most likely EADDRINUSE — another daemon already holds :8787. Exit cleanly
  // (code 1) so the launcher/watchdog knows not to expect us, instead of a
  // cryptic unhandled-error crash.
  console.error("[fatal] server error:", e && e.message || e);
  process.exit(1);
});

const OEP_PORT = process.env.OEP_PORT || 8787;  // override only for isolated tests
server.listen(OEP_PORT, "127.0.0.1", () =>
  console.log(`[oep] http+ws listening :${OEP_PORT}`)
);
