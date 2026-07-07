// BagIdea Office — plugin host (zero-dep).
// A plugin is a folder under plugins/<id>/ with a plugin.json manifest and an
// optional index.js (server side). Plugins extend the office in real ways:
//   • add HTTP routes under /plugin/<id>/...   (server-side power)
//   • add an overlay panel (panel.html)        (a UI the user opens)
//   • expose agent COMMANDS                     (so agents can drive the plugin)
//
// plugin.json:
//   {
//     "id": "music", "name": "🎵 Music Player", "version": "1.0.0",
//     "description": "...", "panel": "panel.html",
//     "commands": [{ "name":"play", "args":"<query>", "desc":"play a track" }],
//     "needsKeys": []            // main keys this plugin requires (optional)
//   }
//
// index.js exports: (ctx) => ({ routes?, onCommand?(cmd, args, reply) })
//   ctx = { broadcast, feed, reg, saveReg, workspace, daemonDir,
//           dataDir, pluginDir, manifest, log, runClaude }
// Built-in plugins ship enabled; users drop new folders in plugins/ and
// restart (or call /plugins/reload). See docs/guide/plugins.md.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Syntax-check a plugin's index.js with `node --check` BEFORE require(), so a
// broken file (unbalanced brace, stray token…) is rejected up front with a clear
// parser error instead of throwing inside require(). The waxwing unlock crash
// showed why this matters: a JS-broken plugin used to load with mod:null and
// still log "loaded", masking the failure as a silent runtime glitch. Returns
// null when the file parses, or the first useful line of the parser message.
// Uses process.execPath (the running node) so it never depends on PATH.
function checkSyntax(file) {
  try {
    execFileSync(process.execPath, ["--check", file],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 5000 });
    return null;
  } catch (err) {
    // `node --check` prints a "file:line" header, the offending line, a caret,
    // then a "SyntaxError: <reason>" line, then a stack trace. Keep the
    // location + the reason — together they say exactly what and where.
    const lines = String(err.stderr || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const loc = lines[0] || "";
    const reason = lines.find((l) => /SyntaxError|Error:/.test(l)) || "";
    return [loc, reason].filter(Boolean).join(" — ") || err.message;
  }
}

