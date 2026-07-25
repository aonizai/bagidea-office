# 🔲 SMC / FVG Radar — v0.1.0

เอนจินอ่านกราฟแบบ deterministic ตามกรอบ Smart Money Concepts อ่านจาก **แท่งเทียนอย่างเดียว** (ไม่ใช่ภาพกราฟ)
บอกโครงสร้างตลาด (BOS / MSS / range), หาโซน Fair Value Gap พร้อมสถานะการเติมและเกรด, จับ liquidity sweep, และแบ่ง premium / discount

**ที่ปรึกษาเท่านั้น** — ไม่ส่งคำสั่ง ไม่คำนวณไซซ์ ไม่ต่อเข้า autotrade หรือ auto-signal gate
`plugins/binance/index.js` ไม่ถูกแตะโดยงานนี้เลย

> **FVG คือโซนรอราคา ไม่ใช่สัญญาณเข้าเทรด**
> หลักการนี้ถูกบังคับที่โครงสร้างโค้ด ไม่ใช่แค่ข้อความเตือน — ดู `readiness` และ scenario `unclassified` ด้านล่าง

---

## คำสั่ง

| คำสั่ง | ใช้เมื่อ |
|---|---|
| `smc <SYMBOL> [tf]` | อ่านเต็ม: โครงสร้าง + โซน + sweep + premium/discount + setup ที่จัดเกรดแล้ว |
| `fvg <SYMBOL> [tf]` | เอาแค่รายการโซน (ขอบ, ทิศ, อายุ, %เติม, เกรดตอนเกิด) |
| `levels <SYMBOL> [tf]` | แผนที่ liquidity + กรอบราคา — ใช้แทนการกะแนวรับแนวต้านด้วยตา |
| `health` | เช็คว่าเอนจินโหลดแล้วและสะพาน klines ของ binance ติดต่อได้ |

tf ที่รองรับ: `1m 3m 5m 15m 30m 1h 2h 4h 6h 12h 1d 1w` (ค่าเริ่มต้น `15m`)
TF ใหญ่เลือกอัตโนมัติ: 15m→1h, 1h→4h, 4h→1d

```bash
curl -s -X POST http://127.0.0.1:8787/plugin/smc-radar/cmd \
  -H "content-type: application/json" -d '{"cmd":"smc","args":"BTCUSDT 15m"}'
```

---

## 5 สถานการณ์ที่ตรวจได้

| # | scenario | เงื่อนไข | SL ตามอินโฟกราฟิก |
|---|---|---|---|
| 1 | `uptrend-bos` | bull FVG เกิดหลัง BOS ขึ้น ภายใน 10 แท่ง ขณะ bias = up | ใต้ FVG |
| 2 | `downtrend-bos` | bear FVG เกิดหลัง BOS ลง ขณะ bias = down | เหนือ FVG |
| 3 | `post-mss` | FVG เกิดหลังโครงสร้างพลิก (MSS) | ใต้/เหนือ swing ล่าสุด |
| 4 | `fvg-sweep` | FVG เกิดภายใน 5 แท่งหลังกวาด liquidity | ใต้/เหนือ จุดที่กวาด |
| 5 | `range-edge` | ตลาดไม่เทรนด์ + FVG อยู่ที่ขอบกรอบ | ใต้/เหนือ ขอบกรอบ |
| — | `unclassified` | **ไม่มีเรื่องเล่าเชิงโครงสร้าง → เข้า watchlist เท่านั้น ไม่เป็น setup ไม่ว่าคะแนนเท่าไหร่** | — |

`priority` เรียงตามตาราง (sweep ชนะสูงสุด) ที่เหลือไปอยู่ `alsoMatches[]`

---

## นิยามที่ตกลงไว้ (จุดที่คนเถียงกันบ่อยที่สุด)

