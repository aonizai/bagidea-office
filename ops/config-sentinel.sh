#!/usr/bin/env bash
# config-sentinel.sh — compares the LIVE config against ops/mandate.json.
#
# Why: all three of this desk's recorded loss modes were silent config drift
# (fee-bleed defaults, a riskPct 2 / maxLeverage 20 drift caught only by manual
# luck, and throughput pushed 100x in one edit). The mandate file in git is the
# single source of truth; live divergence is an incident, not a preference.
#
# Output: prints one line per drifted key; exit 0 = clean, exit 2 = drift.
# The heartbeat consumes this — it does NOT fix anything. A sentinel that
# silently "corrects" config would itself be an unaudited writer.
set -uo pipefail
MANDATE="$(dirname "$0")/mandate.json"
CONFIG="/home/tiwa/bagidea-desk/plugins/binance/data/config.json"

python3 - "$MANDATE" "$CONFIG" <<'PY'
import json, sys
mandate = json.load(open(sys.argv[1]))["pinned_config"]
cfg = json.load(open(sys.argv[2]))

def resolve(d, dotted):
    cur = d
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return ("<absent>",)
        cur = cur[part]
    return (cur,)

drift = []
for key, want in mandate.items():
    if key.startswith("_"):
        continue
    (got,) = resolve(cfg, key)
    if got != want:
        drift.append((key, want, got))

if drift:
    for key, want, got in drift:
        print(f"DRIFT {key}: mandate={json.dumps(want)} live={json.dumps(got)}")
    sys.exit(2)
print("clean")
sys.exit(0)
PY
