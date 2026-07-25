#!/usr/bin/env bash
# notify-telegram.sh "<ข้อความ>" — แจ้งเตือน ops เข้าแชท Creator (token อยู่บนเครื่องนี้ ไม่ออกไปไหน)
#
# Exits NON-ZERO when the message did not actually reach Telegram. The old
# version printed ok:false and still exited 0, so a rotated token would silence
# the entire safety net with no trace — and desk-inspector.sh never checked the
# exit code either. Every attempt is appended to the notify log so a missing
# alert can be distinguished from an alert that was never attempted.
set -euo pipefail
MSG="${1:-(no message)}"
LOG="$HOME/.local/state/bagidea/notify.log"
mkdir -p "$(dirname "$LOG")"
python3 - "$MSG" "$LOG" <<'PY'
import json, sys, time, urllib.request, urllib.parse
msg, log = sys.argv[1], sys.argv[2]
def note(status, detail=""):
    with open(log, "a") as f:
        f.write("%s\t%s\t%s\t%s\n" % (time.strftime("%FT%T"), status, msg.split("\n")[0][:120], detail))
try:
    tg = json.load(open('/home/tiwa/bagidea-desk/daemon/registry.json'))['channels']['telegram']
    data = urllib.parse.urlencode({'chat_id': tg['chat'], 'text': msg}).encode()
    req = urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % tg['token'], data=data)
    resp = json.load(urllib.request.urlopen(req, timeout=10))
except Exception as e:
    note("FAIL", type(e).__name__ + ": " + str(e)[:120])
    print("sent: False (%s)" % type(e).__name__, file=sys.stderr)
    sys.exit(1)
if resp.get("ok") is not True:
    note("FAIL", "api ok=%s desc=%s" % (resp.get("ok"), str(resp.get("description"))[:100]))
    print("sent: False (api said ok=%s)" % resp.get("ok"), file=sys.stderr)
    sys.exit(1)
note("OK")
print("sent: True")
PY
