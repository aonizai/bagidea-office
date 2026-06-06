# อัปเดตโปรแกรม & ตัวติดตั้ง

## ระบบแจ้งเตือนอัปเดต

โปรแกรมเช็ค GitHub เองทุก 6 ชั่วโมง (และหลังเปิด ~90 วินาที) — เมื่อมี
เวอร์ชันใหม่บน `main`:

- แถบ **🔄 มีเวอร์ชันใหม่ — คลิกเพื่ออัปเดต** ปรากฏเหนือหน้าแชท
- มีแจ้งใน 📡 feed ด้วย

คลิกแถบ (หรือสั่ง `bagidea update`) แล้วระบบจะ:

1. ปิดโปรแกรมทั้งชุด
2. `git pull` โค้ดล่าสุด
3. คอมไพล์ shell ใหม่*เฉพาะเมื่อ*โค้ดส่วน shell เปลี่ยน (ไม่มี Rust ในเครื่อง
   ก็ใช้ exe เดิมต่อได้ พร้อมคำแนะนำ)
4. เปิดโปรแกรมกลับมาเอง

> ข้อมูลของคุณ (ทีม agents, threads, โปรเจค, โน้ต, key vault) อยู่ในไฟล์
> ที่ git ไม่แตะ (`registry.json`, `sessions.json`, `projects.json`, …) —
> อัปเดตกี่ครั้งก็ไม่หาย

## ตัวติดตั้ง (สำหรับเครื่องใหม่)

```powershell
irm https://raw.githubusercontent.com/bagidea/bagidea-ai-agents-office/main/installer/install.ps1 | iex
```

| ขั้น | ทำอะไร |
|---|---|
| 1-4 | ติดตั้ง Git / Node LTS / Claude Code CLI / Rust (ผ่าน winget — ข้ามของที่มี) |
| 5 | ดาวน์โหลด Godot 4.6.3 + ตั้ง `BAGIDEA_GODOT` ให้ |
| 6 | clone โปรแกรม → `%LOCALAPPDATA%\BagIdeaOffice\app` (มีแล้ว = pull) |
| 7 | คอมไพล์ shell (ครั้งแรก ~2-3 นาที) |
| 8 | ผูกคำสั่ง `bagidea` เข้า PATH |
| 9 | สร้าง Start Menu shortcut |

รันซ้ำได้เสมอ — ใช้เป็น "repair install" ได้ในตัว

**หลังติดตั้งครั้งแรก:** เปิดเทอร์มินัลใหม่ → `claude` (login บัญชี Claude
ครั้งเดียว) → `bagidea start` 🎉
