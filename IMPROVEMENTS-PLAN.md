# แผนการปรับปรุง + สถานะ implement

> คู่กับ `IMPROVEMENTS-2026-07-17.md` (เอกสารหลัก) · ไฟล์นี้ระบุแผนละเอียดและสถานะที่ทำถึงไหนแล้ว

**สถานะรวม**: ✅ แก้โค้ดเสร็จทุกข้อ · ✅ syntax/smoke test ผ่าน · ❌ ยังไม่ commit · ❌ ยังไม่ deploy

---

## กลุ่ม 1 — Auth + Toast layer

### 1B. Toast/Snackbar ✅ ในเครื่อง / ❌ บน server
**ทำ:**
- `<div id="toasts">` + CSS (fixed bottom-right, stack, auto-dismiss, ok/err/warn/info, `prefers-reduced-motion`)
- `toast(msg, kind, ms)` helper (textContent — ไม่ inject HTML, click-to-dismiss, error อยู่ 6s / อื่นๆ 4s)
- `downloadBlob(text, filename, mime)` + `csvCell(v)` helpers
- เสียบ toast ใน:
  - `api()` (L5657) — network error + 401 + 5xx → toast แทน swallow
  - skill save/delete — "อัปเดต/สร้าง/ลบ skill แล้ว"
  - agent save — "อัปเดตโปรไฟล์/อัปเดต/รับพนักงานใหม่แล้ว"
  - project add — "เพิ่มโปรเจคแล้ว"

**ไม่ได้ทำ** (ตั้งใจ): แทนที่ `.catch(() => null)` ทุกจุด เพราะส่วนใหญ่เป็น background fetch ตอนเปิด modal จะรบกวนเกินไป

### 1A. PIN/Token gate ✅ ในเครื่อง / ❌ บน server
**server.js:**
- `pinHash()` — SHA-256 + เกลือ `bagidea-office/ui-pin/v1` + เก็บเฉพาะแฮชใน `registry.json`
- `regPinHash()`, `uiPinActive()` — อ่านสถานะจาก `reg.uiPin`
- `uiPinOk(req)` — รับ **ทั้ง** header `x-bagidea-pin` **และ** query `?pin=` (สำหรับ WS + curl/SSH ที่ใส่ header ไม่ได้/ยาก)
- `pinStatic(url)` / `pinIngress(url)` — whitelist แยก:
  - **static** (HTML + assets): `/`, `/index.html`, `/win`, `/winlang.js`, `/watch`, `/workflow`, `/toolshub`, `/pluginshub`, `/brand/`, `/sfx/`, `/char/`
  - **ingress** (ระบบใช้เอง ใส่ PIN ไม่ได้): `/event`, `/perm/request`, `/perm/respond`, `/claude/auth`, `/claude/login`, `/proxy/`, `/channels/{telegram,line,slack,whatsapp,messenger}/webhook`
  - **GATED จริง** (ต้อง PIN): `/plugin/binance/cmd`, `/chat`, `/registry`, `/stats`, `/ws`, `/media`, `/uploads`, ฯลฯ
- route ใหม่: `GET /auth/check` (คืน `{locked:bool}`), `POST /auth/verify` (ตรวจ PIN), `POST /registry/pin` (ตั้ง/เปลี่ยน/ลบ — ต้องรู้ PIN ปัจจุบัน)
- **gate WS upgrade handler** ด้วย (จุดสำคัญ — ไม่งั้น `/ws` รั่ว trade fills + chat บน LAN)

**overlay.html:**
- lock screen (`#lockScreen`) — full-viewport, blur พื้นหลัง, input PIN, Enter ส่ง, `?pin=` ส่งทั้ง header + query
- global `window.fetch` wrapper — ใส่ `x-bagidea-pin` อัตโนมัติในทุก same-origin fetch (59 จุด ไม่ต้องแก้ทีละจุด)
- `connect()` — ส่ง `?pin=<sessionPIN>` ใน WS URL
- Settings → CONNECT tab — field "🔐 PIN ล็อกหน้า" (PIN ปัจจุบัน + ใหม่ + ปุ่มบันทึก)
- `bootAuthGate()` เรียกตอน boot — ถ้า locked และไม่มี sessionStorage PIN → แสดง lock screen
- หลัง unlock → เรียก `connect()` ทันที (ไม่รอ retry loop 2s)

