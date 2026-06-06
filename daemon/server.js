// BagIdea AI Agents Office — daemon v3 (Layer 0).
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

const WORKSPACE = path.join(__dirname, "..", "workspace");
const OVERLAY = path.join(__dirname, "overlay.html");
const JOURNAL = path.join(__dirname, "journal.jsonl");
const REPLAY_COUNT = 80;

const wsClients = new Set();
const pendingPerms = new Map(); // id -> {res, timer, agent, tool}
let taskCounter = 0;

// ---------------------------------------------------------------- registry
// Persistent staff roster + roles (skills/tools libraries ride along).
// main = Claude, the undeletable Director; ceo = the human owner's avatar.

const REGISTRY = path.join(__dirname, "registry.json");
let reg;

// Built-in Claude Code tools: fixed catalog with human descriptions.
// These cannot be deleted — custom capability arrives as MCP servers.
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

function loadReg() {
  try { reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8")); } catch { reg = {}; }
  reg.agents = reg.agents || {};
  reg.apiKeys = reg.apiKeys || {};      // ENV_NAME → value (injected into runs)
  reg.channels = reg.channels || {};    // telegram/discord/line connector config
  reg.roles = reg.roles || ["Director", "Founder", "Researcher", "Engineer",
    "Designer", "Analyst", "Operator", "Specialist"];
  reg.skills = reg.skills || {};
  reg.tools = Object.keys(BUILTIN_TOOLS);
  reg.mcpServers = reg.mcpServers || {};
  reg.places = reg.places || {};  // shorthand locations: "ห้องสมุด" → folder
  if (!reg.agents.main) reg.agents.main = {
    name: "Claude", role: "Director", avatar: 7, protected: true,
    prompt: "You are Claude, the Director of this AI agents office. You run " +
      "operations, make the calls the owner has not reserved for themselves, " +
      "and delegate to the team when that serves the work better.",
    skills: [], tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
  };
  if (!reg.agents.ceo) reg.agents.ceo = {
    name: "CEO", role: "Founder", avatar: 8, protected: true, isUser: true,
    prompt: "", skills: [], tools: [],
  };
  saveReg();
}
function saveReg() { fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2)); }
loadReg();

