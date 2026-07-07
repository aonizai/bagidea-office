// Tests for the plugin host (daemon/plugins.js), focused on the syntax guard:
// a JS-broken index.js must be rejected up front with a clear parser error
// instead of half-loading as mod:null (the silent-fail that masked the waxwing
// unlock crash). Covers both the load() logic and the /plugins/reload HTTP
// response shape (400 + {ok:false, failed:[...]} vs 200 + {ok:true, loaded}).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const initPlugins = require("../plugins");

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-plugins-")); }

function writePlugin(root, id, good) {
  const dir = path.join(root, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"),
    JSON.stringify({ id, name: id, version: "1.0.0" }));
  fs.writeFileSync(path.join(dir, "index.js"),
    good
      ? "module.exports = () => ({ onCommand: () => 'ok' });\n"
      : "module.exports = () => {\n  return { x: 1\n");  // unbalanced braces
}

function host(root) {
  const logs = [];
  const plugins = initPlugins({ pluginsDir: path.join(root, "plugins"), log: (m) => logs.push(m) });
  return { plugins, logs };
}

test("load() rejects a syntax-broken index.js and still loads the good ones", () => {
  const root = tmpRoot();
  writePlugin(root, "good-plugin", true);
  writePlugin(root, "broken-plugin", false);
  const { plugins, logs } = host(root);

  const result = plugins.load();
  assert.ok(result, "load() returns a result object");
  assert.strictEqual(typeof result.loaded, "number");
  assert.ok(Array.isArray(result.failed));

  // broken plugin is reported with a clear, located SyntaxError.
  const broken = result.failed.find((f) => f.id === "broken-plugin");
  assert.ok(broken, "broken plugin is in failed[]");
  assert.match(broken.error, /SyntaxError/i);
  assert.ok(broken.error.length > 0, "error message is non-empty");

  // good plugin still loaded; broken one must NOT be registered.
  assert.ok(result.loaded >= 1, "good plugin counts as loaded");
  const ids = plugins.list().map((p) => p.id);
  assert.ok(ids.includes("good-plugin"), "good plugin is registered");
  assert.ok(!ids.includes("broken-plugin"), "broken plugin is NOT registered (no silent mod:null)");

  // logs: clear syntax-fail line, never a fake "loaded" for the broken one.
  assert.ok(logs.some((l) => /\[plugin\] syntax fail broken-plugin/.test(l)),
    "log has a clear '[plugin] syntax fail broken-plugin' line");
  assert.ok(!logs.some((l) => /\[plugin\] loaded broken-plugin/.test(l)),
    "log never calls the broken plugin 'loaded'");

  assert.strictEqual(plugins.lastLoad(), result, "lastLoad() exposes the same run");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a clean tree reloads with no load/syntax fails in the log", () => {
  const root = tmpRoot();
  writePlugin(root, "good-plugin", true);
  const { plugins, logs } = host(root);
  const result = plugins.load();

  assert.strictEqual(result.failed.length, 0, "no failures on a clean tree");
  assert.ok(logs.some((l) => /\[plugin\] loaded good-plugin/.test(l)), "good plugin logs 'loaded'");
  assert.ok(!logs.some((l) => /load fail|syntax fail/.test(l)), "no fail lines on a clean reload");
  fs.rmSync(root, { recursive: true, force: true });
});

// The /plugins/reload + /plugins handler bodies below mirror daemon/server.js.
// Run against a real socket so the request path is exercised end-to-end.
function serve(plugins, port) {
  return http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (req.method === "GET" && url === "/plugins") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ plugins: plugins.list() }));
      return;
    }
    if (req.method === "POST" && url === "/plugins/reload") {
      // === mirrors daemon/server.js: /plugins/reload ===
      const result = plugins.load();
      if (result && result.failed && result.failed.length) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, loaded: result.loaded, failed: result.failed }));
      } else {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, loaded: result ? result.loaded : 0 }));
      }
      return;
    }
    res.writeHead(404); res.end("no");
  });
}

function hit(port, method, urlPath) {
  return new Promise((resolve) => {
    const r = http.request({ method, path: urlPath, port, host: "127.0.0.1" }, (resp) => {
      let body = ""; resp.on("data", (d) => body += d);
      resp.on("end", () => resolve({ status: resp.statusCode, body }));
    });
    r.on("error", resolve); r.end();
  });
}

test("POST /plugins/reload rejects (400) when a plugin is JS-broken, 200 when clean", async () => {
  const root = tmpRoot();
  writePlugin(root, "good-plugin", true);
  writePlugin(root, "broken-plugin", false);
  const { plugins } = host(root);
  const port = 18791;
  const server = serve(plugins, port);
  await new Promise((r) => server.listen(port, "127.0.0.1", r));

  try {
    // CASE A — broken plugin present → reload must REJECT.
    const a = await hit(port, "POST", "/plugins/reload");
    const ja = JSON.parse(a.body);
    assert.strictEqual(a.status, 400, "broken tree → HTTP 400 (not a silent 200 ok)");
    assert.strictEqual(ja.ok, false);
    assert.ok(ja.failed.some((f) => f.id === "broken-plugin"), "failed[] names the broken plugin");
    assert.match(JSON.stringify(ja.failed), /SyntaxError/i, "failed error includes SyntaxError");
    assert.ok(ja.loaded >= 1, "good plugin still loaded alongside");

    const la = await hit(port, "GET", "/plugins");
    const ids = JSON.parse(la.body).plugins.map((p) => p.id);
    assert.ok(ids.includes("good-plugin"), "GET /plugins lists good-plugin");
    assert.ok(!ids.includes("broken-plugin"), "GET /plugins omits broken-plugin");

    // CASE B — remove the broken plugin → reload must SUCCEED.
    fs.rmSync(path.join(root, "plugins", "broken-plugin"), { recursive: true, force: true });
    const b = await hit(port, "POST", "/plugins/reload");
    const jb = JSON.parse(b.body);
    assert.strictEqual(b.status, 200, "clean tree → HTTP 200");
    assert.strictEqual(jb.ok, true);
    assert.strictEqual(typeof jb.loaded, "number");
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
