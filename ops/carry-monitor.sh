#!/usr/bin/env bash
# carry-monitor.sh — daily funding-regime watch across the 15-symbol universe.
#
# Context (look #15-16): funding carry is structurally real (85.6% of 8h windows
# positive over 3.5y, ranking skill z=16 vs random) but the premium compressed
# to NEGATIVE cross-sectionally in 2026-H1. The durable asset is knowing WHEN it
# reopens, not a position opened today.
#
# ==== DECISION PROTOCOL — PRE-WRITTEN, read it when the alert fires ==========
# An alert here is INFORMATION ONLY. There is no live action on this desk:
# carry needs a spot leg (mainnet) or quarterly liquidity, and MAINNET IS NEVER
# DELEGATED (ops/mandate.json). The pre-agreed next step is exactly one thing:
# open a pre-registered study manifest and charge it to the look ledger.
# Improvising a mainnet account in the excitement of an alert is the precise
# behavior this paragraph exists to slow down.
# =============================================================================
set -uo pipefail
STATE_DIR="$HOME/.local/state/bagidea"
OUT="$HOME/bagidea-dashboard-data/carry-monitor.json"
LOG="$STATE_DIR/carry-history.jsonl"
NOTIFY="$HOME/notify-telegram.sh"
mkdir -p "$STATE_DIR" "$(dirname "$OUT")"

python3 - "$LOG" "$OUT" <<'PY'
import json, sys, time, urllib.request

LOGF, OUTF = sys.argv[1], sys.argv[2]
SYMS = ("BTCUSDT ETHUSDT SOLUSDT BNBUSDT XRPUSDT DOGEUSDT ADAUSDT AVAXUSDT "
        "LINKUSDT LTCUSDT DOTUSDT TRXUSDT ATOMUSDT NEARUSDT APTUSDT").split()
ALERT_ANNUALIZED = 8.0   # %/yr trailing-30d — roughly the 2024 regime, clearly above costs

rows = {}
for s in SYMS:
    try:
        # Public mainnet endpoint, read-only. 90 windows = 30 days.
        u = f"https://fapi.binance.com/fapi/v1/fundingRate?symbol={s}&limit=90"
        data = json.load(urllib.request.urlopen(u, timeout=15))
        rates = [float(r["fundingRate"]) for r in data]
        if len(rates) >= 30:
            ann = sum(rates) / len(rates) * 3 * 365 * 100
            rows[s] = round(ann, 2)
    except Exception:
        rows[s] = None   # unreachable is reported, never guessed

ts = int(time.time() * 1000)
ok = {k: v for k, v in rows.items() if v is not None}
snapshot = {
    "ts": ts, "trailing30d_annualized_pct": rows,
    "cross_sectional_mean": round(sum(ok.values()) / len(ok), 2) if ok else None,
    "alert_threshold": ALERT_ANNUALIZED,
    "above_threshold": sorted([k for k, v in ok.items() if v >= ALERT_ANNUALIZED]),
    "fetch_failures": sorted([k for k, v in rows.items() if v is None]),
}
with open(LOGF, "a") as f:
    f.write(json.dumps(snapshot) + "\n")
json.dump(snapshot, open(OUTF, "w"), indent=1)

hot = snapshot["above_threshold"]
print(json.dumps({"mean": snapshot["cross_sectional_mean"], "hot": hot,
                  "failures": snapshot["fetch_failures"]}))
# Alert only on majors crossing — alt funding spikes are noise and would train
# the owner to ignore this channel.
sys.exit(3 if any(s in hot for s in ("BTCUSDT", "ETHUSDT")) else 0)
PY
rc=$?

if [ "$rc" -eq 3 ]; then
  STATE="$STATE_DIR/carry-alert-state"
  LAST=$(cat "$STATE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  # One page per week at most — a regime is a season, not an event.
  if [ $((NOW - LAST)) -gt 604800 ]; then
    "$NOTIFY" "📈 funding regime เปิดอีกครั้ง: BTC/ETH trailing-30d ≥ 8%/ปี — นี่คือ 'ข้อมูล' ไม่ใช่คำสั่งเทรด · ขั้นถัดไปเดียวที่ตกลงไว้ = เปิด study manifest แบบ pre-registered (อ่าน DECISION PROTOCOL ใน ops/carry-monitor.sh) · mainnet = CEO เท่านั้น เสมอ" \
      && echo "$NOW" > "$STATE"
  fi
fi
exit 0
