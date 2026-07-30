# JAVIS Spot Command Center — BagIdea Office Bridge

This plugin places the JAVIS Spot accumulation and rebalance system inside the
BagIdea Office trading desk without connecting Spot analysis to the existing
Binance Futures execution commands.

## Capability boundary

`READ_ONLY_ANALYSIS`

The plugin can:

- read a canonical Spot snapshot from local files;
- validate schema, timestamp, freshness, size and capability fields;
- display portfolio valuation, scanner states, analytical buy/trim baskets and
  cash-floor projection;
- import a human-selected canonical JSON snapshot into plugin-local storage;
- read `GET /plugin/binance/snapshot` to show the existing Futures desk status;
- expose safe agent commands: `health`, `snapshot`, `asset`, `rebalance`,
  `combined`, and `open`.

The plugin cannot:

- enter or store Binance credentials;
- call `/plugin/binance/cmd`;
- create an order or execution intent;
- change the Futures desk, positions, configuration or pause state;
- treat Spot technical scores as permission to trade.

## Data flow

```text
JAVIS Spot application / Crypto Copilot
              |
              | atomic canonical JSON snapshot
              v
plugins/spot-command-center/index.js
              |
              +--> BagIdea panel + agent commands
              |
              +--> GET /plugin/binance/snapshot (read-only context)
```

Spot and Futures remain independent lanes. The combined-capital number is only
an estimate: Spot THB valuation plus Futures wallet equity converted using the
FX rate already present in the Spot snapshot.

## Default snapshot locations

The plugin checks the first valid file in this order:

1. `plugins/spot-command-center/data/latest-snapshot.json`
2. `%USERPROFILE%/javis-spot-command-center-data/latest-snapshot.json`
3. `E:\JARVIS-BrainOps\projects\javis-spot-command-center\data\latest-snapshot.json`
4. `E:\JARVIS-BrainOps\projects\javis-crypto-copilot\reports\spot-accumulation-latest.json`

Runtime configuration is created at:

`plugins/spot-command-center/data/config.json`

The entire `data/` directory is ignored by Git and must never contain committed
personal portfolio information.

## Accepted snapshot schemas

- `javis-spot-command-center/v1`
- `spot-command-center/v1`
- `spot-accumulation/v1`

The snapshot must explicitly remain read-only, have a valid generation time and
must not contain secret or execution fields.

## Current source-audit state

The recovered standalone Spot application works end-to-end, but its Phase-0
audit identified P1 hardening items. Until those are closed, the BagIdea panel
shows `SOURCE AUDIT: P1 HARDENING REQUIRED` and must not be treated as final
production decision evidence.

The most important locked policy for the next hardening mission is:

- **Do not recycle simulated trim proceeds into the same buy basket.** A trim is
  only analytical until a human performs and records it. Recompute after the
  recorded manual sale before allocating the resulting cash.

## Install / reload

The plugin is part of this BagIdea Office branch. Start the office normally, or
reload plugins while the daemon is running:

```powershell
curl.exe -s -X POST http://127.0.0.1:8787/plugins/reload -H "x-bagidea-ui: 1"
```

Open **Settings → Plugins → JAVIS Spot Command Center**.

## Agent examples

```powershell
curl.exe -s -X POST http://127.0.0.1:8787/plugin/spot-command-center/cmd `
  -H "content-type: application/json" `
  -d '{"cmd":"health","args":""}'

curl.exe -s -X POST http://127.0.0.1:8787/plugin/spot-command-center/cmd `
  -H "content-type: application/json" `
  -d '{"cmd":"asset","args":"BTC"}'
```

For Thai arguments on Windows, write the request JSON to a UTF-8 file and use
`--data-binary @body.json`, as documented by BagIdea Office.

## Verification

```powershell
node --check plugins/spot-command-center/index.js
node --test daemon/tests/spot-command-center-plugin.test.js
npm test
```

No merge or deployment should occur until the standalone Spot P1 hardening and
this bridge's tests both pass.
