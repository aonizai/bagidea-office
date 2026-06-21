# Browse the web & click through tasks for you (Web automation)

> Let your agents **drive a real browser** — visit sites, click buttons, type, fill
> in/submit forms, scroll pages, take screenshots to look at, and pull text — like
> having an assistant who sits and clicks through the web for you.

The office ships with **Playwright MCP** (Claude Code's standard for controlling a
browser) built in and ready to use, under the server name `web` — just tick it on for
an agent and it works.

## Enabling it (one tick)

**The easiest way — add a skill:**

1. **⚙ → AGENTS →** pick the agent you want to give web access (e.g. **Shino/Director**) → **Edit**
2. Under **SKILLS**, tick **🌐 Web Automation** → **Save**
3. That's it — the agent can now use the web. This skill **bundles the tool in automatically**
   (opens in a visible window) along with a built-in usage guide, so the agent gets up to
   speed faster instead of spending ages on trial and error.

You can give it tasks right away, e.g. *"Go to example.com, find the pricing, and summarize it as a table."*

### Choose: show it on screen vs. run in the background

The office sets up **2** MCP servers for you (under **⚙ → 🔌 MCP SERVERS**, no need to add them yourself):

| Tool | Mode | Use when |
|---|---|---|
| **🔌 web** | 👀 On screen (headed) | You want to watch the agent click/type live — **the skill's default** |
| **🔌 web-bg** | 🤫 Background (headless) | You want it done quietly, with no window popping up |

- Add **just the skill** → you get **on-screen** mode automatically
- To run in the background → on the agent's edit page, under **TOOLS**, tick **🔌 web-bg** (the skill will respect this one instead)
- Or just tell the agent directly when giving a task: *"Do it in the background"* / *"Show me on screen"* (if the agent has both tools)

## The first run is a bit slow

The first time an agent uses it, the system **downloads the browser (Chromium) once** —
so the first round is a little slow, then it's normal speed after that. You need
Node/`npx` (the installer set this up for you).

## Watch the agent work live

Opening in **headed** mode = an **actual browser window pops up** so you can watch the
agent click/type in real time. You can close the window yourself when it's done.

## Security

- **Separate profile, not logged in** (`--isolated`) — every run starts from a clean
  state and **doesn't touch the cookies/passwords/sessions** you're logged into in your
  normal browser.
- **Every action goes through the Security Center** (PreToolUse hook) — the first time it
  visits a site/clicks, an approval card pops up; press ✓ once, or **✓✓ Always** to
  remember it permanently.
- Only agents you've ticked on can use the web (least-privilege).

## Example tasks

```
Go to news.ycombinator.com and summarize the first 5 topics for me
Open GitHub trending for today and take a screenshot for me
Go to shop X's website, find the 3 cheapest "headphones," with links
Fill in the contact form on this page with the info I give you, then screenshot the confirmation page
```

## Advanced: have it use "my login"

The default deliberately **stays logged out** for safety. If you genuinely need the agent
to work behind a real login (e.g. a back office that requires signing in), edit the
command of the `web` server under **⚙ → 🔌 MCP SERVERS**: change `--isolated` to
`--user-data-dir "C:\path\to\profile"` to persist the session, then log in once in the
window that pops up.

> ⚠️ Caution: this mode = the agent can access everything in the logged-in account. Use
> it only with sites you trust and agents you control.

## Turning it off / removing it

- Remove **🔌 web** from the agent's TOOLS (revoke access for just that agent), or
- Delete the **web** server under **⚙ → 🔌 MCP SERVERS** (revoke it office-wide — once deleted it won't come back on its own)

---

> **Tidbit:** this idea was inspired by [PixelRAG](https://github.com/StarTrail-org/PixelRAG),
> which focuses on *"reading the web as images"* (screenshots + a vision model) — this one
> does **both reading** (screenshots for Claude to see with its eyes) **and real clicking**
> (clicking/typing/filling out forms).
