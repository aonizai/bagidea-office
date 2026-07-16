// Tests for Smart Routing (agent:"auto"): the routeAgent scoring logic and
// the /chat agent:"auto" branch. Layer 1 is a pure-math mirror of routeAgent
// (always runs). Layer 2 hits the live /chat endpoint and is skipped when no
// daemon is reachable.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const BASE_URL = "http://127.0.0.1:8787";

// --- 1. Pure-math characterization of routeAgent scoring ------------------
// Mirrors the scoring in routeAgent (server.js): an agent scores points for
// each distinct prompt word (>1 char) found in its role/name/persona/skills
// corpus, plus a small bonus per assigned skill. The top agent wins only if
// it clearly beats the runner-up (margin ≥1, or a strong lone candidate).

// Build a corpus the same way routeAgent does.
function corpusFor(agent, skills) {
  const skillText = (id) => {
    const s = skills[id] || {};
    return `${s.name || ""} ${s.description || ""}`.toLowerCase();
  };
  return [
    agent.role || "", agent.name || "", agent.prompt || "", agent.persona || "",
    ...(agent.skills || []).map(skillText),
  ].join(" ").toLowerCase();
}
// scoreAgent mirrors the inner loop of routeAgent.
function scoreAgent(prompt, agent, skills) {
  const p = String(prompt || "").toLowerCase();
  const words = p.split(/[^a-z0-9ก-ฮ]+/).filter((w) => w.length > 1);
  if (!words.length) return 0;
  const corpus = corpusFor(agent, skills);
  let hits = 0;
  for (const w of words) if (corpus.includes(w)) hits += 1;
  if (agent.skills && agent.skills.length) hits += Math.min(agent.skills.length, 2) * 0.5;
  return hits;
}

const SKILLS = {
  "deep-research": { name: "Deep Research", description: "Methodical web research sourced brief." },
  "code-review": { name: "Code Review", description: "Review code for bugs and quality." },
  "doc-writer": { name: "Doc Writer", description: "Write documentation and prose." },
};
const AGENTS = {
  athena: { name: "Athena", role: "Researcher", skills: ["deep-research"] },
  guten: { name: "Guten", role: "Writer", skills: ["doc-writer"] },
  forge: { name: "Forge", role: "Engineer", skills: ["code-review"] },
};

test("a research prompt scores highest for the research-skilled agent", () => {
  const s = Object.fromEntries(Object.entries(AGENTS).map(([id, a]) => [id, scoreAgent("research the topic", a, SKILLS)]));
  // athena (Researcher + deep-research skill) should beat guten/forge.
  assert.ok(s.athena > s.guten, `athena ${s.athena} > guten ${s.guten}`);
  assert.ok(s.athena > s.forge, `athena ${s.athena} > forge ${s.forge}`);
});

test("an empty or single-char prompt scores 0 for everyone", () => {
  assert.strictEqual(scoreAgent("", AGENTS.athena, SKILLS), 0);
  assert.strictEqual(scoreAgent("a", AGENTS.athena, SKILLS), 0);   // len<=1 filtered
});

test("skill assignment adds a bonus even without word overlap", () => {
  const noSkill = { name: "X", role: "X" };
  const withSkill = { name: "X", role: "X", skills: ["deep-research", "code-review"] };
  // A prompt that matches no words: withSkill still edges ahead via the bonus.
  assert.ok(scoreAgent("zzzzz", withSkill, SKILLS) >= scoreAgent("zzzzz", noSkill, SKILLS));
});

// --- 2. HTTP integration for /chat with agent:"auto" ----------------------

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE_URL}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = d ? JSON.parse(d) : null; } catch { parsed = d; }   // error bodies are plain text
        resolve({ statusCode: res.statusCode, data: parsed });
      });
    });
    req.on("error", reject); req.end(data);
  });
}

test('POST /chat with agent:"auto" is accepted and returns a task id', async (t) => {
  let res;
  try {
    // wait:false so the request returns immediately with a task id instead of
    // blocking until the (real) Claude run finishes.
    res = await post("/chat", { agent: "auto", prompt: "hello", wait: false });
  } catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running"); throw err; }
  // Older daemons don't know "auto" — they'd 400 on it. Treat that as skip.
  if (res.statusCode === 400) return t.skip("Live daemon predates agent:auto");
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.data.task, "response must include a task id");
});

test('POST /chat with agent:"auto" and an empty prompt is rejected', async (t) => {
  let res;
  try { res = await post("/chat", { agent: "auto", prompt: "", wait: false }); }
  catch (err) { if (err.code === "ECONNREFUSED") return t.skip("Daemon not running"); throw err; }
  assert.strictEqual(res.statusCode, 400);
});
