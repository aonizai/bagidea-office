# 🎛 JAVIS Trading Desk — read-only portal

Capability: **`READ_ONLY_DESK_PORTAL`**

A single browser page that unifies the desk's read models. It renders no
execution control, holds no credential, and issues no request that can change
Futures, Spot, portfolio or account state.

## What it reads

| Subsystem | Source (loopback GET only) | When absent |
|---|---|---|
| Futures | `GET /plugin/binance/snapshot` | `UNAVAILABLE` |
| Spot | `GET /plugin/spot-command-center/state` | **`NOT_INSTALLED`** + `P1_HARDENING_REQUIRED` |
| Performance Journal | `GET /plugin/performance-journal/state` | **`NOT_CONNECTED`** |

Every source is fetched independently, so one failing subsystem cannot take the
page down. Sources must be loopback: a non-loopback URL is refused before any
request is made.

## What it will not do

- never calls `POST /plugin/binance/cmd` — the string does not exist in the code
- never issues any verb other than `GET`
- renders **zero** `<button>`, `<input>`, `<form>` or `<select>` elements
- no order, close, stop-loss, leverage, cancel, auto-trade or set-keys path
- strips credential-shaped keys (`api_key`, `apiSecret`, `authorization`,
  `passphrase`, `seed`, …) from any child payload before it reaches the browser
- never forwards a Spot score to Futures execution

## Honesty rules

- A Spot snapshot may only display `VERIFIED_LOCAL` if it says so explicitly.
  Anything else is shown as `P1_HARDENING_REQUIRED`.
- Fixture or mock data is never presented as live.
- Partial data can never render as `HEALTHY`.
- When a refresh fails, the last known model stays on screen but is labelled
  `STALE` with the time it was captured.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/plugin/trading-desk-home/panel` | GET | the portal page |
| `/plugin/trading-desk-home/state` | GET | `javis-trading-desk-home/v1` read model |
| `/plugin/trading-desk-home/health` | GET | compact health for probes |

Agent commands: `health`, `summary` — both read-only.

## Polling

15 s interval · 8 s abort timeout · one request at a time · exponential backoff
to 120 s on failure · paused while the tab is hidden · same-origin relative URL,
so it behaves identically behind the reverse proxy.

## Tests

```bash
node --check plugins/trading-desk-home/index.js
node --test daemon/tests/trading-desk-home-plugin.test.js
```
