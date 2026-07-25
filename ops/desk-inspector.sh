#!/usr/bin/env bash
# JC-3: independent position inspector — engine `monitor` reads the SAME testnet
# account the desk trades on (key pulled from plugin config AT RUNTIME only;
# never logged/stored). Quiet when healthy; Telegram alert on naked position /
# orphan / unverified coverage / any read failure.
#
# Two changes from the original, both about not lying by omission:
#
#  1. It covers EVERY tradeable symbol, not just ETHUSDT. allowedSymbols is 5
#     coins; inspecting one of them left the two most recently traded (SOL, BNB)
#     unchecked by anything outside the daemon.
#  2. notify-telegram.sh's exit code is CHECKED. The old script called it and
#     then `exit 0` unconditionally "to stop OnFailure re-firing" — which meant
#     a rotated token silenced the alert AND suppressed the failure signal, the
#     exact silent-inspector failure the header warns about. Now a failed
#     delivery exits non-zero so OnFailure fires.
#
# Since the plugin verifies stop coverage itself every 30s (see reconcile()),
# this is no longer the only coverage check — it is the independent second
# opinion from a different codebase, which is what justifies the wider sweep.
set -uo pipefail
CONF=/home/tiwa/bagidea-desk/plugins/binance/data/config.json
NOTIFY=/home/tiwa/notify-telegram.sh

alert() {   # returns non-zero if the message did not actually reach Telegram
  "$NOTIFY" "$1" >/dev/null 2>&1
}

SYMBOLS=$(python3 -c "
import json
c = json.load(open('$CONF'))
s = c.get('allowedSymbols') or ['ETHUSDT']
print(' '.join(s))
" 2>/dev/null) || SYMBOLS=""
if [ -z "$SYMBOLS" ]; then
  alert "⚠️ INSPECTOR อ่าน allowedSymbols จาก config ไม่ได้ — ตรวจไม่ได้เลย" || exit 1
  exit 1
fi

export CRYPTO_COPILOT_API_KEY=$(python3 -c "import json;print(json.load(open('$CONF'))['apiKey'])")
export CRYPTO_COPILOT_API_SECRET=$(python3 -c "import json;print(json.load(open('$CONF'))['apiSecret'])")
export CRYPTO_COPILOT_ENABLE_T4_TESTNET=1
cd /home/tiwa/javis-crypto-copilot || exit 1

DELIVERY_FAILED=0
for SYM in $SYMBOLS; do
  OUT=$(PYTHONPATH=src timeout 60 python3 -m trading_partner monitor --symbol "$SYM" 2>&1)
  RC=$?

  if [ "$RC" -eq 2 ]; then
    DETAIL=$(printf '%s' "$OUT" | python3 -c "import json,sys;d=json.load(sys.stdin)['coverage'];print(d.get('symbol'),'qty',d.get('position_qty'),'- ไม่มี stop คุ้มครอง')" 2>/dev/null || echo "(อ่านรายละเอียดไม่ได้)")
    alert "🚨 INSPECTOR: ไม้เปลือยบน testnet! $DETAIL — เช็คเดสก์ด่วน" || DELIVERY_FAILED=1
    continue
  fi
  if [ "$RC" -ne 0 ]; then
    alert "⚠️ INSPECTOR อ่านสถานะ $SYM ไม่ได้ (rc=$RC): $(printf '%s' "$OUT" | head -c 200)" || DELIVERY_FAILED=1
    continue
  fi

  WARN=$(MON_JSON="$OUT" python3 <<'PYEOF'
import json, os
d = json.loads(os.environ["MON_JSON"])["coverage"]
warn = []
if d.get("state") == "ORPHAN_ORDERS":
    warn.append("orphan orders: %s" % d.get("orphan_order_ids"))
if d.get("coverage_unverified"):
    warn.append("stop มีแต่ยืนยัน closePosition ไม่ได้")
if d.get("wrong_side_stop_ids"):
    warn.append("stop ผิดฝั่ง: %s" % d["wrong_side_stop_ids"])
print((str(d.get("symbol", "?")) + " — " + " · ".join(warn)) if warn else "")
PYEOF
  ) || WARN=""
  if [ -n "$WARN" ]; then
    alert "⚠️ INSPECTOR: $WARN" || DELIVERY_FAILED=1
  fi
done

# A silent inspector equals no inspector: if we could not deliver, say so by
# failing the unit so OnFailure fires.
exit "$DELIVERY_FAILED"
