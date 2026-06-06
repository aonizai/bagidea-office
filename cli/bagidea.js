#!/usr/bin/env node
// bagidea — command line for the BagIdea AI Agents Office.
// Talks to the daemon on :8787 when the suite is running; can launch the
// whole program when it is not. Zero dependencies.
//
//   bagidea start                 เปิดโปรแกรม (ถ้ายังไม่เปิด)
//   bagidea stop                  ปิดทั้งชุด (shell + wallpaper + daemon)
//   bagidea status                สถานะระบบ + โปรเจค + ใครกำลังทำงาน
//   bagidea ask "<ข้อความ>"        ถาม Director รอคำตอบจบในคำสั่งเดียว
//   bagidea chat <agent> "<msg>"  ส่งงานให้ agent ระบุตัว (ไม่รอคำตอบ)
//   bagidea projects              รายชื่อโปรเจค + สถานะ
//   bagidea open "<ชื่อโปรเจค>"    เปิดหน้าต่างโปรเจค (เหมือนปุ่ม ▶)
//   bagidea feed                  ดู log เหตุการณ์สดในเทอร์มินัล (Ctrl+C ออก)
//   bagidea update                อัปเดตเป็นเวอร์ชันล่าสุด (git pull + rebuild)
//   bagidea version               เวอร์ชัน (git commit) ปัจจุบัน

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BASE = "http://127.0.0.1:8787";

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(BASE + p, {
      method,
      headers: {
        "x-bagidea-ui": "1",
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        try { resolve(JSON.parse(out)); } catch { resolve(out); }
      });
    });
    r.setTimeout(method === "POST" && p === "/chat" ? 11 * 60000 : 8000,
      () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function daemonUp() {
  try { return !!(await req("GET", "/health")); } catch { return false; }
}

function findShellExe() {
  const exe = path.join(ROOT, "shell", "target", "release", "bagidea-office-shell.exe");
  return fs.existsSync(exe) ? exe : null;
}

const C = { dim: "\x1b[90m", cyan: "\x1b[96m", green: "\x1b[92m", yellow: "\x1b[93m",
  red: "\x1b[91m", bold: "\x1b[1m", off: "\x1b[0m" };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`${C.bold}🏢 bagidea — BagIdea AI Agents Office CLI${C.off}

  ${C.cyan}bagidea start${C.off}                 เปิดโปรแกรม (ถ้ายังไม่เปิด)
  ${C.cyan}bagidea stop${C.off}                  ปิดทั้งชุด
  ${C.cyan}bagidea status${C.off}                สถานะระบบ + โปรเจค
  ${C.cyan}bagidea ask "<ข้อความ>"${C.off}        ถาม Director และรอคำตอบ
  ${C.cyan}bagidea chat <agent> "<msg>"${C.off}  ส่งงานให้ agent (ไม่รอ)
  ${C.cyan}bagidea projects${C.off}              รายชื่อโปรเจค
  ${C.cyan}bagidea open "<ชื่อโปรเจค>"${C.off}    เปิดหน้าต่างโปรเจค
  ${C.cyan}bagidea feed${C.off}                  ดูเหตุการณ์สด (Ctrl+C ออก)
  ${C.cyan}bagidea update${C.off}                อัปเดตโปรแกรม
  ${C.cyan}bagidea version${C.off}               เวอร์ชันปัจจุบัน`);
    return;
  }

  if (cmd === "version") {
    try {
      const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
      const date = execFileSync("git", ["log", "-1", "--format=%cd", "--date=short"], { cwd: ROOT }).toString().trim();
      console.log(`bagidea office ${C.cyan}${sha}${C.off} (${date})`);
    } catch { console.log("bagidea office (git not available)"); }
    return;
  }

  if (cmd === "start") {
    if (await daemonUp()) return console.log(`${C.green}✓${C.off} โปรแกรมเปิดอยู่แล้ว`);
    const exe = findShellExe();
    if (!exe) return console.log(`${C.red}✗${C.off} ไม่พบ shell exe — รัน: cargo build --release ใน shell/`);
    spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: "ignore" }).unref();
    process.stdout.write("กำลังเปิดออฟฟิศ");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      process.stdout.write(".");
      if (await daemonUp()) return console.log(`\n${C.green}✓${C.off} ออฟฟิศพร้อมทำงานแล้ว 🏢`);
    }
    return console.log(`\n${C.yellow}!${C.off} เปิดแล้วแต่ daemon ยังไม่ตอบ — ดูที่หน้าจอ`);
  }

  if (cmd === "stop") {
    spawn("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'server\\.js') -or $_.Name -eq 'bagidea-office-shell.exe' -or $_.Name -like 'Godot*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F } | Out-Null"],
      { stdio: "ignore" }).on("close", () => console.log(`${C.green}✓${C.off} ปิดออฟฟิศแล้ว`));
    return;
  }

  if (!(await daemonUp()))
    return console.log(`${C.red}✗${C.off} โปรแกรมยังไม่เปิด — สั่ง ${C.cyan}bagidea start${C.off} ก่อน`);

  if (cmd === "status") {
    const h = await req("GET", "/health");
    const pr = await req("GET", "/projects");
    const reg = await req("GET", "/registry");
    const agents = Object.entries(reg.agents || {}).filter(([id]) => id !== "ceo");
    console.log(`${C.bold}🏢 BagIdea Office${C.off}  ${C.green}● online${C.off}` +
      `  (clients ${h.clients} · WT ${h.wt ? "✓" : "✗"} · perms ค้าง ${h.pendingPerms})`);
    console.log(`${C.dim}── agents ──${C.off}`);
    for (const [id, a] of agents)
      console.log(`  ${a.name} ${C.dim}(${id} · ${a.role})${C.off}`);
    console.log(`${C.dim}── projects ──${C.off}`);
    if (!(pr.projects || []).length) console.log(`  ${C.dim}(ไม่มี)${C.off}`);
    for (const p of pr.projects || []) {
      const st = p.ai ? `${C.cyan}🤖 ${(p.agents || []).join(",")} กำลังทำงาน${C.off}`
        : p.open ? (p.visible ? `${C.green}🖥 เปิดอยู่${C.off}` : `${C.yellow}🫥 เบื้องหลัง${C.off}`)
        : `${C.dim}ปิด${C.off}`;
      console.log(`  📁 ${p.name} ${C.dim}${p.dir}${C.off} — ${st}`);
    }
    return;
  }

  if (cmd === "ask") {
    const q = rest.join(" ").trim();
    if (!q) return console.log("ใช้: bagidea ask \"<ข้อความ>\"");
    console.log(`${C.dim}→ ถาม Director… (รอจนตอบจบ)${C.off}`);
    const r = await req("POST", "/chat", { agent: "main", prompt: q, wait: true });
    console.log((r && r.text) || "(ไม่มีคำตอบ)");
    return;
  }

  if (cmd === "chat") {
    const agent = rest[0];
    const q = rest.slice(1).join(" ").trim();
    if (!agent || !q) return console.log("ใช้: bagidea chat <agent_id> \"<ข้อความ>\"");
    const r = await req("POST", "/chat", { agent, prompt: q });
    console.log(`${C.green}✓${C.off} ส่งให้ ${agent} แล้ว (task ${r.task}) — ดูผลใน feed / หน้าโปรแกรม`);
    return;
  }

  if (cmd === "projects") {
    const pr = await req("GET", "/projects");
    for (const p of pr.projects || [])
      console.log(`📁 ${C.bold}${p.name}${C.off} ${C.dim}${p.dir}${C.off}` +
        `${p.ai ? ` ${C.cyan}🤖 ${(p.agents || []).join(",")}${C.off}` : ""}` +
        `${p.open ? (p.visible ? ` ${C.green}🖥${C.off}` : ` ${C.yellow}🫥${C.off}`) : ""}`);
    if (!(pr.projects || []).length) console.log(`${C.dim}(ยังไม่มีโปรเจค)${C.off}`);
    return;
  }

  if (cmd === "open") {
    const name = rest.join(" ").trim().toLowerCase();
    const pr = await req("GET", "/projects");
    const p = (pr.projects || []).find((x) => x.name.toLowerCase() === name);
    if (!p) return console.log(`${C.red}✗${C.off} ไม่พบโปรเจคชื่อนั้น — ดู: bagidea projects`);
    await req("POST", "/projects/open", { id: p.id, mode: "play" });
    console.log(`${C.green}✓${C.off} เปิด ${p.name} แล้ว`);
    return;
  }

  if (cmd === "feed") {
    // Live tail of the office journal — same events the 📡 feed shows.
    const J = path.join(ROOT, "daemon", "journal.jsonl");
    let pos = 0;
    try { pos = fs.statSync(J).size; } catch {}
    console.log(`${C.dim}📡 ดูเหตุการณ์สด… (Ctrl+C ออก)${C.off}`);
    setInterval(() => {
      let size = 0;
      try { size = fs.statSync(J).size; } catch { return; }
      if (size <= pos) return;
      const fd = fs.openSync(J, "r");
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = size;
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const t = new Date(e.ts).toLocaleTimeString();
        if (e.type === "chat.message")
          console.log(`${C.dim}${t}${C.off} ${C.cyan}${e.sub || e.agent}${C.off}: ${String(e.text).split("\n")[0].slice(0, 110)}`);
        else if (e.type === "task.started")
          console.log(`${C.dim}${t}${C.off} ${C.green}▶${C.off} ${e.agent}: ${e.title || ""}`);
        else if (e.type === "task.completed") console.log(`${C.dim}${t} ✓ ${e.agent} เสร็จ${C.off}`);
        else if (e.type === "task.failed") console.log(`${C.dim}${t}${C.off} ${C.red}✗ ${e.agent} ล้มเหลว${C.off}`);
        else if (e.type === "perm.requested")
          console.log(`${C.dim}${t}${C.off} ${C.yellow}🛡 ${e.agent} ขอใช้ ${e.tool} — กด allow ในหน้าโปรแกรม${C.off}`);
        else if (e.type === "task.delegated") console.log(`${C.dim}${t}${C.off} 📋 main → ${e.target}`);
        else if (e.type === "channel.message")
          console.log(`${C.dim}${t}${C.off} 📨 [${e.channel}] ${e.from}: ${e.text}`);
      }
    }, 800);
    return;
  }

  if (cmd === "update") {
    const ps = path.join(ROOT, "installer", "update.ps1");
    if (!fs.existsSync(ps)) return console.log(`${C.red}✗${C.off} ไม่พบ installer/update.ps1`);
    console.log("เริ่มอัปเดต… (โปรแกรมจะรีสตาร์ทเอง)");
    spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps],
      { cwd: ROOT, detached: true, stdio: "inherit" });
    return;
  }

  console.log(`ไม่รู้จักคำสั่ง "${cmd}" — ดู: bagidea help`);
}

main().catch((e) => { console.error(`${C.red}✗${C.off} ${e.message}`); process.exit(1); });
