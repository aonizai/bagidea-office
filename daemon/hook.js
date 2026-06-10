// Claude Code hook → office daemon forwarder (cross-platform Node port of
// hook.ps1). Wired in .claude/settings.json. Reads the hook payload from stdin,
// maps it to an office event, and POSTs to the daemon. Must NEVER block or fail
// the hook: best-effort with a short timeout, always exits 0.
//
//   node hook.js <type>        e.g. node hook.js task.started
const http = require("http");

const type = process.argv[2] || "task.progress";

// Sessions spawned by the office adapter report through stream-json instead —
// skip the hook to avoid double events.
if (process.env.OFFICE_ADAPTER === "1") process.exit(0);

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const payload = { type, agent: "claude" };
  try {
    if (stdin.trim()) {
      const h = JSON.parse(stdin);
      if (h.tool_name) payload.tool = h.tool_name;
      if (h.session_id) payload.task = "s" + String(h.session_id).slice(0, 6);
    }
  } catch {}
  const body = Buffer.from(JSON.stringify(payload));
  const req = http.request({
    host: "127.0.0.1", port: 8787, path: "/event", method: "POST",
    headers: { "content-type": "application/json", "content-length": body.length },
    timeout: 2000,
  }, (res) => { res.resume(); res.on("end", () => process.exit(0)); });
  req.on("error", () => process.exit(0));
  req.on("timeout", () => { req.destroy(); process.exit(0); });
  req.end(body);
});
process.stdin.on("error", () => process.exit(0));
// Safety net: never hang the hook.
setTimeout(() => process.exit(0), 2500);
