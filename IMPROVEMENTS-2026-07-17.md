# การปรับปรุง Overlay + Dashboard — 17 ก.ค. 2026

> เอกสารหลักของชุดงานนี้ อ่านไฟล์นี้ก่อน แล้วค่อยดูไฟล์รอง:
> - `IMPROVEMENTS-PLAN.md` — แผนทั้งหมดพร้อมสถานะ (อ่านทีละข้อว่าทำถึงไหน)
> - `SERVER-AUDIT-2026-07-17.md` — ผลตรวจ server จริงว่าโค้ดขึ้นไปหรือยัง
> - `ETH-DESK-GUIDE.md` — คู่มือเดสก์ ETH ฉบับอัปเดต (แยกเลย)

---

## สถานะรวมในหนึ่งบรรทัด

🟡 **โค้ดเสร็จทุกอย่างในเครื่อง, syntax/smoke test ผ่าน — แต่ยังไม่ commit, ไม่ push, ไม่ deploy ขึ้น server**

---

## ทำอะไรไปบ้าง (ตามลำดับเวลา)

### Phase 1 — รีวิวหน้า `:5188`
รีวิว `daemon/overlay.html` (single-file ~6,500 บรรทัด) + `daemon/server.js` (~6,600 บรรทัด) แบบเปรียบเทียบ frontend vs backend
พบว่า backend มี endpoint `/recall` (ค้นความจำ) ที่ frontend **ไม่ได้เรียกเลย** + ปัญหาอีก 8 ข้อ (toast ไม่มี, a11y = 0, dark-only, ไม่มี auth บน panel, ฯลฯ)

### Phase 2 — อนุมัติแผน 3 กลุ่ม → implement 7 ฟีเจอร์
| กลุ่ม | ฟีเจอร์ | ไฟล์ |
|---|---|---|
| 1 | Auth + Toast | overlay.html + server.js |
| 2 | Memory search + Export | overlay.html (ใช้ `/recall` ที่มีอยู่) |
| 3 | Light theme + a11y + keyboard | overlay.html |

### Phase 3 — เจอ bug ใน PIN gate ตอนเอาคู่มือเดสก์ ETH มาประกบ
PIN gate ที่ทำจะไป **ตัด Telegram, ตัด agents, ตัด curl, รั่ว WS** เพราะ whitelist ไม่ครอบคลุม ingress ที่ระบบใช้เอง → แก้ทั้ง 4 + เจอ regex prefix trap อีก → smoke test 31/31 ผ่าน

### Phase 4 — SSH ไปตรวจ server
พบว่า **โค้ดยังไม่ได้ขึ้น server เลย** และ **`:5188` ไม่ใช่ bagidea dashboard** ตามคู่มือเดิม แต่เป็น React app "JAVIS Crypto Copilot" คนละตัว

---

## สรุปสิ่งที่เปลี่ยนในแต่ละไฟล์

### `daemon/overlay.html` (frontend)
- **Toast layer**: `<div id="toasts">` + CSS + `toast(msg, kind)` helper + `downloadBlob()`/`csvCell()` helpers; เสียบใน `api()` error path + จุด action สำเร็จ 5 จุด
- **Memory search**: sidebar panel "🔍 MEMORY" ใหม่ + debounced 250ms เรียก `/recall?q=` + click-to-expand
- **Export**: ปุ่ม "⬇ Export JSON" ใน THREADS tab + "⬇ CSV" ใน STATS dashboard
- **PIN gate**: lock screen + global `fetch` wrapper (ใส่ `x-bagidea-pin` อัตโนมัติใน 59 fetch calls) + `connect()` ส่ง `?pin=` สำหรับ WS + Settings → CONNECT ตั้ง PIN
- **Light theme**: CSS variables + `[data-theme="light"]` + แปลง hardcoded `rgba(255,255,255,*)` 41 จุด → `var(--surf-*)` + ⋯ menu toggle + FOUC-prevention script + `prefers-color-scheme`
- **Accessibility**: `aria-label` บน icon buttons + `role="dialog"`/`aria-modal` บน `#modal`/`#fsPick` + focus trap + `prefers-reduced-motion`
- **Keyboard shortcuts**: Esc (ปิด modal), Ctrl/Cmd+B (sidebar), Ctrl/Cmd+, (settings), Ctrl/Cmd+Shift+O (ops), Ctrl/Cmd+1-9 (agent); cheatsheet ใน palette

### `daemon/server.js` (backend)
- **PIN gate** (opt-in, default = ปิด):
  - `pinHash()` SHA-256 + เกลือ + เก็บแค่แฮชใน `registry.json`
  - `pinStatic()` / `pinIngress()` — whitelist แยก static (HTML/assets) กับ ingress (hooks/Telegram/perm/proxy)
  - `uiPinOk()` — รับทั้ง header (`x-bagidea-pin`) และ query (`?pin=` สำหรับ WS/curl)
  - gate ทั้ง HTTP chain + **WS upgrade handler** (จุดที่เกือกรั่ว)
  - route ใหม่: `GET /auth/check`, `POST /auth/verify`, `POST /registry/pin`

### `ETH-DESK-GUIDE.md` (ไฟล์ใหม่)
คู่มือเดสก์ ETH ฉบับอัปเดต — เพิ่ม section 🔐 PIN + แก้ curl ทุกอันให้มีเวอร์ชั่น "เปิด PIN/ไม่เปิด PIN"

---

## ⚠️ สิ่งที่ต้องรู้ก่อน deploy

1. **ยังไม่ได้ deploy** — ทุกอย่างอยู่ใน working tree local เท่านั้น
2. **`:5188` ≠ bagidea dashboard** — ดูรายละเอียดใน `SERVER-AUDIT-2026-07-17.md`
3. **PIN เป็น opt-in** — default ปิด จะไม่ break อะไรที่รันอยู่ แต่ถ้าเปิดใช้ curl ในคู่มือเก่าจะใช้ไม่ได้ (ต้องใส่ header)
4. **แนะนำทดสอบ local ก่อน** — ดูขั้นตอนใน `IMPROVEMENTS-PLAN.md` ข้อ "ทดสอบในเครื่อง"

---

## ขั้นตอนถัดไป (แนะนำลำดับ)

1. **อ่าน** `SERVER-AUDIT-2026-07-17.md` เพื่อเข้าใจสถานะ server จริง
2. **อ่าน** `IMPROVEMENTS-PLAN.md` เพื่อดูสถานะ implement แต่ละข้อ
3. **ตัดสินใจ**: ทดสอบ local ก่อน / commit ทันที / deploy ทันที / แก้ปม `:5188` ก่อน
4. ถ้า deploy — ใช้ `ssh javis-server '~/update-desk.sh'` (มี backup + guard + rollback)