// Live (not journaled): registry.json is the persistence; every WS client
// also gets a fresh snapshot on connect.
function rosterEvt() {
  return { type: "roster.sync", agents: reg.agents, roles: reg.roles,
    tools: reg.tools, builtinTools: BUILTIN_TOOLS, mcp: reg.mcpServers,
    skills: reg.skills, autoSkills: reg.autoSkills !== false,
    sound: reg.sound !== false, heartbeatMin: Number(reg.heartbeatMin || 0) };
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
async function maybeLearnSkill(agent, task, prompt, acts, finalText) {
  if (reg.autoSkills === false || acts.length < 3) return;
  const existing = Object.values(reg.skills).map((s) => s.name).join(", ") || "(none)";
  const out = await claudeText(
    `An AI office agent "${agent}" just completed a task.\n` +
    `Task prompt: ${String(prompt).slice(0, 600)}\n` +
    `Tools used in order: ${acts.join(" -> ")}\n` +
    `Final report: ${String(finalText).slice(0, 800)}\n\n` +
    `Existing skills: ${existing}\n\n` +
    `If this work contains a REUSABLE, GENERALIZABLE procedure not already ` +
    `covered by an existing skill, distill it. Output STRICT JSON only:\n` +
    `{"name":"short-kebab-name","description":"one line","content":"imperative ` +
    `step-by-step instructions, max 12 lines"}\n` +
    `If nothing is worth saving, output exactly: NONE`);
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return;
  try {
    const sk = JSON.parse(m[0]);
    if (!sk.name || !sk.content) return;
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
function latestSession(agent) {
  const l = sess[agent] || [];
  return l.length ? l.reduce((a, b) => (a.ts > b.ts ? a : b)) : null;
}

// Plain headless claude call → final text (prompt drafting, reflections).
function claudeText(prompt) {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p"], {
      cwd: WORKSPACE, shell: true,
      env: { ...process.env, ...(reg.apiKeys || {}), OFFICE_ADAPTER: "1" },
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
let jobs = loadJson(JOBS, []);    // {id, agent, prompt, mode, at, time, daily, everyMin, enabled, lastRun, lastDay, done, sessionKey}
let notes = loadJson(NOTES, []);  // {id, who, text, ts}
let cal = loadJson(CAL, []);      // {id, title, at, remindMin, notified}
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
      !Object.keys(reg.apiKeys || {}).length) return "";
  const keysLine = Object.keys(reg.apiKeys || {}).length
    ? `\nAPI keys ที่ตั้งค่าไว้ใน env ของคุณแล้ว (เรียกใช้ได้ทันที): ${Object.keys(reg.apiKeys).join(", ")}`
    : "";
  const list = projects.map((p) => `- ${p.name} → ${p.dir}`).join("\n") || "(ยังไม่มี)";
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
ต้องปิดให้หมดก่อนจบงาน — ห้ามทิ้งโปรเซสค้างไว้ในเครื่องผู้ใช้เด็ดขาด.${keysLine}
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
  if (job.mode === "now") job.done = true;
  saveJobs();
  broadcast({ type: "job.started", agent: job.agent, title: job.prompt.slice(0, 60), job: job.id });
  runClaude(job.agent, job.prompt, {
    session: job.sessionKey || "new",
    logPrompt: "📋 [งานที่สั่งไว้] " + job.prompt,
    onEntry: (key) => { job.sessionKey = key; saveJobs(); },
    onDone: () => {
      agentBusy.delete(job.agent);
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
function heartbeat() {
  lastHeartbeat = Date.now();
  const upcoming = cal.filter((c) => c.at > Date.now() && c.at < Date.now() + 12 * 3600000)
    .sort((a, b) => a.at - b.at).slice(0, 6)
    .map((c) => `- ${c.title} @ ${new Date(c.at).toLocaleString("th-TH")}`).join("\n") || "(ว่าง)";
  const standing = jobs.filter((j) => !j.done && j.enabled !== false).slice(0, 8)
    .map((j) => `- [${j.mode}] ${j.agent}: ${j.prompt.slice(0, 60)}`).join("\n") || "(ไม่มี)";
  const board = notes.slice(-8).map((n) => `- ${n.text}`).join("\n") || "(ว่าง)";
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
  let preamble = "";
  if (isFresh && a && (a.prompt || a.persona || (a.skills || []).length)) {
    preamble = `<persona>\nYou are "${a.name}" (${a.role}).\n${personaText(a)}\n`;
    for (const sid of a.skills || []) {
      const sk = reg.skills[sid];
      if (sk) preamble += `\n<skill name="${sk.name}">\n${sk.content}\n</skill>\n`;
    }
    preamble += `\nกระดานโน้ตกลางของออฟฟิศ: ไฟล์ notes.md ใน workspace — ` +
      `อ่านได้ และเพิ่มบรรทัด "- ข้อความ" เพื่อฝากโน้ตถึง CEO ได้\n`;
    preamble += "</persona>\n\n";
  }

  const args = ["-p", "--output-format", "stream-json", "--verbose",
    "--allowedTools", tools,
    // The permission-broker hooks live in the workspace settings; agents
    // now run inside PROJECT directories, so the settings must travel
    // explicitly or the Security Center goes silent.
    "--settings", path.join(WORKSPACE, ".claude", "settings.json")];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  if (entry && entry.sid) args.push("--resume", entry.sid);
  const child = spawn("claude", args, {
    cwd,
    shell: true,
    env: { ...process.env, ...(reg.apiKeys || {}), OFFICE_ADAPTER: "1", OFFICE_AGENT: agent, OFFICE_TASK: task },
  });
  // The split capability + project map ride on the wire only — never in
  // the chat log.
  const canSplit = !opts.noSub && !agent.includes("#");
  child.stdin.write(preamble + prompt + (canSplit ? SUB_NOTE : "") + projectNote());
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
        if (!m.is_error && subTasks.length) {
          doneFired = true;  // the synthesis run inherits the callback
          releaseProj();
          runSubAgents(agent, entry, subTasks.slice(0, 4), opts.onDone);
        } else {
          fireDone(lastText, !m.is_error);
          if (!m.is_error) maybeLearnSkill(agent, task, prompt, acts, lastText);
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
function teamList() {
  return Object.entries(reg.agents)
    .filter(([id]) => id !== "ceo" && id !== "main")
    .map(([id, a]) => `- ${id}: ${a.name}, ${a.role}` +
      (a.prompt ? ` — ${a.prompt.replace(/\s+/g, " ").slice(0, 100)}` : ""))
    .join("\n") || "(no other staff yet)";
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

function ceoFlow(prompt, session, project) {
  broadcast({ type: "ceo.summon", agent: "main" });
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
    logPrompt: "👑 (CEO) " + prompt,
    filterText: makeDelegateFilter(0, session),
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
    const report = results.map((r, i) =>
      `--- SUB ${i + 1}: ${r.task}\n${(r.ok && r.text) ? r.text : "(failed / no result)"}`
    ).join("\n\n");
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
    try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true }); } catch {}
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
        finish(!m.is_error);
      }
    }
  });
  child.stderr.on("data", (c) => console.error(`[sub:${subId}]`, c.toString().trim()));
  child.on("error", () => finish(false));
  child.on("close", () => finish(!!lastText));
}

// ---------------------------------------------------------------- updates
// Quietly compare local HEAD with GitHub main; when they differ the office
// shows a 🔄 banner and `bagidea update` / POST /update runs the updater.
let updateSha = null;
function checkUpdate() {
  const { execFile } = require("child_process");
  execFile("git", ["rev-parse", "HEAD"], { cwd: path.join(__dirname, "..") }, (e, out) => {
    if (e) return;
    const local = String(out).trim();
    require("https").get({
      host: "api.github.com",
      path: "/repos/bagidea/bagidea-ai-agents-office/commits/main",
      headers: { "user-agent": "bagidea-office" },
    }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(b);
          if (j.sha && j.sha !== local && updateSha !== j.sha) {
            updateSha = j.sha;
            broadcast({ type: "update.available", sha: j.sha.slice(0, 7) }, false);
            console.log("[update] new version available", j.sha.slice(0, 7));
          }
        } catch {}
      });
    }).on("error", () => {});
  });
}
setTimeout(checkUpdate, 90000);
setInterval(checkUpdate, 6 * 3600000);

