// 🧠 Copilot Link — file-based bridge to JAVIS Crypto Copilot.
// Zero-dependency: Node built-ins only. Reads the decision snapshots Copilot
// writes to reports/, and can trigger a fresh review via Bash. Advisory only —
// Copilot is paper-only per its CHARTER; this plugin never executes trades.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const DEFAULTS = {
  // Canonical path to the Copilot project (where pyproject.toml + reports/ live).
  copilotPath: "E:\\JARVIS-BrainOps\\projects\\javis-crypto-copilot",
  reportsDir: "reports",
  pythonCmd: "python",
  // A decision older than this (seconds) is flagged stale.
  maxAgeSec: 900,
  // Timeout for run-analysis (Copilot review can take a while).
  runTimeoutMs: 120000,
};

module.exports = (ctx) => {
  const cfgFile = path.join(ctx.dataDir, "config.json");
  try {
    fs.mkdirSync(ctx.dataDir, { recursive: true });
    if (!fs.existsSync(cfgFile))
      fs.writeFileSync(cfgFile, JSON.stringify(DEFAULTS, null, 2));
  } catch (e) { ctx.log("copilot-link: config init failed: " + e.message); }

  const cfg = () => {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch {}
    return { ...DEFAULTS, ...c };
  };

  // Resolve a file under the Copilot reports dir.
  const reportPath = (name) => path.join(cfg().copilotPath, cfg().reportsDir, name);
  // Read + parse JSON, returns null on any failure.
  const readJson = (p) => {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
  };
  // Parse an ISO timestamp into age-seconds (now - ts). Returns null if unparseable.
  const ageSec = (iso) => {
    try { return Math.round((Date.now() - new Date(iso).getTime()) / 1000); } catch { return null; }
  };
  // Does the Copilot project look installed (pyproject.toml + src/trading_partner)?
  const isInstalled = () => {
    const c = cfg();
    return fs.existsSync(path.join(c.copilotPath, "pyproject.toml")) &&
           fs.existsSync(path.join(c.copilotPath, "src", "trading_partner"));
  };

  // Summarize a decision snapshot into the fields agents actually use.
  // The full latest-decision.json is rich (7KB); this distills it.
  const summarize = (d) => {
    if (!d) return null;
    const er = d.execution_readiness || {};
    const fr = d.futures_risk_gate || {};
    const ao = d.anti_overtrade_gate || {};
    const mc = d.market_context || {};
    return {
      decision: d.decision || "UNKNOWN",        // GO / NO_GO / UNKNOWN
      direction: d.direction || "UNKNOWN",       // LONG / SHORT / UNKNOWN
      symbol: (mc.symbol || d.symbol || "").toUpperCase(),
      grade: d.grade || null,                     // A / B / C / needs_revision (if present)
      decision_id: d.decision_id || "",
      generated_at: d.generated_at || "",
      ageSec: ageSec(d.generated_at),
      stale: ageSec(d.generated_at) > cfg().maxAgeSec,
      // Risk gates — the cross-check Compass uses.
      risk_gate: {
        futures: fr.status || "UNKNOWN",          // PASS / FAIL / UNKNOWN
        anti_overtrade: ao.status || "UNKNOWN",
        reasons: [...(fr.reason_codes || []), ...(ao.reason_codes || [])],
      },
      // Execution readiness — whether Copilot's governance allows dispatch.
      execution: {
        capability_status: er.capability_status || "UNKNOWN",  // DISABLED / ENABLED
        runtime_mode: er.runtime_mode || "UNKNOWN",            // DRY_RUN / LIVE
        dispatch_available: er.dispatch_available || false,
        dispatch_blocked: er.dispatch_blocked_reasons || [],
        testnet_promoted: er.testnet_promoted || false,
      },
      // Market context (entry/stop/target come from the trade plan, not always present).
      market: {
        reference_price: mc.reference_price || null,
        structure_state: mc.structure_state || null,
        recent_swing_high: mc.recent_swing_high || null,
        recent_swing_low: mc.recent_swing_low || null,
      },
    };
  };

  return {
    onCommand(cmd, args, reply) {
      // decision — the primary read. Distilled summary of latest-decision.json.
      if (cmd === "decision") {
        const d = readJson(reportPath("latest-decision.json"));
        if (!d) {
          return reply({ ok: false, msg: "ไม่พบ latest-decision.json — สั่ง run-analysis ก่อน หรือเช็ค copilotPath ใน config" });
        }
        const s = summarize(d);
        ctx.broadcast({ type: "plugin.event", plugin: "copilot-link", event: "decision-read" });
        return reply({ ok: true, ...s });
      }

      // report — the lighter latest.json (status summary).
      if (cmd === "report") {
        const r = readJson(reportPath("latest.json"));
        if (!r) return reply({ ok: false, msg: "ไม่พบ latest.json" });
        return reply({
          ok: true,
          symbol: r.symbol || "",
          status: r.status || "UNKNOWN",
          grade: r.grade || "UNKNOWN",
          summary: r.summary || "",
          blockers: r.blockers || [],
          warnings: r.warnings || [],
          generated_at: r.generated_at || "",
          ageSec: ageSec(r.generated_at),
        });
      }

      // run-analysis — spawn Copilot's review, then return the fresh decision.
      // This is the heaviest command: it runs python synchronously (up to the
      // timeout) and blocks the reply until Copilot finishes writing reports.
      if (cmd === "run-analysis") {
        const symbol = String(args || "").trim().toUpperCase();
        if (!symbol) return reply({ ok: false, msg: "usage: run-analysis <symbol>   เช่น run-analysis BTCUSDT" });
        const c = cfg();
        if (!isInstalled()) return reply({ ok: false, msg: "Copilot ไม่ได้ติดตั้งที่: " + c.copilotPath + " (ไม่พบ pyproject.toml)" });
        // Copilot's CLI: python -m trading_partner review --symbol BTCUSDT
        // (subcommand may vary; we try 'review' then 'market-preview' as fallback.)
        const tryReview = (sub, cb) => {
          execFile(c.pythonCmd, ["-m", "trading_partner", sub, "--symbol", symbol],
            { cwd: c.copilotPath, timeout: c.runTimeoutMs, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => cb({ err, stdout: String(stdout || "").slice(-4000), stderr: String(stderr || "").slice(-2000) })
          );
        };
        return tryReview("review", (r1) => {
          // If 'review' errored badly (e.g. wrong subcommand), try 'market-preview'.
          if (r1.err && /usage|invalid choice|unrecognized|no such option/i.test(r1.err.message + r1.stderr)) {
            ctx.log("copilot-link: 'review' failed, trying 'market-preview'");
            return tryReview("market-preview", (r2) => {
              const d = readJson(reportPath("latest-decision.json"));
              const s = summarize(d);
              ctx.broadcast({ type: "plugin.event", plugin: "copilot-link", event: "analysis-run", symbol });
              reply({
                ok: !!s,
                symbol, subcommand: "market-preview",
                exitOk: !r2.err,
                stdout: r2.stdout.slice(-1500), stderr: r2.stderr.slice(-800),
                decision: s,
                msg: s ? `Copilot รันเสร็จ — decision: ${s.decision} (${s.decision_id})` : "Copilot รันแล้วแต่ไม่มี decision snapshot",
              });
            });
          }
          const d = readJson(reportPath("latest-decision.json"));
          const s = summarize(d);
          ctx.broadcast({ type: "plugin.event", plugin: "copilot-link", event: "analysis-run", symbol });
          reply({
            ok: !!s,
            symbol, subcommand: "review",
            exitOk: !r1.err,
            error: r1.err ? r1.err.message : null,
            stdout: r1.stdout.slice(-1500), stderr: r1.stderr.slice(-800),
            decision: s,
            msg: s ? `Copilot รันเสร็จ — decision: ${s.decision} (${s.decision_id})` : "Copilot รันแล้วแต่ไม่มี decision snapshot (เช็ค stderr)",
          });
        });
      }

      // health — is Copilot installed + reports fresh?
      if (cmd === "health") {
        const c = cfg();
        const installed = isInstalled();
        const decPath = reportPath("latest-decision.json");
        const repPath = reportPath("latest.json");
        const d = readJson(decPath);
        const age = d ? ageSec(d.generated_at) : null;
        return reply({
          ok: true,
          installed,
          copilotPath: c.copilotPath,
          pyprojectExists: fs.existsSync(path.join(c.copilotPath, "pyproject.toml")),
          reportsExist: fs.existsSync(decPath) || fs.existsSync(repPath),
          decisionAgeSec: age,
          stale: age != null ? age > c.maxAgeSec : null,
          maxAgeSec: c.maxAgeSec,
          msg: installed
            ? (age != null
              ? (age > c.maxAgeSec ? `⚠️ ข้อมูลเก่า (${age}s > ${c.maxAgeSec}s)` : `✓ สด (${age}s)`)
              : "ติดตั้งแล้ว แต่ยังไม่มี decision")
            : "✗ ไม่พบ Copilot ที่ " + c.copilotPath,
        });
      }

      return reply({ ok: false, msg: "unknown command (decision | report | run-analysis <symbol> | health)" });
    },
  };
};
