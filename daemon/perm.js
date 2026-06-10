// PreToolUse hook for office-adapter sessions (cross-platform Node port of
// perm.ps1; wired in workspace/.claude/settings.json). Safe read tools pass
// through; anything else walks to the Security Center: we long-poll the daemon
// until the user stamps Allow/Deny on the overlay. Always exits 0.
const http = require("http");
const crypto = require("crypto");

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  let h = {};
  try { h = JSON.parse(stdin || "{}"); } catch {}
  const tool = String(h.tool_name || "");

  // Safe tools: no opinion, let normal permission flow handle them.
  if (["Read", "Glob", "Grep"].includes(tool)) process.exit(0);

  const id = crypto.randomBytes(4).toString("hex");
  const agent = process.env.OFFICE_AGENT || "claude";
  const task = process.env.OFFICE_TASK || "";
  let inputJson = "";
  try { if (h.tool_input) inputJson = JSON.stringify(h.tool_input); } catch {}

  const body = Buffer.from(JSON.stringify({ id, agent, task, tool, input: inputJson }));
  const emit = (decision) => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: `BagIdea Office Security Center (${decision})`,
      },
    }));
    process.exit(0);
  };

  const req = http.request({
    host: "127.0.0.1", port: 8787, path: "/perm/request", method: "POST",
    headers: { "content-type": "application/json", "content-length": body.length },
    timeout: 55000,
  }, (res) => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { buf += c; });
    res.on("end", () => {
      let decision = "deny";
      try { if (JSON.parse(buf).decision === "allow") decision = "allow"; } catch {}
      emit(decision);
    });
  });
  req.on("error", () => emit("deny"));
  req.on("timeout", () => { req.destroy(); emit("deny"); });
  req.end(body);
});
process.stdin.on("error", () => process.exit(0));