// ---------------------------------------------------------------- channels
// The outside world (Telegram / Discord / LINE) talks to the Director —
// inbound messages become serialized Director turns (no thread races) and
// his reply rides back on the same channel. Full DELEGATE power applies.
const channels = require("./channels")({
  getConfig: () => reg.channels || {},
  log: (s) => console.log(s),
  onMessage(channel, from, text, reply) {
    broadcast({ type: "channel.message", channel, from,
      text: String(text).slice(0, 500) });
    queueDirectorTurn((release) => {
      runClaude("main",
        `ข้อความใหม่จากช่องทาง ${channel.toUpperCase()} โดย "${from}":\n` +
        `"""${String(text).slice(0, 4000)}"""\n\n` +
        `ตอบกลับให้เหมาะสม — คำตอบของคุณจะถูกส่งกลับไปหาเขาทาง ${channel} ` +
        `(ข้อความล้วน อ่านง่าย ภาษาเดียวกับผู้ส่ง). ` +
        `ถ้าเป็นคำสั่งงาน คุณมีอำนาจเต็ม: ทำเอง หรือ DELEGATE ตาม protocol ปกติ ` +
        `แล้วตอบเขาว่ารับเรื่องแล้วและจะรายงานผลทางออฟฟิศ`,
        { logPrompt: `📨 [${channel}] ${String(text).slice(0, 80)}`,
          filterText: makeDelegateFilter(0, undefined),
          onDone: (out, ok) => {
            release();
            try { reply(ok && out ? out : "ขออภัยครับ ระบบติดขัดชั่วคราว ลองใหม่อีกครั้งนะครับ"); }
            catch (e) { console.error("[chan reply]", e.message); }
          } });
    });
  },
});
channels.restart();

// ---------------------------------------------------------------- discussion
// Agents talk to each other: round-robin claude calls sharing a transcript,
// staged in the meeting room (collab.* events drive seats + whiteboard).
let discussing = false;

async function runDiscussion(ids, topic, rounds) {
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
  let transcript = "";
  try {
    for (let r = 0; r < rounds; r++) {
      for (const id of ids) {
        const a = reg.agents[id] || { name: id, role: "Staff", prompt: "" };
        const text = await claudeText(
          `You are "${a.name}" (${a.role}) in a team meeting at the office.\n` +
          (a.prompt ? `Your persona: ${a.prompt}\n` : "") +
          `Meeting topic: ${topic}\n` +
          (transcript ? `Discussion so far:\n${transcript}\n` : "You open the meeting.\n") +
          `Give YOUR next contribution as ${a.name}: concrete, build on the others, ` +
          `max 3 sentences, plain text only, in the same language as the topic.`);
        const line = text.split("\n").filter(Boolean).join(" ").slice(0, 500);
        if (line) {
          transcript += `${a.name}: ${line}\n`;
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
    } catch {}
  }
}

// ---------------------------------------------------------------- http

function readBody(req, cb) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => cb(body));
}

function readBodyRaw(req, cb) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => cb(Buffer.concat(chunks)));
}

