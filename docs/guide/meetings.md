# Agent Meetings

Meetings let a group of agents discuss a topic together, with the owner (you,
the CEO) optionally participating live. A meeting produces a persisted
transcript, a summary, and action items.

> Domain terms used below (Meeting, Meeting Log, Phase, Action Item, Work
> Order, Mission Control) are defined in [`../../CONTEXT.md`](../../CONTEXT.md).
> Why action items have their own store is explained in
> [`../adr/0001-action-items-are-not-work-orders.md`](../adr/0001-action-items-are-not-work-orders.md).

## Starting a meeting

Open the launcher (the 🗣 button). Pick a **template** or write a custom topic,
choose 2–4 participants (agents other than the CEO), and set the number of
**discussion rounds**.

### Templates

| Template | Topic | Rounds |
|----------|-------|--------|
| Standup | what you did / will do / blockers | 1 |
| Retro | what went well / badly / to improve | 2 |
| Brainstorm | idea generation, no judgment | 3 |
| Design Review | questions, constructive critique, suggestions | 2 |
| Planning | goal, steps, owners, timeline | 2 |

## Structure (phases)

A non-social meeting runs in two phases:

1. **Opening** — each agent gives a 1–2 sentence starting position, grounded in
   related projects, past meetings on the topic, and the agent's own private
   memory.
2. **Discussion** — `rounds` rounds of back-and-forth, building on each other.

Decisions and action items are **not** agent turns — they are synthesized by a
single **summary** call after the meeting ends, so there's one canonical list
rather than N competing ones.

> Social/break-room chats (ambient ticks) collapse to a single unstructured
> `chat` phase and may surface `PROPOSAL:` lines.

## Participating live

When a meeting you started is live, the chat pane shows a **speak bar**. Type
and send — your message enters the transcript (tagged as the `user` phase) and
agents pick it up on their next turn via the discussion window.

The speak bar appears **only** on the live meeting. Finished meeting logs and
sub-agent (`@sub`) logs stay read-only.

## Live controls

| Control | Effect |
|---------|--------|
| ⏸ Pause | Don't start the next speaker's turn (the current turn, if mid-speech, finishes first). |
| ▶ Resume | Continue from where it paused. |
| 🏁 End | Adjourn the meeting immediately; the summary + action items are generated, the transcript is written, and the meeting is removed from the live registry. |

Pause is *graceful* — it takes effect between turns, not mid-turn.

## Outputs

After a meeting ends, the daemon writes:

- `workspace/meetings/<key>.md` — the transcript with the summary prefixed, each
  message tagged with its phase.
- `workspace/meetings/<key>.actions.json` — action items as structured data:
  `{ id, meeting, owner, text, due, status, created }`. The owner is always a
  validated roster id.
- A retrieval-index entry (tier `arch`) so future meetings on the same topic
  can find this one.

Each action item also surfaces as a chip in the activity feed.

> **Mission Control** is a *live-execution monitor* — it shows which agents are
> currently running which work, colored by state. It is **not** a task store:
> it's empty on reload and does not hold action items. Action items live in
> their per-meeting `.actions.json` file (see ADR-0001).

## Recall

Search past meetings with `/recall?q=<topic>` — it queries the in-memory BM25
index, including the `arch` tier where meetings are indexed.

## API (for plugin authors)

| Endpoint | Method | Body | Purpose |
|----------|--------|------|---------|
| `/discuss` | POST | `{ agents:[...], topic, rounds }` | Start a meeting. |
| `/discuss/message` | POST | `{ session, text }` | Inject an owner message into a live meeting. 404 if not active. |
| `/discuss/control` | POST | `{ session, action: pause\|resume\|skip\|end, agent? }` | Control a live meeting. |
| `/sessions/log?agent=@group&key=<key>` | GET | — | Read a meeting transcript. |
