#!/usr/bin/env bash
# desk-heartbeat.sh — out-of-process liveness watch for the trading desk.
#
# Why this exists: on 2026-07-24..25 the desk did nothing for ~28 hours and the
# host rebooted, while every timer reported healthy and nobody was told
# anything. A dead desk and a quiet market look identical from a phone unless
# something publishes "the loop ticked and it was fine".
#
# It runs OUTSIDE the daemon on purpose — a heartbeat inside the daemon cannot
# tell you the daemon died.
#
# THE RULE THAT MAKES THIS USABLE: no condition here may reference trade count,
# PnL, signal count or scanner output. The desk is deliberately flat and
# disarmed; a monitor that treats "flat" as an incident is a monitor that gets
# muted. Green + flat + unpaused = ZERO messages.
set -uo pipefail

PORT="${OEP_PORT:-8787}"
STATE_DIR="$HOME/.local/state/bagidea"
STATE="$STATE_DIR/heartbeat-state.json"
DASH_OUT="$HOME/bagidea-dashboard-data/heartbeat.json"
NOTIFY="$HOME/notify-telegram.sh"
mkdir -p "$STATE_DIR"

health_json=$(curl -s --max-time 10 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)
snap_json=$(curl -s --max-time 15 "http://127.0.0.1:$PORT/plugin/binance/snapshot" 2>/dev/null || true)

WEEKLY="${1:-}"

HEALTH="$health_json" SNAP="$snap_json" STATE_FILE="$STATE" DASH="$DASH_OUT" \
NOTIFY_SH="$NOTIFY" MODE="$WEEKLY" python3 <<'PY'
import json, os, subprocess, time

now = time.time()
health_raw, snap_raw = os.environ["HEALTH"], os.environ["SNAP"]
state_file, dash_out = os.environ["STATE_FILE"], os.environ["DASH"]
notify_sh, mode = os.environ["NOTIFY_SH"], os.environ["MODE"]

try:
    state = json.load(open(state_file))
except Exception:
    state = {}

def notify(text):
    """Alert delivery is VERIFIED. notify-telegram.sh returning 0 while the API
    said ok:false is how a rotated token silences an entire safety net."""
    try:
        r = subprocess.run([notify_sh, text], capture_output=True, text=True, timeout=30)
        ok = r.returncode == 0 and "sent: True" in (r.stdout or "")
    except Exception as e:
        ok, r = False, None
    with open(os.path.join(os.path.dirname(state_file), "notify.log"), "a") as f:
        f.write("%s\t%s\t%s\n" % (time.strftime("%FT%T"), "OK" if ok else "FAIL", text.split("\n")[0][:120]))
    return ok

health = None
try:
    health = json.loads(health_raw) if health_raw else None
except Exception:
    health = None
snap = None
try:
    snap = json.loads(snap_raw) if snap_raw else None
except Exception:
    snap = None

h = (snap or {}).get("health") or {}
loops = h.get("loops") or {}
monitor_ms = h.get("monitorMs") or 30000

# (key, condition, confirmations before first page, re-page seconds, message)
checks = []
checks.append(("daemon-down", health is None, 2, 3600,
               "🚨 เดสก์ไม่ตอบ /health — daemon อาจตายหรือค้าง"))