const MAPBG = path.join(__dirname, "map_bg.png");

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url.split("?")[0] === "/" || req.url.split("?")[0] === "/index.html")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(fs.readFileSync(OVERLAY));

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
        let { agent = "main", prompt, session, wait } = JSON.parse(body);
        if (!prompt) throw new Error("no prompt");
        // Saying a project's name binds the conversation to its directory.
        const project = projectFromPrompt(prompt);
        // wait:true (the CLI's ask) holds the response until the run truly
        // finishes and returns the final text. CEO theatrics need a screen —
        // waited calls go straight to the Director instead.
        let waited = null;
        if (wait) {
          if (agent === "ceo") agent = "main";
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
        const task = agent === "ceo" ? ceoFlow(prompt, session, project)
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

  } else if (req.method === "POST" && req.url === "/registry/agent") {
    // Create or update an agent. Protected rows (main/ceo) accept edits but
    // never deletion; id is derived from the name on first save.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const id = p.id || slugId(p.name);
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
          projects = projects.filter((x) => x.id !== p.remove);
          saveProjects();
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
        };
        if (mode === "folder") {
          spawn("explorer", [dir], { detached: true });
        } else if (mode === "shell") {
          // Plain shell, no marker — not counted as "project open".
          launch("", path.basename(dir));
        } else if (id in projWin) {
          // ONE window per project, always: if it exists (even hidden),
          // surface THAT — never spawn a second one on top of it.
          winproj("show", id, () => sweepProjects());
        } else {
          ensureTrusted(dir);  // no trust dialog ambush in the new window
          if ((projRuns[id] || 0) > 0) {
            // An agent is working RIGHT NOW. Resuming its session mid-run
            // would fork the thread — instead the window opens as a LIVE
            // VIEW of the agent's session, and the moment the run ends it
            // hands the SAME session over to the user (claude --resume).
            const sd = claudeSessionDir(dir).replace(/'/g, "''");
            launch(`-Command "& '${LIVEVIEW.replace(/'/g, "''")}' -Dir '${sd}' -Proj '${id}' #BAGIDEA_PROJ_${id}"`,
              `BAGIDEA_PROJ_${id}`);
          } else {
            // Smart entry: resume the NEWEST session explicitly — straight
            // into where the work happened (claude -c ignores headless-born
            // sessions and -r dumps a picker nobody asked for). Fresh claude
            // only when the project has no sessions yet.
            const sid = newestSid(dir);
            const cmd = sid ? `claude --resume ${sid}` : "claude";
            launch(`-Command "${cmd} #BAGIDEA_PROJ_${id}"`, `BAGIDEA_PROJ_${id}`);
          }
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
        winproj(action, String(id).replace(/[^\w-]/g, ""), () => sweepProjects());
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
        if (p.remove) jobs = jobs.filter((j) => j.id !== p.id);
        else if (p.enabled !== undefined) job.enabled = !!p.enabled;
        saveJobs();
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
        else {
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
    // ✨ Prompt copilot: the owner types a one-line brief ("UI designer who
    // sweats microcopy") and a quick claude call drafts the system prompt.
    readBody(req, async (body) => {
      try {
        const { name = "Agent", role = "Specialist", brief = "" } = JSON.parse(body);
        const draft = await claudeText(
          `Design a complete persona for an AI agent in a software office.\n` +
          `Agent name: ${name}\nJob title: ${role}\nOwner's brief: ${brief}\n\n` +
          `Output STRICT JSON only (no markdown fences):\n` +
          `{"prompt":"core mission & identity, second person, 3-6 sentences",` +
          `"expertise":"bullet-ish lines: concrete skills, tools, domains they own",` +
          `"personality":"tone of voice, character quirks, how they talk",` +
          `"language":"primary reply language, e.g. ไทย / English / ตามผู้ใช้",` +
          `"rules":"3-6 imperative work rules (do/don't), one per line"}\n` +
          `Every field must genuinely reflect the brief. Match the brief's ` +
          `language (Thai brief → Thai fields).`);
        let out = { prompt: draft };
        const m = draft.match(/\{[\s\S]*\}/);
        if (m) try { out = JSON.parse(m[0]); } catch {}
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/ui/daylight") {
    // Manual atmosphere override for the world ("auto" follows the clock).
    // Journaled, so the choice survives renderer restarts via replay.
    readBody(req, (body) => {
      try {
        const { hour = "auto" } = JSON.parse(body || "{}");
        broadcast({ type: "ui.daylight", hour });
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

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

  } else if (req.method === "POST" && req.url === "/update") {
    // Human-triggered only (in-app 🔄 button or the CLI).
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    const ps = path.join(__dirname, "..", "installer", "update.ps1");
    spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps],
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
server.on("upgrade", (req, sock) => {
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

server.listen(8787, "127.0.0.1", () =>
  console.log("[oep] http+ws listening :8787")
);
