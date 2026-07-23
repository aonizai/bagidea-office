# Sentiment Auto-Scan

BagIdea Office plugin. Scans crypto news, Binance funding rate, and the Fear &
Greed Index on a schedule, and reports a bullish / bearish / neutral sentiment
bias with sources — headless-first (Pulse drives it via `cmd`), panel is a thin
live view on top.

Built to the shape in `docs/guide/plugins.md`. All three phases are done and
the plugin is live at `plugins/sentiment-autoscan/`.

## Files

- `plugin.json` — manifest: id `sentiment-autoscan`, declares the panel and
  four commands (`scan-now`, `config-get`, `config-set`, `status`).
- `index.js` — real scan engine (funding + Fear&Greed via public HTTP, news
  via `ctx.runClaude("pulse", ...)`), config/state persistence, a
  `setInterval` scheduler that restarts on every `config-set` and on plugin
  load, and a deduped high-impact broadcast (`ctx.broadcast` + `ctx.feed`).
- `panel.html` — real UI: config form (enabled/interval/sources/lead
  minutes/broadcast toggle), Scan now button, live snapshot (bias, funding,
  Fear&Greed, news, high-impact countdown), subscribed to the plugin's WS
  events for live updates.
- `config.schema.json` — the config shape (below), documented as a JSON Schema.

## Config schema

```json
{
  "enabled": false,
  "intervalMinutes": null,
  "sources": { "news": true, "funding": true, "fearGreed": true },
  "highImpactLeadMinutes": 30,
  "broadcastEnabled": false
}
```

| field | type | default | notes |
|---|---|---|---|
| `enabled` | bool | `false` | scheduler on/off — owner opts in |
| `intervalMinutes` | int\|null | `null` | owner-set scan cadence; `null` = not configured (manual `scan-now` still works) |
| `sources.news` | bool | `true` | crypto news via WebSearch |
| `sources.funding` | bool | `true` | Binance funding rate (premiumIndex) |
| `sources.fearGreed` | bool | `true` | Fear & Greed Index |
| `highImpactLeadMinutes` | int | `30` | minutes-before-event threshold for CPI/FOMC/NFP broadcast eligibility |
| `broadcastEnabled` | bool | `false` | push `plugin.event` + feed post when a high-impact event crosses the lead time |

Persists at `ctx.dataDir/config.json` (i.e. `plugins/sentiment-autoscan/data/config.json`).
State (`lastScanAt`, `nextScanAt`, `lastBias`, `lastBroadcastKey`) persists at
`ctx.dataDir/state.json`. Both are gitignored, auto-created.

## Three-phase architecture (all done)

**Phase 1 — config/skeleton.** Manifest, command surface, config schema,
stub handlers that keep `reload` green.

**Phase 2 — scan engine (Blitz).** Real logic in `scan-now`/`config-get`/`config-set`:
- Read/write `ctx.dataDir/config.json`, validated against `config.schema.json`.
- Fetch `sources.funding` (Binance `premiumIndex`, public) and `sources.fearGreed`
  (public) directly from `index.js` via plain HTTP — no key needed.
- `sources.news` runs via `ctx.runClaude("pulse", prompt)` — a real WebSearch
  turn that hands back structured JSON (items, highImpactEvents, overallBias).
- `computeBias()` is the single source of truth for the bias score/reasons —
  used by both manual `scan-now` and the scheduled scan.

**Phase 3 — scheduler + broadcast + panel (Ledger).**
- `startTimer()`/`stopTimer()` wrap a single `setInterval` handle that calls
  the same `runScan()` used by `scan-now` — no forked logic. Restarted on
  every `config-set` and once on plugin load, based on `enabled` +
  `intervalMinutes`. `nextScanAt` is tracked in `state.json`.
- `status` reports `{ enabled, lastScanAt, nextScanAt, lastBias }` from real
  scheduler state.
- Broadcast: when the nearest high-impact event is within
  `highImpactLeadMinutes` and `broadcastEnabled` is true, `runScan()` sends
  `ctx.broadcast({ type: "plugin.event", plugin: "sentiment-autoscan",
  event: "high-impact", snapshot, message })` and `ctx.feed(message, "pulse")`.
  Deduped by `state.lastBroadcastKey` (event name + eventTimeUtc) so the same
  event doesn't re-fire every scheduled scan.
- `panel.html`: config form (enabled/interval/sources/lead minutes/broadcast
  toggle), Scan now button, live snapshot (bias + reasons, funding, Fear&Greed,
  news, high-impact countdown), subscribed to `ws://.../ws` for
  `plugin.event` (`scan` / `high-impact` / `config`) so it updates without
  polling.

## Verified live (2026-07-17)

Copied into `plugins/sentiment-autoscan/`, reloaded via `POST /plugins/reload`,
and exercised against the running daemon:
- **Scheduler**: `config-set {enabled:true, intervalMinutes:5}` moved
  `status.nextScanAt` forward immediately; ~5 minutes later `lastScanAt`
  advanced on its own (08:22:48 → 08:39:28) with no manual `scan-now` call —
  the scheduled tick runs the exact same `runScan()` path. `config-set
  {enabled:false}` stopped the timer and reset `nextScanAt` to `null`.
  A follow-up `config-set {intervalMinutes:7, broadcastEnabled:true}` +
  10s re-read of `config.json` confirmed persistence is stable (no silent
  reset from reload/timer activity).
- **Broadcast + dedupe**: exercised via a standalone harness that loads the
  real `index.js` against a mock `ctx` (isolated temp `dataDir`, spied
  `broadcast`/`feed`, `runClaude` stubbed to return one synthetic high-impact
  event 10 minutes out). Two consecutive `scan-now` calls on the same event
  produced exactly **one** `high-impact` broadcast + one `ctx.feed` call —
  the second scan correctly deduped via `state.lastBroadcastKey`.
- **Panel**: `GET /plugin/sentiment-autoscan/panel` returns 200 with the full
  page; headless Chrome screenshot confirmed the config form renders and
  populates from live `config-get`/`status` on load (dark theme, Thai labels
  render correctly).
- Config reset to defaults (`enabled:false, intervalMinutes:null,
  sources:{news,funding,fearGreed:true}, highImpactLeadMinutes:30,
  broadcastEnabled:false`) before handoff.
