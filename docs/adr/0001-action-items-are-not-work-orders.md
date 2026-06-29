# ADR 0001: Action Items are not Work Orders

- **Status:** Proposed
- **Date:** 2026-06-27
- **Context:** Meeting enhancement plan

## Context

The agent-meeting enhancement needs somewhere to persist the **Action Items**
meetings produce ("@nida will write tests by Friday"). The codebase already has
a scheduled-work store (`jobs.json`): Work Orders with `now` / `at` / `every`
time semantics. An obvious shortcut is to route Action Items into that store as
`{ mode: "at", at: <deadline> }` entries.

The original plan additionally claimed it would "create tasks in Mission
Control," but Mission Control is a transient live-execution monitor with no
persistence (see `CONTEXT.md`), so that path does not exist.

## Decision

**Action Items get their own flat-JSON store, separate from Work Orders.** We do
not reuse `jobs.json`, and we do not pretend Mission Control is a task store.

Concretely: per-meeting Action Item files at
`workspace/meetings/<meeting-key>.actions.json`, matching the existing
`workspace/meetings/<key>.md` one-file-per-meeting idiom and the
`loadJson` / `saveJson` helper convention already in the daemon.

## Rationale (the trade-off)

An **Action Item** and a **Work Order** are different entities:

| | Work Order (Job) | Action Item |
|---|---|---|
| Semantics | *when* — fires by the clock | *who/what* — fires when the owner acts |
| Fields | `mode, everyMin, at, time` | `owner, text, status` |
| Lifecycle | run → done (one-shots self-delete) | open → done |
| Trigger | scheduler tick | the owner |

Routing Action Items into `jobs.json` would force them into `{mode:"at",
at:<due>}`, which **fires the assigned prompt as a Claude run at the deadline**
— that is "auto-run the agent," not "assign a task." Worse, one-shot `at` jobs
self-delete after running, so the Action Item would vanish from the store the
moment it becomes "due," regardless of whether it was completed. That is a
category error baked into the data.

A separate store keeps the two lifecycles honest, costs one more flat-JSON file
convention (already the house style — `registry.json`, `sessions.json`,
`proposals.json`, `jobs.json`, …), and leaves room for Action-Item-specific
queries (open items by owner, items from a meeting) without contaminating the
scheduler.

## Consequences

- One new store + helpers (`loadActions` / `saveActions`), mirroring
  `loadJson` / `saveJobs`.
- Action Items are **not** rendered on the Mission Control board (that board is
  live-execution state, not a backlog). They live in the meeting's
  `.actions.json` and the meeting's `.md` summary.
- The brittle regex originally planned for parsing action items out of the
  summary is replaced by asking the summary model for a structured `actionItems`
  array, validated against the roster.
