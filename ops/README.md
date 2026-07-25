# ops/ — the desk's out-of-process safety layer

Until 2026-07-25 every file in here lived only in `$HOME` with **no version
control at all**. That is a strange place for the layer whose entire job is to
notice when the trading daemon is broken: it could be edited or lost with no
history, no diff and no way to tell what changed after an incident.

The repo is now the source of truth. The live paths are symlinks:

```
~/desk-heartbeat.sh   -> bagidea-desk/ops/desk-heartbeat.sh
~/notify-telegram.sh  -> bagidea-desk/ops/notify-telegram.sh
~/desk-inspector.sh   -> bagidea-desk/ops/desk-inspector.sh
```

Symlinks rather than copies on purpose — a copy is a second version that drifts
silently, which is the exact failure class the rest of this work exists to
remove. Editing the repo file changes live behaviour immediately, so treat
these as production code.

`~/update-desk.sh` and `~/backup-desk-state.sh` are deliberately **not** linked:
`update-desk.sh` runs `git pull` on this very repo, so linking it would let a
pull replace the script mid-run.

## What each piece does

| file | trigger | job |
|---|---|---|
| `desk-heartbeat.sh` | `bagidea-heartbeat.timer`, every 15 min | Liveness watch. Runs OUTSIDE the daemon because a heartbeat inside it cannot tell you the daemon died. |
| `desk-heartbeat.sh weekly` | `bagidea-heartbeat-weekly.timer`, Mon 09:00 | One message a week. Also the canary: if the Telegram token is ever rotated, this going missing is how you find out. |
| `desk-inspector.sh` | `bagidea-inspector.timer`, hourly | Independent stop-coverage opinion from a *different codebase* (`javis-crypto-copilot`), across every `allowedSymbols` entry. |
| `notify-telegram.sh` | called by the above | Delivery. **Exits non-zero when the message did not arrive** and appends every attempt to `~/.local/state/bagidea/notify.log`. |

`systemd/` holds copies of the unit files for reference and review. They are
*not* symlinked — systemd owns `~/.config/systemd/user/`. If you change a unit,
change it there and copy it here in the same commit.

## The rule that keeps the heartbeat usable

**No heartbeat condition may reference trade count, PnL, signal count, or
scanner output.** The desk is deliberately flat and disarmed for long stretches;
a monitor that treats "flat" as an incident is a monitor that gets muted, and a
muted monitor is the same as no monitor. A green, flat, unpaused desk produces
**zero** messages.

Conditions that *are* allowed are all operational: the daemon not answering, the
monitor loop not completing a tick, duplicated trading loops, consecutive tick
errors, a desk position without stop coverage, a foreign position appearing, a
pause left on for more than a day, `autoTrade` still disabled by the daily-loss
breaker, and a stale news cache (a dependency being down, which silently stops
the desk arming).

Two behaviours that exist because their absence caused real incidents:

- **A warm-up grace period.** `lastOkTickAt` is null for up to one interval
  after every load, because only a *fully successful* tick sets it. Treating
  that as "stale" made a routine `/plugins/reload` page as an incident.
- **A resolution line.** Exactly one "✅ คลี่คลายแล้ว" when a paged condition
  clears. Without it you cannot tell a fixed problem from a silenced one.

## edge-validation/

`ratified-thresholds.json` — the acceptance criteria for the auto-signal edge
study, ratified by the owner **before any result existed**. That order is the
point: a bar set after seeing the outcome is not a bar. Editing a number here
after a result is known invalidates the study.

It is in git rather than under `workspace/` (which is gitignored) because it is
a governance decision, not research data. `workspace/edge-validation/` holds a
symlink to it so the study scripts find it at the expected path.