if snap is not None:
    # lastOkTickAt is null for up to one interval after every load/reload,
    # because only a FULLY successful tick sets it. Treating that as "stale"
    # made a routine reload page as an incident (it did, once, on 2026-07-25).
    # The grace period is measured from the instance's own startedAt, which is
    # reset by the same reload — so a genuinely dead loop still trips.
    last_ok = h.get("lastOkTickAt")
    started = h.get("startedAt")
    warming = last_ok is None and started is not None and (now * 1000 - started) <= 3 * monitor_ms
    stale = (not warming) and (last_ok is None or (now * 1000 - last_ok) > 5 * monitor_ms)
    checks.append(("monitor-stale", stale, 2, 3600,
                   "🚨 monitor loop ไม่ tick สำเร็จมานานเกิน 5 รอบ — ไม้ที่เปิดอยู่อาจไม่ถูกจัดการ"))
    checks.append(("loops-duplicated", (loops.get("monitor", 1) or 0) > 1 or (loops.get("scanner", 1) or 0) > 1, 1, 21600,
                   "🚨 มี trading loop ซ้อนกัน (%s) — reload ทิ้ง instance เก่าไว้ ต้อง restart" % json.dumps(loops)))
    checks.append(("tick-errors", (h.get("consecutiveTickErrors") or 0) >= 3, 1, 3600,
                   "🚨 monitor tick error ติดกัน %s รอบ: %s" % (h.get("consecutiveTickErrors"), h.get("lastTickError"))))
    cov = snap.get("coverage") or []
    naked = [c for c in cov if c.get("class") == "desk" and c.get("covered") is False]
    checks.append(("desk-naked", bool(naked), 1, 3600,
                   "🚨 ไม้ของเดสก์ไม่มี stop: %s" % ", ".join(c.get("symbol", "?") for c in naked)))
    foreign = [c for c in cov if c.get("class") in ("foreign", "unknown")]
    checks.append(("foreign-open", bool(foreign), 1, 21600,
                   "ℹ️ มีไม้ที่เดสก์ไม่ได้เปิดค้างอยู่: %s (เดสก์ไม่แตะ)" % ", ".join(c.get("symbol", "?") for c in foreign)))
    paused_since = state.get("paused-since")
    if snap.get("paused"):
        if not paused_since:
            state["paused-since"] = now
            paused_since = now
        checks.append(("paused-long", (now - paused_since) > 86400, 1, 86400,
                       "⚠️ เดสก์ pause ค้างเกิน 24 ชม. (%s)" % (h.get("pausedReason") or "ไม่ระบุเหตุ")))
    else:
        state.pop("paused-since", None)
    checks.append(("autotrade-off-by-breaker", h.get("autoTradeDisabledBy") == "daily-loss", 1, 86400,
                   "⚠️ autoTrade ยังปิดอยู่จาก daily-loss breaker — ต้องเปิดเองเมื่อพร้อม (ระบบไม่เปิดให้อัตโนมัติ)"))
    # A stale news cache makes newsGate fail closed, so the desk stops arming
    # WITHOUT anything else looking wrong. That is a dependency being down
    # (Pulse refreshes every 15 min), not a market condition — which is why it
    # is allowed here despite the no-trading-metrics rule.
    checks.append(("news-cache-stale", h.get("newsCacheStale") is True, 1, 21600,
                   "⚠️ news-cache เก่าเกินเพดาน (%s ชม.) — Pulse น่าจะไม่ทำงาน · newsGate fail-closed แปลว่าเดสก์จะไม่ arm ไม้ใหม่จนกว่าจะแก้"
                   % h.get("newsCacheAgeH")))

fired = []
for key, bad, need, repage, msg in checks:
    st = state.get(key) or {"count": 0, "lastPagedAt": 0}
    if bad:
        st["count"] = st.get("count", 0) + 1
        if st["count"] >= need and (now - st.get("lastPagedAt", 0)) > repage:
            if notify(msg):
                fired.append(key)
            st["lastPagedAt"] = now
        st["resolvedPending"] = True
    else:
        # One resolution line per cleared condition. Without it you cannot tell
        # a fixed problem from a silenced one.
        if st.get("resolvedPending") and st.get("lastPagedAt"):
            notify("✅ คลี่คลายแล้ว: %s" % key)
        st = {"count": 0, "lastPagedAt": 0}
    state[key] = st

# Weekly alive-ping — one message, and the canary that proves the alert channel
# itself still works (a rotated token shows up as this going missing).
if mode == "weekly":
    up = ""
    if h.get("startedAt"):
        up = " · up %.1f ชม." % ((now * 1000 - h["startedAt"]) / 3600000)
    notify("🫀 desk weekly: %s%s · loops %s · tick errors %s · paused=%s · autoTradeSignal=%s" % (
        "ok" if health else "NO /health", up, json.dumps(loops),
        h.get("consecutiveTickErrors"), (snap or {}).get("paused"), (snap or {}).get("autoTradeSignal")))

try:
    json.dump(state, open(state_file, "w"), indent=1)
except Exception:
    pass
# Also publish to the LAN dashboard so staleness is visible even if Telegram is
# the thing that is broken.
try:
    os.makedirs(os.path.dirname(dash_out), exist_ok=True)
    json.dump({"checkedAt": int(now * 1000), "healthOk": health is not None,
               "loops": loops, "lastOkTickAt": h.get("lastOkTickAt"),
               "consecutiveTickErrors": h.get("consecutiveTickErrors"),
               "paused": (snap or {}).get("paused"), "fired": fired},
              open(dash_out, "w"), indent=1)
except Exception:
    pass

print("heartbeat: health=%s loops=%s fired=%s" % (health is not None, json.dumps(loops), fired))
PY
