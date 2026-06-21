# 🔀 Workflow Builder — Plan work in plain language, let the AI take it from there

The Workflow Builder is a canvas for sketching out work that lets you **drag and drop
nodes and type instructions in plain, everyday language** — for example, "Every
morning, summarize AI news and send it to Telegram" — then press **Analyze**, and the
**Director (Shino) reads your plan and tells you which skills/tools it needs, which
permissions to grant, and who to assign it to**. It's perfect for anyone who "wants
the office to do something but doesn't know how to ask for it."

> 💡 The difference from n8n is that **you don't have to wire up the logic precisely** —
> a node is an "intention," while the details and decisions are left to the AI team to
> figure out.

> 📌 **What it can do right now** — the Workflow Builder has 3 real buttons in the right panel:
> - **🔍 Analyze** — the Director reads the workflow and tells you which skills/tools/permissions are needed and who to assign it to (planning, no action taken)
> - **▶️ Run now** — tells the team to carry out this workflow **right now** and report back (nodes that branch into several paths run in parallel as ghost clones)
> - **🧠 Build as a Skill** — compiles the workflow into a skill you can tick on for an agent in the settings page, to reuse anytime (or just tell an agent "run &lt;workflow name&gt;")
>
> Recommended approach: **Analyze first → get everything ready (skill/permission/agent) → press Run now**, or **Build as a Skill** if you'll use it repeatedly.

---

## How to open it

1. Click the **⋯** button (more menu) on the chat header → choose **🔀 Workflow Builder**
2. The canvas window pops up (drag to move/resize it like a normal window)

Rough layout:

```
┌─ 🔀 Workflow Builder ───────────────────────────────────────────┐
│ [workflow name…]  ＋Node   📂Open…            💾Save   🔍Analyze  │
├──────────────────────────────────────┬──────────────────────────┤
│  ┌──────────────────────────┐        │  🤖 Plan from Director     │
│  │ 1  ⚡ Start when        ✕ │        │  ───────────────────────  │
│  │ "Every morning 9:00"     │        │  • this workflow does…     │
│  └────────────┬─────────────┘        │  • uses skill: …           │
│  ┌────────────┴─────────────┐        │  • needs to enable tool: … │
│  │ 2  ⚙ Action            ✕ │        │  • assign to: …            │
│  │ "Summarize 5 top topics" │        │  • questions to answer: …  │
│  └────────────┬─────────────┘        │                          │
│  ┌────────────┴─────────────┐        │                          │
│  │ 3  📤 Output            ✕ │        │                          │
│  │ "Send to Telegram"       │        │                          │
│  └──────────────────────────┘        │                          │
└──────────────────────────────────────┴──────────────────────────┘
        ↑ drag cards top→bottom = order of execution
```

---

## Node types

| Type | Use when | Example |
|---|---|---|
| ⚡ **Start when** (trigger) | A starting point / time condition | "Every morning 9:00", "When told to start" |
| ⬇ **Fetch** (fetch) | Pulling data in | "Search AI news", "Read file X", "Open URL" |
| ⚙ **Action** (action) | Process/create | "Summarize", "Write code", "Generate an image" |
| ◆ **Decision** (decision) | A branching condition | "If the site is down", "If the total exceeds 100" |
| 📤 **Output** (output) | Where the result goes | "Send to Telegram", "Write to a file", "Report to CEO" |
| 📝 **Note** (note) | Just a description | "Note: use the team's key" |

**Order of execution = top to bottom** (by the card's Y position) — drag cards up/down to reorder.

---

## How to use it (4 steps)

1. **Add nodes** — press **＋ Node** and drag them into place from top to bottom
2. **Type instructions** — double-click inside a card, type what you want it to do (plain language) + pick the node type
3. **Press 🔍 Analyze** — the Director reads the whole workflow and replies in the right panel:
   - what this workflow does (short summary)
   - which **skill/tool** each step uses (if there's no suitable skill yet, it tells you what to build)
   - which extra **permission/tool** needs to be enabled
   - which **agent** to assign it to, or whether to hire more
   - questions/gaps you need to decide on before actually running it
4. **💾 Save** — keep it to edit/reopen later (stored at `workspace/workflows/<id>.json`)
5. **▶️ Run now / 🧠 Build as a Skill** — when ready, tell the team to carry out the workflow immediately, or save it as a skill for reuse

> ℹ️ **"Analyze" is planning, not acting** — use it to see what skills/permissions/agents
> you need to prepare. When ready, press **▶️ Run now** (act for real) or **🧠 Build as a
> Skill** (keep it for reuse).

---

## 3 ready-to-use examples (open them to learn)

The first time you open the program, the system adds these examples for you — press
**📂 Open…** to browse them:

### 1) Daily AI news summary
```
⚡ Every morning 9:00  →  ⬇ Search latest AI news  →  ⚙ Summarize 5 top topics+links  →  📤 Send to chat/Telegram
```
Teaches: a time-based trigger + web data fetching (skill `deep-research`, tool `WebSearch/WebFetch`) + sending to a channel

### 2) Watch for a website going down
```
⚡ Every 30 minutes  →  ⬇ Open the site's URL  →  ◆ If not 200 OK  →  📤 Alert immediately
```
Teaches: an interval trigger + a decision node + alerting

### 3) Summarize meeting notes
```
⚡ On demand (attach transcript)  →  ⬇ Read the file  →  ⚙ Summarize+action items+owners  →  📤 Write to notes.md
```
Teaches: accepting a file + processing text (tool `Read/Write`) + saving the result to an office file

---

## Tips

- **Write the intent, not the exact steps** — "Summarize the news for me" is better than "GET /api then parse JSON…"; let the Director figure out how
- 1 node = 1 easy-to-understand step; don't cram several things into one node
- Press **Analyze** often while building — you'll learn what skills/permissions are still missing
- If the Director says "you should have skill X" → go build that skill (see the [skills guide](ai-features.md)) and analyze again

> 🚧 Coming up next: freely connecting nodes with lines on the canvas, scheduling
> workflows to run automatically on a trigger, and a Workflow Hub for sharing
> ready-made workflows (right now ▶️ Run now is a one-off, manual run).