**FVG** = ช่องว่าง 3 แท่ง — bull: `candle[i-1].high < candle[i+1].low` (เข้ม `<` ไม่ใช่ `<=` การแตะพอดีไม่ใช่ช่องว่าง)
โซนที่แท่งกลาง `i` **ยังไม่มีใครรู้จนกว่าแท่ง `i+1` จะปิด** ทุกโซนจึงถือ `confirmIdx = i+1` และ lifecycle ประเมินเฉพาะแท่งหลังจากนั้น

**ขอบเขต** — เข้าโซนใช้ `<=`/`>=` · ปิดทะลุใช้ `<`/`>` เข้ม

**filled vs invalidated** — wick ทะลุทั้งช่อง = `filled` (โซนทำงานแล้ว premise ยังอยู่) · **body ปิด**เลยฝั่งไกล = `invalidated` (premise ตาย)
สาเหตุ invalidate 3 อย่าง: `close-through` · `age` (>60 แท่ง) · `opposing-mss`

**BOS vs MSS** — break คือ **close** ทะลุ swing ฝั่งตรงข้าม (ไม่เอา wick) · BOS = ไปทางเดียวกับ bias เดิม · MSS = break **แรก**ที่สวน bias
กันนับซ้ำ 2 ชั้น: level หนึ่ง break ได้ครั้งเดียว และ bias พลิกทันทีที่ MSS ยิง → MSS ทางเดียวกันสองครั้งติดเป็นไปไม่ได้โดยโครงสร้าง

**Sweep ≠ breakout** — ต้องครบ 5 ข้อ: wick ทะลุ band · ทะลุ ≥0.05 ATR · ทะลุ ≤1.5 ATR · **close กลับเข้ามา** · wick ครอง ≥40% ของแท่ง

**เป้าหมาย (TP)** — ต้องเป็น *ระดับจริง* เสมอ: บ่อ liquidity ที่ยังไม่ถูกกวาด หรือ swing extreme ที่ราคา**ยังไม่เคยปิดทะลุ**
ต้องห่าง entry อย่างน้อย 1 ATR (ไม่งั้นเป็น noise ไม่ใช่จุดหมาย) ไม่เกิน 8 ATR (ไม่งั้นไปไม่ถึงใน TF นี้) และต้องอยู่พ้นราคาปัจจุบัน (เป้าที่ราคาผ่านไปแล้วคือเป้าที่ถูกกินไปแล้ว)
ไม่มีเป้าที่เข้าเกณฑ์ → `reject: "no-target"` **ไม่ปั้นเป้าจาก R-multiple** เพราะจะสร้าง R:R ที่ตลาดไม่เคยเสนอให้

---

## readiness — หัวใจของ "โซนรอราคา"

| ค่า | ความหมาย | entryType |
|---|---|---|
| `waiting` | ราคายังไม่ถึงโซน | `limit-plan` — แผนรอ |
| `armed` | แท่งปิดล่าสุดตัดโซนแล้ว | `limit-plan` — รอแท่งยืนยัน |
| `triggered` | มีแท่ง**ปิด**ที่ทำปฏิกิริยาจริง | `confirmed-close` |

เอนจิน **ยิง `triggered` จากการมี FVG เฉย ๆ ไม่ได้เด็ดขาด** ต้องมีแท่งปฏิกิริยาที่ปิดแล้ว
และแม้ `triggered` ก็ยังเป็นข้อเสนอ ไม่ใช่คำสั่ง

---

## การให้คะแนนและเกรด

น้ำหนัก: post-MSS 22 · post-BOS 18 · HTF ตรงทาง 18 (สวนทาง −12) · premium/discount 14 / 7 / 0 / **−10** ·
มี liquidity เป้าหมาย 12 (+4 ถ้าแข็ง) · เกิดหลัง sweep 12 · displacement 0–10 · โซนยังสด 8 · ทับ HTF FVG 6 (สวน −8) · volume 4

