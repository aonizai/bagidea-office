# อัปเดตโปรแกรม & ตัวติดตั้ง

## ระบบแจ้งเตือนอัปเดต (อิงเวอร์ชัน)

โปรแกรมมีไฟล์ **`VERSION`** (เช่น `0.3.1`). มันเช็คเองทุก 6 ชั่วโมง (และหลังเปิด
~90 วินาที) ว่าเวอร์ชันบน `main` ใหม่กว่าของคุณไหม — **เฉพาะตอนที่ออกเวอร์ชันใหม่จริง
(bump ไฟล์ VERSION)** เท่านั้นถึงจะเด้งเตือน. การแก้เล็กๆ น้อยๆ (เอกสาร, เว็บ, งานใน
branch dev) จะ **ไม่** รบกวนผู้ใช้ — ดู [แผนการออกเวอร์ชัน](#แผนการออกเวอร์ชัน-dev--main)

เมื่อมีเวอร์ชันใหม่:

- แถบ **🔄 มีเวอร์ชันใหม่ vX.Y.Z — คลิกเพื่ออัปเดต** ปรากฏเหนือหน้าแชท
- มีแจ้งใน 📡 feed ด้วย
- เช็คเองได้: `bagidea version` (โชว์เวอร์ชันปัจจุบัน + บอกถ้ามีใหม่)

คลิกแถบ (หรือสั่ง `bagidea update`) แล้วระบบจะ:

1. ปิดโปรแกรมทั้งชุด
2. `git pull` โค้ดล่าสุด
3. คอมไพล์ shell ใหม่*เฉพาะเมื่อ*โค้ดส่วน shell เปลี่ยน (ไม่มี Rust ในเครื่อง
   ก็ใช้ exe เดิมต่อได้ พร้อมคำแนะนำ)
4. เปิดโปรแกรมกลับมาเอง

> ข้อมูลของคุณ (ทีม agents, threads, โปรเจค, โน้ต, key vault) อยู่ในไฟล์
> ที่ git ไม่แตะ (`registry.json`, `sessions.json`, `projects.json`, …) —
> อัปเดตกี่ครั้งก็ไม่หาย

## เปิดอัตโนมัติตอนล็อกอิน (auto-start)

ตั้งให้ออฟฟิศเปิดเองตอนเปิดเครื่องได้ 3 ทาง — รองรับครบทั้ง 3 OS (Windows = HKCU Run key,
macOS = LaunchAgent, Linux = ไฟล์ XDG `~/.config/autostart/bagidea-office.desktop`):

- **Settings** ⚙ → AGENTS → สวิตช์ **🪟 Start at login**
- **CLI:** `bagidea startup on` / `bagidea startup off` (ไม่ใส่ = ดูสถานะ)
- **Tray:** คลิกขวาไอคอน → **Start at login**

> **อัปเดตบน macOS/Linux:** `bagidea update` ใช้ได้เหมือนกัน (Linux เรียก
> `installer/update-linux.sh` = git pull + คอมไพล์ shell ใหม่ถ้าจำเป็น + รีสตาร์ท).

## แผนการออกเวอร์ชัน (dev → main)

ระบบแจ้งเตือนผูกกับไฟล์ `VERSION` บน `main` เพื่อให้ผู้ใช้ได้แต่ของที่พร้อมจริง:

1. พัฒนาบน branch **`dev`** (push ขึ้น dev ได้เรื่อยๆ — ไม่กระทบผู้ใช้)
2. ตรวจจนมั่นใจว่าไม่มีบัค แล้ว merge `dev` → `main`
3. ออกเวอร์ชันใหม่ = **bump `VERSION`** (semver) บน `main` แล้ว push
   → เครื่องผู้ใช้เห็นว่ามีใหม่กว่า แล้วเด้งแถบ 🔄

> สรุป: merge เข้า main ได้โดยยังไม่เด้งเตือน ตราบใดที่ยังไม่ bump `VERSION` —
> เด้งเตือน "เมื่อเราตั้งใจปล่อยเวอร์ชันใหม่" เท่านั้น (ดู `RELEASING.md`)

## ตัวติดตั้ง (สำหรับเครื่องใหม่)

```powershell
irm https://raw.githubusercontent.com/bagidea/bagidea-office/main/installer/install.ps1 | iex
```

| ขั้น | ทำอะไร |
|---|---|
| 1-4 | ติดตั้ง Git / Node LTS / Rust / **VS C++ Build Tools** (ผ่าน winget — ข้ามของที่มี) |
| 5-6 | ดาวน์โหลด Godot 4.6.3 + ตั้ง `BAGIDEA_GODOT` · ติดตั้ง Claude Code CLI |
| 7 | clone โปรแกรม → `%LOCALAPPDATA%\BagIdeaOffice\app` (มีแล้ว = pull) |
| 8 | คอมไพล์ shell (ครั้งแรก ~2-3 นาที) + ตีตราไอคอน |
| 9-11 | แก้ hook paths · ผูกคำสั่ง `bagidea` เข้า PATH · สร้าง Start Menu shortcut |

> ติดตั้งไม่ผ่าน? ดู [แก้ปัญหาการติดตั้ง](troubleshooting.md#แก้ปัญหาการติดตั้ง)

รันซ้ำได้เสมอ — ใช้เป็น "repair install" ได้ในตัว

**หลังติดตั้งครั้งแรก:** เปิดเทอร์มินัลใหม่ → `claude` (login บัญชี Claude
ครั้งเดียว) → `bagidea start` 🎉

## ถอนการติดตั้ง

```powershell
bagidea uninstall              # ถอนทั้งหมด (ยืนยันก่อน)
bagidea uninstall --keep-data  # สำรองข้อมูล (agents/projects/keys) ไว้ก่อนลบ
```

ลบเฉพาะของ BagIdea Office เอง: หยุดโปรแกรม, เอา `bagidea` ออกจาก PATH,
ลบ Start Menu shortcut, ปิด start-with-Windows, และลบโฟลเดอร์
`%LOCALAPPDATA%\BagIdeaOffice` — **ไม่ยุ่ง** Git / Node / Rust / Claude
(เครื่องมือที่ใช้ร่วมกับโปรแกรมอื่น ถ้าอยากลบค่อยใช้ winget เอง).
`--keep-data` จะสำรอง `registry/sessions/projects/...` + `workspace` ไปไว้ที่
`%USERPROFILE%\BagIdeaOffice-data-backup` ก่อน เผื่ออยากติดตั้งใหม่ภายหลัง
(เปิดเทอร์มินัลใหม่หลังถอนเพื่อให้ PATH อัปเดต)