module.exports = function initPlugins(ctx) {
  // ctx.pluginsDir lets a test harness point load() at a throwaway folder;
  // production callers leave it unset and we use the real plugins/ tree.
  const DIR = (ctx && ctx.pluginsDir) || path.join(__dirname, "..", "plugins");
  fs.mkdirSync(DIR, { recursive: true });
  let plugins = {};   // id -> { manifest, mod, dir, dataDir }
  // Result of the most recent load(): { loaded, failed:[{id,file,error}] }.
  // Exposed so /plugins/reload can report a clear failure instead of "ok".
  let lastLoad = { loaded: 0, failed: [] };

  function load() {
    plugins = {};
    const failed = [];
    let loadedCount = 0;
    let entries = [];
    try { entries = fs.readdirSync(DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".")); }
    catch { return; }
    for (const e of entries) {
      const dir = path.join(DIR, e.name);
      const manFile = path.join(dir, "plugin.json");
      if (!fs.existsSync(manFile)) continue;
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manFile, "utf8")); }
      catch (err) { ctx.log("[plugin] bad manifest " + e.name + ": " + err.message); continue; }
      manifest.id = manifest.id || e.name;
      if (manifest.enabled === false) continue;
      const dataDir = path.join(dir, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      let mod = null;
      const idx = path.join(dir, "index.js");
      if (fs.existsSync(idx)) {
        const synErr = checkSyntax(idx);
        if (synErr) {
          // Syntax-broken JS must NOT be registered — rejecting up front here
          // keeps a bad plugin from sneaking in as mod:null and logging
          // "loaded" (the silent-fail that masked the waxwing unlock crash).
          ctx.log("[plugin] syntax fail " + manifest.id + ": " + synErr);
          failed.push({ id: manifest.id, file: "index.js", error: synErr });
          continue;
        }
        try {
          delete require.cache[require.resolve(idx)];
          const factory = require(idx);
          mod = factory({ ...ctx, dataDir, pluginDir: dir, manifest });
        } catch (err) {
          // Same anti-mask rule as the syntax check above: a plugin whose
          // factory throws at load time must be skipped and reported, not
          // registered as mod:null and logged "loaded".
          ctx.log("[plugin] load fail " + manifest.id + ": " + err.message);
          failed.push({ id: manifest.id, file: "index.js", error: err.message });
          continue;
        }
      }
      plugins[manifest.id] = { manifest, mod, dir, dataDir };
      loadedCount++;
      ctx.log("[plugin] loaded " + manifest.id + " v" + (manifest.version || "?"));
    }
    lastLoad = { loaded: loadedCount, failed };
    return lastLoad;
  }
  load();

  // The note appended to agent prompts so they know what plugins they can drive.
  function agentNote() {
    const cmds = [];
    for (const p of Object.values(plugins)) {
      for (const c of p.manifest.commands || [])
        cmds.push(`- ${p.manifest.name} → curl -s -X POST http://127.0.0.1:8787/plugin/${p.manifest.id}/cmd ` +
          `-H "content-type: application/json" -d "{\\"cmd\\":\\"${c.name}\\",\\"args\\":\\"...\\"}" : ${c.desc}`);
    }
    const create = `You can also BUILD a new plugin: create plugins/<id>/ with a ` +
      `plugin.json (+ optional index.js / panel.html), then ` +
      `curl -s -X POST http://127.0.0.1:8787/plugins/reload -H "x-bagidea-ui: 1". ` +
      `Full spec: docs/guide/plugins.md. ` +
      `To SHARE a plugin on the public Plugins Hub so others can install it, follow ` +
      `docs/guide/plugin-hub.md: publish it as a public GitHub repo, then open a PR ` +
      `adding one entry to web/plugins.json (id must match plugin.json). If the owner ` +
      `asks you to submit one, walk them through those exact steps.`;
    // Non-ASCII on a Windows command line is mangled to "?" by the shell codepage
    // BEFORE curl runs — so a Thai/Chinese/etc. arg passed inline arrives corrupted.
    // Tell agents to send the JSON body from a FILE instead (the Write tool saves UTF-8).
    const utf8 = `⚠️ If any value contains non-English text (Thai, Chinese, emoji words…), ` +
      `do NOT pass it inline — on Windows the shell turns it into "?". Instead Write the ` +
      `JSON body to a file (UTF-8) and send that file:\n` +
      `  curl -s -X POST http://127.0.0.1:8787/plugin/<id>/cmd -H "content-type: application/json" --data-binary @body.json`;
    if (!cmds.length) return `\n<office-plugins>\n${create}\n</office-plugins>`;
    return `\n<office-plugins>\nExtensions you can drive (via Bash):\n${cmds.join("\n")}\n\n${utf8}\n\n${create}\n</office-plugins>`;
  }

  // HTTP dispatch for /plugin/<id>/...  — returns true if handled.
  function handleHttp(req, res, readBody, readBodyRaw) {
    const m = req.url.match(/^\/plugin\/([\w-]+)\/(.+?)(\?|$)/);
    if (!m) return false;
    const p = plugins[m[1]];
    if (!p) { res.writeHead(404); res.end("unknown plugin"); return true; }
    const sub = m[2];

    // built-in: serve the panel + static files from the plugin folder.
    if (req.method === "GET" && (sub === "panel" || sub.startsWith("static/") || sub === p.manifest.panel)) {
      const file = sub === "panel" ? p.manifest.panel : sub.replace(/^static\//, "");
      const full = path.join(p.dir, file.replace(/\.\./g, ""));
      fs.readFile(full, (e, data) => {
        if (e) { res.writeHead(404); return res.end(); }
        const ext = full.split(".").pop().toLowerCase();
        const mime = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css",
          png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", json: "application/json",
          mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg" }[ext] || "application/octet-stream";
        res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
        res.end(data);
      });
      return true;
    }

    // agent / UI command: POST /plugin/<id>/cmd {cmd, args}
    if (req.method === "POST" && sub === "cmd") {
      readBody(req, (body) => {
        let payload; try { payload = JSON.parse(body); } catch { payload = {}; }
        if (!p.mod || !p.mod.onCommand) { res.writeHead(501); return res.end("plugin has no commands"); }
        let answered = false;
        const reply = (data) => {
          if (answered) return; answered = true;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(data || { ok: true }));
        };
        try {
          ctx.broadcast({ type: "plugin.cmd", plugin: p.manifest.id, cmd: payload.cmd, args: payload.args }, false);
          const r = p.mod.onCommand(payload.cmd, payload.args, reply, payload);
          if (r && typeof r.then === "function") r.then(reply).catch((e) => { if (!answered) { res.writeHead(500); res.end(String(e.message)); } });
          else if (r !== undefined) reply(r);
          // else: the plugin will call reply() itself (async)
        } catch (e) { if (!answered) { res.writeHead(500); res.end(String(e.message)); } }
      });
      return true;
    }

    // custom plugin routes: mod.routes[sub] (METHOD-agnostic handler)
    if (p.mod && p.mod.routes && p.mod.routes[sub]) {
      p.mod.routes[sub](req, res, { readBody, readBodyRaw });
      return true;
    }
    res.writeHead(404); res.end("no such plugin route"); return true;
  }

  function list() {
    return Object.values(plugins).map((p) => ({
      id: p.manifest.id, name: p.manifest.name, version: p.manifest.version,
      description: p.manifest.description, panel: !!p.manifest.panel,
      commands: p.manifest.commands || [], needsKeys: p.manifest.needsKeys || [],
      core: !!p.manifest.core,
      // Optional pop-out window hints: { w, h, resizable } (see plugin template).
      window: p.manifest.window || null,
    }));
  }

  // Resolve a plugin's on-disk dir by its manifest id. Most plugins live in a
  // folder named after their id, but a manually-placed one may not (e.g. folder
  // "waxwing" with id "wax-wallet") — so look it up in the loaded map, never
  // assume plugins/<id>. Returns null if no loaded plugin has that id.
  function dirOf(id) { return plugins[id] ? plugins[id].dir : null; }

  return { load, list, handleHttp, agentNote, dirOf, lastLoad: () => lastLoad };
};