```
A ⟺ score ≥ 90 ∧ (postMss ∨ postBos) ∧ htfAligned ∧ pdAligned ≠ false
              ∧ rr ≥ 2.0 ∧ state ≠ "ce" ∧ ¬atrFloored ∧ (ไม่ใช่ sweep ∨ sweep ยืนยันแล้ว)
B ⟺ score ≥ 70 ∧ (postMss ∨ postBos ∨ sourceSweep) ∧ rr ≥ 1.8
C ⟺ score ≥ 40                          อื่น ๆ → watchlist
```

เกรดถูก **cap** ได้ด้วยข้อเท็จจริงที่ยืนยันไม่ได้ (ข้อมูลบางส่วน, ATR ต่ำผิดปกติ, ไม่มี bias, sweep ยังไม่ยืนยัน, HTF สวนทาง, ขอบกรอบยังไม่ถูกทดสอบ, ผันผวนสูง) — เหตุผลถูกบันทึกใน `gradeCaps[]` และแสดงในข้อความ setup ที่คะแนนสูงแต่ได้ C จึงอธิบายตัวเองได้ ไม่ดูเหมือนคำนวณผิด

### Calibration (วัดจริง ไม่ใช่ประกาศ)

รันบน **12 เหรียญ × 1,632 snapshot** ของ klines 15m จริง (`analyzeAsOf` เดินทีละ 5 แท่ง):

| เกรด | สัดส่วนของโซนที่ได้คะแนน |
|---|---|
| **A** | **5.5%** |
| B | 40.8% |
| C | 45.7% |
| ต่ำกว่าเกณฑ์ (watchlist) | 8.0% |

snapshot ที่มี setup อย่างน้อย 1 อัน: 32.7%
ค่าตั้งต้นชุดแรก (90/70 → เดิม 78/58) ทำให้ A ออกถึง 21% ซึ่งเป็นเกรดที่พบบ่อยเกินจนไม่มีความหมาย — **ถ้าแก้น้ำหนักเมื่อไหร่ ต้องวัดใหม่**

---

## การรับประกันความซื่อตรง

| # | รับประกัน | บังคับด้วย |
|---|---|---|
| H1 | ใช้เฉพาะแท่งที่ปิดแล้ว | `sealCandles(candles, nowMs)`; `Date.now()` อยู่ใน `index.js` ที่เดียว |
| H2 | causality ต่อโซน | ประเมิน lifecycle เฉพาะ `j > confirmIdx` |
| H3 | prefix determinism | เทสต์ formation-immutability 60 prefix + `analyzeAsOf` |
| H4 | tail honesty | `wing` แท่งสุดท้ายไม่เป็น pivot และ output พูดออกมา (`unconfirmedTailBars`) |
| H5 | **unknown ≠ false** | คำนวณไม่ได้ = `null` ได้ 0 เสีย 0 ลง `unknowns[]` |
| H6 | เช็คที่ต้องใช้อนาคตถูก label | sweep ใกล้หาง = `pending`, cap เกรดที่ C |
| H7 | ไม่มี trading surface | ไม่มี qty/leverage/orderId ใน output (มีเทสต์) |
| H8 | reproducible | ไม่มี random ไม่มี wall-clock ในเอนจิน |

**ผลตรวจจริง** (BTC/ETH/SOL 15m, 300 แท่ง): precision 152 โซน ผิด 0 · recall ในกรอบ 60 แท่งล่าสุด — ช่องว่างที่ไม่ถูกรายงานทุกอันอธิบายได้ด้วย filter ที่ documented (`too-small`, `below-pct-floor`, `data-gap`) ไม่มี unexplained

---

## ข้อจำกัดที่รู้อยู่