---

## กลุ่ม 2 — Memory Search + Export

### 2A. Memory Search UI ✅ ในเครื่อง / ❌ บน server
- sidebar panel "🔍 MEMORY" ใน `#side` (ระหว่าง BRAINS กับ OFFICE LOG)
- input `#memInp` + debounce 250ms → `GET /recall?q=...&k=8`
- แสดง hit: title + snippet (160 char) + tier + score
- race guard `memSeq` (ตัด response เก่าที่มาช้า)
- click hit → ดรอปเนื้อหาเต็ม (1200 char) ลง chat เป็น chip (textContent — injection-safe)
- empty state: "พิมพ์ ≥2 ตัวเพื่อค้น" / "กำลังค้น…" / "ไม่พบความทรงจำ" / "ค้นไม่สำเร็จ"

### 2B. Export ✅ ในเครื่อง / ❌ บน server
- **threads → JSON**: ปุ่ม "⬇" ที่หัว THREADS tab → `downloadBlob(JSON.stringify(r), ...)` ทั้ง session index
- **stats → CSV**: ปุ่ม "⬇ CSV" ใน renderDash → ส่งออก 7-day table + per-agent KPI เป็น CSV (RFC4180 escape)
- ใช้ pattern เดียวกับ audio recorder (Blob + URL.createObjectURL + `<a download>`)

---

## กลุ่ม 3 — UX: Light theme + a11y + Shortcuts

### 3A. Light theme ✅ ในเครื่อง / ❌ บน server
- ขยาย `:root` variables: `--bg-base`, `--bg-grad-a/b`, `--win-border`, `--surf-1/2/3/line`
- `[data-theme="light"]` override block
- แปลง hardcoded `rgba(255,255,255,0.0X)` 41 จุด → `var(--surf-*)` (via sed)
- inline script ที่ `<head>` — apply theme ก่อน paint (กัน FOUC) + อ่าน `prefers-color-scheme` ตอน first load
- `#themeBtn` ใน ⋯ menu + `applyTheme(t)` + `currentTheme()` + บันทึก localStorage
- toggle: dark ↔ light (cycle 2 ค่า ไม่มี "auto" ใน toggle — auto มีแค่ตอน first load)

### 3B. Accessibility ✅ ในเครื่อง / ❌ บน server
- `aria-label` บน header icon buttons (ops/set/more/side/mini/hide) + `role="button"` + `tabindex="0"` บน winbtn
- `role="dialog"` + `aria-modal="true"` บน `#modal` + `#fsPick`
- focus trap: Tab cycle within modal + restore focus ตอนปิด + auto-focus ตอนเปิด (MutationObserver)
- `@media (prefers-reduced-motion: reduce)` — kill animations ทั้งหมด (`animation-duration: 0.001ms !important`)

### 3C. Keyboard shortcuts ✅ ในเครื่อง / ❌ บน server
- ขยาย global keydown handler (ที่เดิมมีแค่ Ctrl+K):
  - `Esc` → ปิด modal/fsPick (ทำงานแม้ใน input field)
  - `Ctrl/Cmd+B` → toggle sidebar (`setSide()`)
  - `Ctrl/Cmd+,` → open Settings
  - `Ctrl/Cmd+Shift+O` → open Office Ops
  - `Ctrl/Cmd+1..9` → switch agent (ข้าม "auto" seat)
- `_typingInField(el)` guard — ปิด shortcut ตอนอยู่ใน input/textarea/select (ยกเว้น Esc + Ctrl+K)
- cheatsheet ใน command palette — group "ทางลัด" + "ดูคีย์ลัดทั้งหมด" (toast 12s)

