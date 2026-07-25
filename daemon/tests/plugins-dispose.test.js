// Tests for the plugin dispose contract (daemon/plugins.js).
//
// Why this exists: load() re-requires every plugin, so a plugin that owns a
// setInterval used to keep ticking forever after a reload — the old closure is
// unreachable, nothing can clear its handle, and the fresh instance's own
// `if (timer) clearInterval(timer)` only ever sees its own null. The binance
// plugin was observed running SEVEN concurrent monitor loops and seven scanner
// loops in one process, each with its own dedup state and its own locks.
//
// The contract: a factory MAY return dispose(); it MUST be synchronous; a
// throwing dispose must not abort the reload; a plugin without one still loads.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const initPlugins = require("../plugins");

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-dispose-")); }

/** Writes a plugin whose instances tick a counter on a shared global. */
function writeTickingPlugin(root, id, { withDispose }) {
  const dir = path.join(root, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id, name: id, version: "1.0.0" }));
  fs.writeFileSync(path.join(dir, "index.js"), `
module.exports = () => {
  const REG = (globalThis.__disposeTest_${id} = globalThis.__disposeTest_${id} || { live: 0, disposed: 0 });
  const timer = setInterval(() => {}, 1000);
  timer.unref();
  REG.live++;
  return {
    onCommand: () => "ok",
    ${withDispose ? "dispose() { clearInterval(timer); REG.live--; REG.disposed++; }," : ""}
  };
};
`);
  return dir;
}

function writeThrowingDispose(root, id) {
  const dir = path.join(root, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id, name: id, version: "1.0.0" }));
  fs.writeFileSync(path.join(dir, "index.js"), `
module.exports = () => ({
  onCommand: () => "ok",
  dispose() { throw new Error("boom"); },
});
`);
}

const mkCtx = (root, logs) => ({ pluginsDir: path.join(root, "plugins"), log: (s) => logs.push(String(s)) });

test("a plugin with dispose() ends up with exactly one live instance after N reloads", () => {
  const root = tmpRoot();
  writeTickingPlugin(root, "ticker", { withDispose: true });
  const logs = [];
  const p = initPlugins(mkCtx(root, logs));

  const reg = globalThis.__disposeTest_ticker;
  assert.strictEqual(reg.live, 1, "initial load starts one instance");
  for (let i = 0; i < 5; i++) p.load();
  assert.strictEqual(reg.live, 1, `5 reloads must leave 1 live instance, got ${reg.live}`);
  assert.strictEqual(reg.disposed, 5, "dispose called once per reload");
  p.disposeAll();
  assert.strictEqual(reg.live, 0);
  delete globalThis.__disposeTest_ticker;
});

test("WITHOUT dispose() the instances stack — this is the bug being fixed", () => {
  // Pinning the failure mode makes the regression visible if someone ever
  // removes dispose() from a plugin that owns a timer.
  const root = tmpRoot();
  writeTickingPlugin(root, "leaky", { withDispose: false });
  const logs = [];
  const p = initPlugins(mkCtx(root, logs));
  for (let i = 0; i < 3; i++) p.load();
  assert.strictEqual(globalThis.__disposeTest_leaky.live, 4, "no dispose ⇒ every reload adds an instance");
  delete globalThis.__disposeTest_leaky;
});

test("a throwing dispose() is logged and does NOT abort the reload", () => {
  const root = tmpRoot();
  writeThrowingDispose(root, "grumpy");
  writeTickingPlugin(root, "ticker2", { withDispose: true });
  const logs = [];
  const p = initPlugins(mkCtx(root, logs));

  const res = p.load();
  assert.strictEqual(res.loaded, 2, "both plugins still load despite the throw");
  assert.ok(logs.some((l) => /dispose fail grumpy/.test(l)), "the failure is reported, not swallowed");
  assert.strictEqual(globalThis.__disposeTest_ticker2.live, 1, "the well-behaved plugin was still disposed");
  p.disposeAll();
  delete globalThis.__disposeTest_ticker2;
});

test("a plugin with no dispose() still loads and is untouched (backward compatible)", () => {
  const root = tmpRoot();
  const dir = path.join(root, "plugins", "plain");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id: "plain", name: "plain", version: "1.0.0" }));
  fs.writeFileSync(path.join(dir, "index.js"), "module.exports = () => ({ onCommand: () => 'ok' });\n");
  const logs = [];
  const p = initPlugins(mkCtx(root, logs));
  assert.strictEqual(p.load().loaded, 1);
  assert.doesNotThrow(() => p.disposeAll());
});

test("the real binance and sentiment-autoscan plugins expose a dispose()", () => {
  // These two own setIntervals. If either loses dispose(), reloads start
  // stacking trading loops again — so assert the contract on the real files.
  for (const id of ["binance", "sentiment-autoscan"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "plugins", id, "index.js"), "utf8");
    assert.ok(/\bdispose\s*\(\s*\)\s*\{/.test(src), `${id}/index.js must return a dispose()`);
  }
});
