# Roadmap: จากเดสก์ทดลอง → เดสก์ระดับโลก (2026-07-27)

ผลจากการออกแบบ 3 มุม + adversarial review + การศึกษาเชิงคำนวณ 3 ชิ้น
(7 agents, ทุกตัวเลขคำนวณจากข้อมูล pinned, ทุกข้อเสนอผ่าน critic ที่พยายามยิงทิ้ง)

## ข้อสรุปที่ทั้งสามมุมมาบรรจบกันเอง

> ที่ทุน $5k กับ notional cap $50 — PnL ของทุกข้อเสนอวัดเป็นเซนต์
> **ผลิตภัณฑ์จริงมีชิ้นเดียว: โรงงานวิจัยที่ pre-registered + ธรรมาภิบาลที่กันหลอกตัวเอง**
> ทุกอย่างที่เหลือคือ optionality ที่ต้องตีราคาตามนั้น

นี่ไม่ใช่การยอมแพ้ — เดสก์ที่มีเครื่องทดสอบสมมติฐานได้ในวันเดียว พร้อมเกณฑ์ที่ล็อกก่อนเห็นผล
คือสิ่งที่ scale ได้ทันทีเมื่อเจอ edge จริงหรือเมื่อทุนโต ในขณะที่ position ขนาดเซนต์ scale ไม่ได้

## สถานะความรู้ (อย่าทดสอบซ้ำ — ดู research-log look #1-16)

| คลาส | สถานะ | หลักฐาน |
|---|---|---|
| Directional TA (เดี่ยวเหรียญ) | 🔒 CLOSED | n=987, −0.166R, แพ้ control, gross t=1.6 |
| Funding carry always-on | ตายเชิง regime | 2026-H1 cross-section mean −2.3%/ปี, 11/15 เหรียญ ≤0 |
| Funding timing/rotation | DEAD | ranking skill จริง (z=16) แต่ turnover กินหมดทุกเวอร์ชัน |
| Cross-sectional momentum | MARGINAL — ค้างรอ CEO ruling | k=60: t=1.47 ชนะ p95 แต่ต่ำกว่าเกณฑ์ + selection |
| Quarterly basis | MARGINAL — plumbing เท่านั้น | executable บน testnet จริง แต่ ≈±$0.4/ไตรมาส |
| ความจริงเชิงพอร์ต | วัดแล้ว | corr เฉลี่ย 0.65, PC1=72% → 5 เหรียญ = **เดิมพัน 1.4 ตัว** |

## ลำดับ build (ตาม critic จัด — งานที่ปกป้องงานอื่นมาก่อน)

1. **Mandate change-control + config-drift sentinel** (วัน) — เหตุการณ์จริง 3 ครั้งของเดสก์ล้วนเป็นโหมดนี้
   รวมเหตุ 27 ก.ค.: ปิดสาย directional วันก่อน แต่เอเจนต์เปิดไม้ XRPUSDT ผ่านประตู `autotrade` ได้วันถัดมา (−$0.06 = fee bleed บน scratch ตามที่พยากรณ์)
2. **แก้ breakeven buffer** (วัน) — 0.10% < ต้นทุน 0.18% = scratch ทุกไม้คือขาดทุนการันตี **แต่ต้องได้คำ pre-commit จาก CEO ก่อน (ดูหัวข้อถัดไป)**
3. **Cost telemetry / Jensen reconciliation** (วัน) — ทำ 0.243R vs 0.13R ให้เป็น identity ที่ assert ได้ + ตอบว่า H-AUTO-1 ขาด funding บนไม้ค้าง 8h หรือไม่
4. **Research factory CLI** (สัปดาห์) — `study run <manifest>`: หนึ่งคำสั่ง = pre-register → replay → score → verdict; ต้อง reproduce H-AUTO-1 แบบ byte-identical ก่อนรับงานใหม่; fold cost-floor pre-screen (0.18/stop%) + universe-as-of-date เข้า manifest
5. **Drawdown governance HWM ladder** (วัน) — ให้สัตยาบันตอน flat; daily breaker เดิม reset เที่ยงคืน = grind 2%/วันได้เรื่อย ๆ
6. **Portfolio-truth module** (วัน) — slot นับตาม correlation ไม่ใช่ตามจำนวนเหรียญ (3 ไม้ทิศเดียว = 1 เดิมพัน × 2.9 เท่า)
7. **Carry regime monitor** (วัน) — trailing-30d funding ทุกเหรียญ + **decision protocol เขียนล่วงหน้า** (critic: alert ที่คนรับ act ไม่ได้ = แรงกดดันให้ improvise บัญชี mainnet ตอนหัวร้อน)

**คิวรอง (optionality):** k=60 xsec retest แบบ pre-registered + multiplicity-adjusted (หลัง CEO ruling) · quarterly-basis phase-0 monitor · maker entries (GTX+TTL) + TCA — เมื่อมี live candidate เท่านั้น

## ⚠️ กับดักที่ critic เจอและทุกมุมพลาด: reopen ticket ที่กำลังถูกผลิตโดยไม่ตั้งใจ

การแก้ BE buffer + partial-TP geometry รวมกัน = **"exit rule ที่ต่างในสาระ"** = เงื่อนไข reopen
ที่ถูกต้องตามสัตยาบันของสาย directional ที่เพิ่งปิด และแรงกดดันให้ "ลอง H-AUTO-1 อีกทีด้วย exit ใหม่"
จะมหาศาล (gross เดิม +0.077R, การแก้กู้คืน ~0.03-0.05R — ใครสักคนจะบวกเลขแล้วเห็นว่าอาจข้ามศูนย์)

**CEO ต้อง pre-commit เป็นลายลักษณ์อักษร ก่อน fix จะ ship:**
- (ก) retest H-AUTO-1 ด้วย exit ที่แก้แล้ว **หนึ่งครั้ง** แบบ pre-registered, charge เข้า look ledger — หรือ
- (ข) ไม่ retest เลย

ตัดสินหลัง fix ship = ตัดสินใต้แรงยั่ว · prior ที่ต้องรู้ก่อนเลือก: แม้กู้ cost คืนสมบูรณ์
ก็ได้ ~+0.08R gross ที่ t~1.6 — **ยังต่ำกว่าทุกเกณฑ์**

## การตัดสินที่เป็นของ CEO เท่านั้น (เรียงตามความเร่ง)

1. **Mandate ruling หลังปิดสาย directional:** เอเจนต์ยังเปิดไม้ผ่านคำสั่ง `autotrade` ใต้กรอบ AUTO-ARM เดิมได้ (เกิดจริง 27 ก.ค.) — ตั้งใจให้เป็นแบบนั้น หรือปิดประตูนี้ด้วย?
2. **Reopen pre-commit** (ข้อ ก/ข ด้านบน) — ก่อนแตะ BE buffer
3. **Class ruling:** cross-sectional momentum = คลาสใหม่ (beta-netted) หรือ directional TA ใส่เสื้อใหม่?
4. ให้สัตยาบันตัวเลข HWM ladder + decision protocol ของ carry monitor

## สิ่งที่บันทึกเข้า ledger แล้ว
look #14 xsec momentum (MARGINAL) · #15 funding timing (DEAD) · #16 quarterly basis (MARGINAL)
— ทั้งหมดอยู่ใน workspace/memory/research-log.md · ข้อมูล funding ครบ 15 เหรียญ + สคริปต์การศึกษาอยู่ใน workspace/edge-validation/wave2/
