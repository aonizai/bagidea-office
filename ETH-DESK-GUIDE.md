# คู่มือใช้งานเดสก์ ETH (ฉบับคน — 1 หน้า)

> server = javis-server (192.168.10.162) · รัน 24 ชม. · เครื่องพี่ปิดได้

---

## 🖥️ ดู dashboard จอเต็ม

มือถือ/คอมที่ต่อ wifi บ้านเดียวกัน: เปิดเบราว์เซอร์ → **http://192.168.10.162:5188**

ครั้งแรกครั้งเดียว ถ้าเปิดไม่ขึ้น: SSH เข้า server แล้วรัน (เปิด firewall ให้ LAN):
```bash
sudo ufw allow from 192.168.10.0/24 to any port 5188 proto tcp
```

อยู่นอกบ้าน (ไม่ได้ต่อ wifi บ้าน) → ใช้ Telegram แทน (ดูข้อล่าง)

---

## 🔐 ถ้าเปิด PIN ไว้ (ของจริง — แนะนำ)

> PIN = กั้นหน้า panel ใครเปิดเบราว์เซอร์เข้ามาต้องปลดล็อกก่อน · default = ปิด
> เปิดที่: dashboard → **⚙ → CONNECT → 🔐 PIN ล็อกหน้า** · เก็บเฉพาะแฮชในเครื่อง

เปิดเบราว์เซอร์เข้า dashboard → ขึ้นหน้า **🔒 กรอก PIN เพื่อปลดล็อก** → ใส่ PIN → เข้าได้ปกติ
(PIN จำในแท็บนั้นจนกว่าจะปิดแท็บ)

⚠️ **curl/SSH ทุกอันต้องใส่ header PIN ด้วย** — ไม่งั้น 401:
```bash
curl -s -X POST http://127.0.0.1:8787/plugin/binance/cmd \
  -H 'content-type: application/json' \
  -H 'x-bagidea-pin: <PIN ของพี่>' \
  -d '{"cmd":"pause","args":"on"}'
```

ระบบที่ไม่ต้องใส่ PIN (เรียกเองจาก hooks/Telegram — whitelist ไว้แล้ว):
`/event`, `/perm/*`, `/channels/*/webhook`, `/claude/*`, `/proxy/*`

---

## 📱 ดูตอนไหนก็ได้ (นอกบ้าน) — Telegram

ไม้เข้า/ออก/breakeven/partial แจ้งเองในมือถือ ไม่ต้องเปิดอะไร = จอหลักเวลาไม่อยู่หน้าคอม

---

## ⏸️ หยุด/เริ่มเทรด

ปุ่ม **PAUSE** บน dashboard · หรือ SSH เข้า server:

**ถ้ายังไม่ได้เปิด PIN:**
```bash
curl -s -X POST http://127.0.0.1:8787/plugin/binance/cmd \
  -H 'content-type: application/json' \
  -d '{"cmd":"pause","args":"on"}'
```
(เปลี่ยน `on`↔`off`)

**ถ้าเปิด PIN แล้ว** — เพิ่ม `-H 'x-bagidea-pin: <PIN>'`:
```bash
curl -s -X POST http://127.0.0.1:8787/plugin/binance/cmd \
  -H 'content-type: application/json' \
  -H 'x-bagidea-pin: <PIN ของพี่>' \
  -d '{"cmd":"pause","args":"on"}'
```

---

## 🔎 เช็คสถานะเร็ว (จาก server)

**ไม่ได้เปิด PIN:**
```bash
curl -s -X POST http://127.0.0.1:8787/plugin/binance/cmd -H 'content-type: application/json' -d '{"cmd":"positions"}'
curl -s -X POST http://127.0.0.1:8787/plugin/binance/cmd -H 'content-type: application/json' -d '{"cmd":"status"}'
```

