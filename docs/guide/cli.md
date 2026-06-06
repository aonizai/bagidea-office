# bagidea CLI — คุมออฟฟิศจากเทอร์มินัล

ตัวติดตั้งผูกคำสั่ง `bagidea` เข้า PATH ให้แล้ว (ติดตั้งเอง: ใช้ `bagidea.cmd`
ที่ root ของ repo หรือเพิ่มโฟลเดอร์ repo เข้า PATH)

## คำสั่งทั้งหมด

```
bagidea start                 เปิดโปรแกรม (ถ้ายังไม่เปิด)
bagidea stop                  ปิดทั้งชุด (shell + วอลเปเปอร์ + daemon)
bagidea status                สถานะระบบ + agents + โปรเจค + ใครทำงานอยู่
bagidea ask "<ข้อความ>"        ถาม Director และ "รอ" จนได้คำตอบสุดท้าย
bagidea chat <agent> "<msg>"  ส่งงานให้ agent ระบุตัว (ไม่รอคำตอบ)
bagidea projects              รายชื่อโปรเจค + สถานะสด
bagidea open "<ชื่อโปรเจค>"    เปิดหน้าต่างโปรเจค (เหมือนปุ่ม ▶)
bagidea feed                  สตรีมเหตุการณ์สดในเทอร์มินัล (Ctrl+C ออก)
bagidea update                อัปเดตเวอร์ชันล่าสุด + รีสตาร์ทให้
bagidea version               commit ปัจจุบัน
bagidea help                  หน้านี้
```

## ตัวอย่างการใช้จริง

```powershell
# เปิดเครื่องมา สั่งเปิดออฟฟิศจากเทอร์มินัลเลย
bagidea start

# ถามอะไรก็ได้ — คำสั่งค้างรอจนคำตอบจบ (เหมาะกับใช้ในสคริปต์)
bagidea ask "สรุปงานที่ทีมทำไปเมื่อคืนให้หน่อย"

# สั่งงานยาวๆ แบบไม่รอ แล้วเปิดจอดูเหตุการณ์
bagidea chat pixel "รีแฟกเตอร์ CSS ของโปรเจค Calculator ทั้งหมด"
bagidea feed

# เช็คว่าใครทำอะไรอยู่
bagidea status
```

## ใช้ร่วมกับสคริปต์/automation

- `ask` คืนข้อความล้วนทาง stdout — pipe ต่อได้เลย:
  ```powershell
  bagidea ask "เขียน commit message จาก git diff นี้: $(git diff --stat)" | clip
  ```
- ทุกคำสั่งคุยกับ daemon ที่ `http://127.0.0.1:8787` — endpoint เดียวกับที่
  UI ใช้ (ดูตาราง HTTP API ใน README) เขียน integration ของคุณเองได้ตรงๆ
- `feed` อ่านจาก `daemon/journal.jsonl` — log ถาวรของทั้งออฟฟิศ
