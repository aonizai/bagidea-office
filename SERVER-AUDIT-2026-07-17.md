# ผลตรวจ Server — 17 ก.ค. 2026

> คู่กับ `IMPROVEMENTS-2026-07-17.md` (เอกสารหลัก)
> บันทึกผล SSH ไป `javis-server` (192.168.10.162) เพื่อตรวจสถานะจริงของระบบ

---

## สรุปสำคัญ

🔴 **โค้ดที่แก้วันนี้ ไม่ได้ขึ้น server เลย** (commit ล่าสุดบน server = `e69e270` = 0.9.44 ที่มีอยู่เดิม)

🟡 **`:5188` ไม่ใช่ bagidea dashboard** ตามคู่มือเดิม — เป็น React app "JAVIS Crypto Copilot" คนละตัว

🟢 daemon `:8787` รันปกติ, bagidea-desk service active

---

## สิ่งที่ตรวจ + ผล

### Endpoints

| Endpoint | ผล | แปล |
|---|---|---|
| `:5188 /` | HTTP 200 + HTML "JAVIS Crypto Copilot" (React SPA) | ไม่ใช่ bagidea |
| `:5188 /auth/check` | คืน HTML เดียวกัน (SPA fallback) | endpoint ไม่มี |
| `:5188 /version` | คืน HTML เดียวกัน | endpoint ไม่มี |
| `:5188 /health` | คืน HTML เดียวกัน | endpoint ไม่มี |
| `:8787 /` (จาก server) | HTML "BagIdea Office" (overlay) | daemon ปกติ |
| `:8787 /auth/check` | **คืนค่าว่าง** | endpoint ไม่มี → PIN gate ไม่ได้ deploy |
| `:8787 /version` | `{"version":"0.9.43",...}` | server ตามหลัง repo 1 commit |
| `:8787 /health` | `{"clients":0,"pendingPerms":0,"wt":false}` | daemon ทำงาน |

### Git บน server

```
~/bagidea-desk git log -1:
  e69e270 release: 0.9.44 — consolidation + mandatoryStop algoOrder fix (2026-07-16)

~/bagidea-desk git status --short:
   M workspace/.claude/settings.json      ← แก้แค่อันเดียว
  (daemon/* ไม่ถูกแตะ)

grep markers ใน daemon/overlay.html (toast/theme/PIN):  0
grep markers ใน daemon/server.js (pinStatic/PIN_INGRESS/auth/check):  0
```

→ สรุป: **ไม่มีการแก้ของวันนี้บน server เลย**

### Services (systemctl --user)

| service | สถานะ | คือ |
|---|---|---|
| `bagidea-desk.service` | **active running** | daemon ETH (:8787 ผูก 127.0.0.1) |
| `bagidea-dashboard.service` | **active running** | `~/bagidea-dashboard/serve-dashboard.js` (:5188 ผูก 0.0.0.0) |
| `bagidea-backup.service` | inactive dead | (อาจตั้งใจปิด) |
| `bagidea-inspector.service` | inactive dead | (อาจตั้งใจปิด) |
| `bagidea-stats.service` | inactive dead | (อาจตั้งใจปิด) |
| `bagidea-alert@*` | inactive dead | (alert สำหรับ service ที่ตาย) |

### Port

```
LISTEN 127.0.0.1:8787  node pid=1452058   ← bagidea-desk (LAN เข้าตรงไม่ได้)
LISTEN 0.0.0.0:5188    node pid=1228432   ← bagidea-dashboard (LAN เข้าได้)
```

---

## 🔴 ไขข้อขัดแย้ง: `:5188` ≠ bagidea dashboard

คู่มือเดิมเขียนว่า `:5188` เป็น "จอเว็บ" ของ bagidea (proxy เข้า daemon) — **แต่จริงๆ เป็นคนละอย่าง**

**จริง:**
- `:5188` = `bagidea-dashboard.service` → `~/bagidea-dashboard/serve-dashboard.js` → React SPA **"JAVIS Crypto Copilot — Daily Futures Workspace"** (DEMO/PAPER/VIEW-ONLY, lightweight-charts)
- `:8787` = `bagidea-desk.service` → bagidea daemon → overlay.html "BagIdea Office" — **ผูก `127.0.0.1` เท่านั้น** (LAN เข้าตรงไม่ได้ ต้อง SSH tunnel)

**คำถามที่ยังไม่ได้ไข:**
1. แล้ว bagidea dashboard (overlay.html) ดูจาก LAN ยังไง? มันไม่ได้ expose บน `:5188`
2. `JAVIS Crypto Copilot` คืออะไร? เกี่ยวข้องกับเดสก์ ETH ไหม? (ดูเหมือน view-only dashboard อิสระ)
3. คู่มือเดิมเขียนผิด หรือ config เปลี่ยนไป?

→ **ต้องถามเจ้าของระบบเพื่อเคลียร์** ก่อน deploy ไม่งั้นคู่มือจะผิดต่อไป

---

## 🟡 services ที่ inactive/dead

`bagidea-backup`, `bagidea-inspector`, `bagidea-stats` ตายทั้ง 3 — แต่อาจตั้งใจปิด (เพราะมี `bagidea-alert@*` ที่คอยแจ้งเตือนเมื่อ service ตาย ซึ่งก็ inactive ด้วย)

ถ้าสำคัญ: ตรวจว่าทำไมตาย
```bash
ssh javis-server 'systemctl --user status bagidea-backup.service --no-pager'
ssh javis-server 'journalctl --user -u bagidea-backup.service --no-pager -n 50'
```

---

## 🔵 สถานะ daemon เมื่อตรวจ

- `:8787 /health` คืน `clients: 0` = ไม่มี overlay เปิดอยู่ (ปกติ ถ้าไม่มีคนดู)
- `pendingPerms: 0` = ไม่มี permission ค้าง (ดี)
- `wt: false` = ไม่มี watcher task (ดี — แปลว่าไม่มี task ค้างอยู่)
- `version: 0.9.43` = ล้าสมัยนิดนึง (repo ล่าสุด 0.9.44)

---

## ขั้นตอนถัดไป (ตามลำดับความสำคัญ)

1. **ไขปม `:5188`** ก่อน — ถามเจ้าของระบบว่า bagidea dashboard ดูจาก LAN ยังไง แล้วแก้คู่มือให้ถูก
2. **commit + push** การแก้ของวันนี้ (หลังทดสอบ local)
3. **deploy** ผ่าน `update-desk.sh`
4. **หลัง deploy ตรวจใหม่** — รันคำสั่งตรวจเดิมอีกครั้งเพื่อยืนยันขึ้นจริง
5. (optional) ตรวจ services ที่ inactive ว่าควรเปิดไหม