**เปิด PIN แล้ว** — เพิ่ม `-H 'x-bagidea-pin: <PIN>'` ทุกอัน:
```bash
curl -s -X POST http://127.0.0.1:8787/plugin/binance/cmd \
  -H 'content-type: application/json' -H 'x-bagidea-pin: <PIN>' -d '{"cmd":"positions"}'
curl -s -X POST http://127.0.0.1:8787/plugin/binance/cmd \
  -H 'content-type: application/json' -H 'x-bagidea-pin: <PIN>' -d '{"cmd":"status"}'
```

---

## ⚙️ ระบบอะไรรันบน server (จัดการด้วย `systemctl --user`)

| service | คือ | คำสั่ง |
|---|---|---|
| `bagidea-desk` | ตัวเทรด ETH auto | `systemctl --user restart bagidea-desk` |
| `bagidea-dashboard` | จอเว็บ :5188 | `systemctl --user restart bagidea-dashboard` |

ทั้งคู่ตายเองก็ฟื้น + server รีบูตก็ฟื้น (linger=on แล้ว)

---

## 🔄 อัปเดตยังไงไม่ให้พัง

ทางเดียวที่ใช้: `ssh javis-server '~/update-desk.sh'` — มันจะ backup state → pull → เช็ค stop-fix ต้องอยู่ → syntax → restart → health พังขั้นไหน rollback เอง · มีไม้เปิดอยู่มันจะไม่ยอมอัปเดต (ตั้งใจ — ข้ามได้ด้วย `--force` เท่านั้น)

`bagidea update` ตรง ๆ ไม่อันตรายแล้ว (stop-fix อยู่ใน git @e69e270) แต่ไม่มี guard/rollback — ใช้ `update-desk.sh` เสมอ

> หมายเหตุ: PIN ที่ตั้งไว้ใน `registry.json` **อยู่รอดผ่าน update-desk.sh** (registry อยู่ใน backup set + ไม่โดน git แตะ) — รีสตาร์ทแล้ว PIN ยังอยู่

---

## 💾 Backup อัตโนมัติ + วิธีกู้ (เพิ่ม 2026-07-16)

ของสำคัญที่ git ไม่เก็บ (registry = Telegram token + agent 9 ตัว · jobs · Binance config · trades journal) สำรองที่ `~/bagidea-backups/` เก็บ 30 ชุดล่าสุด

- รันเอง: ทุกวัน 04:00 (systemd timer, ชดให้ถ้า server ดับข้ามเวลา) + ก่อนอัปเดตทุกครั้ง (hook ใน update-desk.sh) · สั่งมือ: `~/backup-desk-state.sh manual`
- ทุกชุด verify ตัวเองตอนสร้าง (token + agents ≥ 9 ต้องอยู่ ไม่งั้น fail ดัง ๆ — กันเคส registry กลายเป็น default เงียบ ๆ แบบ 2026-07-16)
- registry.json ที่ verify ผ่านจะมี `uiPin` hash อยู่ด้วย (ถ้าตั้ง PIN ไว้) — กู้แล้ว PIN ยังใช้ได้

**กู้ทั้งชุด:**
```bash
systemctl --user stop bagidea-desk
tar -xzf ~/bagidea-backups/<ชุดที่เลือก> -C ~/bagidea-desk
systemctl --user start bagidea-desk
```
กู้เฉพาะ registry: เติม daemon/registry.json ต่อท้ายบรรทัด tar

**ดึงชุดล่าสุดลงเครื่องพี่** (สำรองนอกเครื่อง — ทำมือตามสะดวก, จาก Git Bash):
```bash
scp javis-server:"bagidea-backups/$(ssh javis-server 'ls -1t bagidea-backups | head -1')" .
```

> ข้อจำกัดที่รู้ไว้: backup อยู่บนดิสก์เดียวกับ server — กัน "ทำพลาด/ลบพลาด/swap พลาด" ได้ กัน "ดิสก์ตาย" ไม่ได้ (off-box = คำสั่ง scp ข้างบน)

---

## 🚑 ถ้าอะไรดูผิดปกติ

กด **PAUSE** ก่อน (ปลอดภัยไว้ก่อน) แล้วบอก Cothinker — SL ทุกไม้ resting อยู่ที่ exchange เดสก์ดับไม้ก็ไม่เปลือย