---

## การตรวจสอบที่ทำ (Verify)

| ตรวจอะไร | ผล |
|---|---|
| `node -c server.js` | ✅ OK |
| overlay.html `<script>` extract + `node -c` | ✅ OK |
| PIN regex smoke test (31 case รวม prefix traps) | ✅ ALL PASS |
| PIN hash determinism (1234==1234, ≠9999, length 64) | ✅ |
| WebSocket URL ส่ง `?pin=` เมื่อมี PIN | ✅ (in code) |

---

## ทดสอบในเครื่อง (ยังไม่ได้ทำ — แนะนำก่อน deploy)

```bash
# 1. รัน daemon local (ใน daemon/)
cd /e/JARVIS-BrainOps/agents/bagidea/daemon
node server.js   # ดูว่าไม่ crash + log ปกติ

# 2. เปิด browser → http://127.0.0.1:8787/
#    ตรวจทีละอย่าง:
#    - ⋯ menu มี "ธีม / Theme" ไหม → คลิก → เปลี่ยนสว่าง/มืด
#    - Ctrl+K → command palette → มี group "ทางลัด" ไหม
#    - Ctrl+B → sidebar เปิด/ปิด
#    - เปิด sidebar → "🔍 MEMORY" → พิมพ์คำ → มีผลลัพธ์
#    - ⚙ → THREADS → มีปุ่ม "⬇" ไหม
#    - ⚙ → CONNECT → มี "🔐 PIN ล็อกหน้า" ไหม

# 3. regression: เปิด Settings / สลับ agent / ดู stats / พิมพ์ chat
#    ต้องใช้ได้ปกติทุกอย่าง

# 4. ปิด daemon (Ctrl+C)
```

---

## ขั้นตอน commit + deploy (เมื่อพร้อม)

### commit (แยกตามกลุ่ม — อ่านง่าย rollback ง่าย)
```bash
cd /e/JARVIS-BrainOps/agents/bagidea

# 1. toast + helpers
git add daemon/overlay.html   # (ส่วน toast/downloadBlob/csvCell และ api() wire)
git commit -m "feat(overlay): toast feedback layer + export helpers"

# 2. memory search
git commit -m "feat(overlay): memory search sidebar (/recall?q=)"

# 3. theme + a11y + shortcuts
git commit -m "feat(overlay): light theme + a11y (aria, focus trap, reduced-motion) + keyboard shortcuts"

# 4. PIN gate (frontend + backend)
git add daemon/server.js
git commit -m "feat(auth): optional UI PIN gate (opt-in) — header + ?pin= + WS upgrade gate"

# 5. guide
git add ETH-DESK-GUIDE.md
git commit -m "docs: ETH desk guide (human) + PIN section"

git push origin main
```

> ⚠️ **จริงๆ แล้ว overlay.html แกะ commit เดียวยาก** เพราะแก้ครั้งเดียวหลายส่วน — อาจจะ commit รวม 1-2 ครั้งก็ได้ ขึ้นกับคุณ

### deploy
```bash
ssh javis-server '~/update-desk.sh'
# มันจะ: backup → pull → check stop-fix → syntax → restart → health
#         → rollback auto ถ้าพัง
# ถ้ามีไม้เปิดอยู่จะไม่ยอม (ตั้งใจ) — ข้ามด้วย --force เท่านั้น
```

### หลัง deploy ตรวจที่ server
```bash
ssh javis-server 'curl -s http://127.0.0.1:8787/auth/check'   # ต้องคืน {"locked":false} (default)
ssh javis-server 'curl -s http://127.0.0.1:8787/version'      # ต้องเป็น 0.9.45 หรือใหม่กว่า
ssh javis-server 'grep -c "pinStatic\|/auth/check" ~/bagidea-desk/daemon/server.js'   # ต้อง > 0
```