1. **swing set ต่างจาก `fractals()` ของ desk โดยตั้งใจ** — desk ใช้ strict ทั้งสองข้าง (double top = 0 pivot); ที่นี่ใช้ max-window + strictly-greater-left (plateau ให้ pivot ตัวแรกตัวเดียว) เพราะ equal highs *คือ* บ่อ liquidity `fractalsStrict` ถูก export ไว้ cross-check
2. **MSS displacement gate ใช้ FVG ที่ยืนยันแล้วเท่านั้น** (`confirmIdx <= j`) สเปกแรกอนุญาต `i ∈ [j-1, j+1]` แต่โซนที่ `i = j` ยืนยันที่ `j+1` — ทำตามตรงจะให้แท่งอนาคตมาแก้ label ของ break ในอดีต การทดสอบ close-delta ครอบคลุมกรณี "แท่ง break เองที่ displace" อยู่แล้ว
3. **สัดส่วน `filled`/`invalidated` สูงมากเป็นเรื่องปกติ** — ดึง 300 แท่งเพื่อคำนวณโครงสร้าง/ADX/pool แต่ `maxAgeBars = 60` โซนเก่ากว่านั้นเป็นโบราณคดี
4. **sweep อาจถูกรายงานซ้ำในแท่งเดียวกัน** ถ้าแท่งนั้นกวาดหลายบ่อที่ทับกัน — เป็นข้อมูล ไม่ใช่บั๊ก แต่ต้องรู้ไว้ตอนอ่าน
5. **`engine.js` ต้อง bust require.cache เอง** — host `delete require.cache` เฉพาะ `index.js` (`daemon/plugins.js:91`) ถ้าไม่ทำ การแก้เอนจินจะไม่มีผลข้าม `/plugins/reload` แบบเงียบ ๆ ดูบรรทัดแรกของ `index.js`
6. **`/plugin/*` ไม่อยู่ใน PIN whitelist** (`server.js` `PIN_INGRESS_*`) — ถ้าเจ้าของเปิด UI PIN เมื่อไหร่ การเรียก loopback ทุกตัวจะได้ 401 รวมถึง regime-radar → binance ที่มีอยู่แล้ววันนี้
7. **ไม่มี timer** และไม่ควรมีจนกว่าจะแก้เรื่อง unload hook — host ไม่มี hook ตอน unload ดังนั้น `setInterval` จาก instance เก่าจะค้างตลอดไป ทุก reload = timer เพิ่มอีกตัว หยุดไม่ได้นอกจาก restart daemon (ปัญหานี้ `sentiment-autoscan` มีอยู่แล้วแบบแฝง)
8. **ไม่ backtest ไม่เคลมว่ามี edge** — รายงานเรขาคณิต ส่วนเรขาคณิตนั้นทำเงินได้ไหมเป็นงานคนละชิ้น

---

## เทสต์

```bash
node --check plugins/smc-radar/index.js && node --check plugins/smc-radar/engine.js
node --test daemon/tests/smc-radar.test.js
```

27 เทสต์ ครอบคลุม: geometry + control case ทุกตัว (`F1b` แตะพอดี → 0 โซน, `F4b` wick ไม่ใช่ BOS, `F6b` breakout ไม่ใช่ sweep),
plateau/tie, ATR parity กับ `plugins/binance/index.js:224`, degenerate inputs, และ **การพิสูจน์ no-lookahead**

หมายเหตุเรื่องเทสต์ no-lookahead: การเทียบ `analyze(prefix).zones === analyze(full).zones` ตรง ๆ **เป็นเทสต์ที่ผิด** —
run เต็มย่อมเห็นโซนใหม่กว่า และโซนที่ยังไม่ถูกแตะที่แท่ง 240 อาจถูกเติมแล้วที่ 300 ถ้า "แก้" เอนจินให้ผ่านเทสต์นั้นคือพังเอนจิน
เทสต์จริงคือ **formation immutability** (`id, dir, top, bottom, i, confirmIdx, ts, formGrade` ต้องเหมือนทุกตัวอักษร)
บวก **monotone lifecycle** (state เดินหน้าอย่างเดียว, `maxPenetration` ไม่ลด)
