# เริ่มต้นใช้งาน BagIdea Office

> ออฟฟิศ AI มีชีวิตบนวอลเปเปอร์ของคุณ — พนักงานทุกตัวคือ Claude agent ของจริง

![โลกออฟฟิศบนเดสก์ท็อปจริง](../img/world.png)

## 1. ติดตั้ง

เปิด PowerShell แล้วรันบรรทัดเดียว:

```powershell
irm https://raw.githubusercontent.com/bagidea/bagidea-office/main/installer/install.ps1 | iex
```

ตัวติดตั้งจะจัดการให้ครบ **แม้บนเครื่องเปล่า** — ลงทุกอย่างที่ต้องใช้ให้เอง:
Git, Node.js LTS, Rust, **Visual Studio C++ Build Tools** (ตัว linker ที่ Rust ต้องใช้
และเป็นสาเหตุติดตั้งไม่ผ่านที่พบบ่อยที่สุด), Godot 4.6.3 และ Claude Code CLI →
โคลนโปรแกรมไว้ที่ `%LOCALAPPDATA%\BagIdeaOffice` → คอมไพล์ → ตีตราไอคอนหน้าต่าง →
ผูกคำสั่ง `bagidea` เข้า PATH และสร้าง Start Menu shortcut

- **รันซ้ำได้ปลอดภัย** — ข้ามของที่มีแล้ว, รันซ้ำ = `git pull` (ข้อมูลของคุณไม่หาย)
- ของที่ลงผ่าน winget จะถูกดึงเข้า PATH ของเทอร์มินัลปัจจุบันให้ทันที จึงทำงานต่อได้รวดเดียว
- ถ้าเครื่องยังไม่มี C++ Build Tools ตัวติดตั้งจะดาวน์โหลดให้ (~2–4 GB ครั้งเดียว) — รอบแรกจึงนานหน่อย

> ติดตั้งไม่ผ่าน? ดู **[แก้ปัญหาการติดตั้ง](troubleshooting.md#แก้ปัญหาการติดตั้ง)**
> — ครอบทุกอาการ (winget หาย, build fail, PATH ไม่อัปเดต, SmartScreen บล็อก) พร้อมวิธีแก้ทีละขั้น

**ครั้งแรกเท่านั้น:** เปิดเทอร์มินัล**ใหม่** (ให้ PATH โหลดคำสั่ง `bagidea`/`claude`)
แล้วรัน `claude` หนึ่งครั้งเพื่อ login บัญชี Claude จากนั้น:

```powershell
bagidea start
```

### ถ้าอยากติดตั้งเอง (manual)

```powershell
# 1) deps (ข้ามตัวที่มีแล้วได้)
winget install Git.Git OpenJS.NodeJS.LTS Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override `
  "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
npm install -g @anthropic-ai/claude-code
# 2) เปิดเทอร์มินัลใหม่ แล้วโคลน + build
git clone https://github.com/bagidea/bagidea-office.git "$env:LOCALAPPDATA\BagIdeaOffice\app"
cd "$env:LOCALAPPDATA\BagIdeaOffice\app\shell"; cargo build --release
# 3) ดาวน์โหลด Godot 4.6.3 (win64) วางไว้ แล้วตั้ง env BAGIDEA_GODOT ชี้ไปที่ exe
```

(ตัวติดตั้งบรรทัดเดียวด้านบนทำทั้งหมดนี้ให้อยู่แล้ว — manual ไว้สำหรับคนที่อยากคุมเอง)

## 2. สิ่งที่จะเกิดขึ้นตอนเปิด

1. โลโก้กลมๆ เต้นอยู่กลางจอครู่หนึ่ง (โลกกำลังโหลด)
2. วอลเปเปอร์ของคุณกลายเป็น **ตึกออฟฟิศ HD-2D** — อยู่*หลัง*ไอคอนเดสก์ท็อป
3. **chat head** วงกลมลอยมุมจอ + ไอคอนใน system tray

| การกระทำ | ผล |
|---|---|
| คลิก chat head | เปิด/ปิดหน้าต่างแชท |
| คลิกขวา chat head | สลับ 📡 feed mode (แถบสตรีมเหตุการณ์) |
| คลิกขวาไอคอน tray | เมนู: Hide office / Start with Windows / Exit |

แสง/ท้องฟ้าในออฟฟิศเดินตามเวลาจริงของเครื่องคุณ — ตี 4 ก็มืดจริง โคมไฟสวนเปิดจริง

## 3. แชทแรก

เปิดโปรแกรมมา หน้าต่างแชทจะ**โฟกัสที่ที่นั่ง CEO 👑 (ตัวคุณ)** ทันที — สั่งงานในนาม
CEO ได้เลย (ดูข้อ 4). ออฟฟิศใหม่มาพร้อม 2 คน: **คุณ (CEO)** กับ **Shino** —
มือขวาของคุณในตำแหน่ง **Director** (ผู้จัดการออฟฟิศ) บุคลิกหนุ่มขี้เล่นแต่จริงจังกับงาน
ถนัดสั่งงาน/บริหารทีมเป็นหลัก. อยากคุยกับ Shino ตรงๆ ให้คลิกที่นั่งของเขา
(⭐ ถัดจาก CEO) แล้วพิมพ์:

```
สวัสดี! แนะนำตัวหน่อย แล้วออฟฟิศนี้ทำอะไรได้บ้าง?
```

ลองสั่งงานจริง:

```
ช่วยค้นคว้าข้อดีข้อเสียของ static site generators 3 ตัวดัง แล้วสรุปเป็นตาราง
```

ถ้างานแยกส่วนได้ จะเห็นเขา **แตกร่าง** เป็นโคลนโปร่งแสงลอยขึ้นไปทำงานขนานกันบน
Ghost Deck แล้วรวมร่างสรุปผล — ทั้งหมดเป็น session จริง ดูย้อนได้ใน 🧵

## 4. สั่งงานผ่าน CEO (ตัวคุณ)

ที่นั่งสีทอง 👑 คือคุณเอง — พิมพ์ใส่ช่องนั้น Director จะ**เดินมารับคำสั่งถึงโต๊ะ**
วางแผน มอบหมายลูกทีม (เห็นการเดินส่งงานบนวอลเปเปอร์) และเมื่องานจบ
เขาจะเดินกลับมารายงานสรุปให้คุณถึงที่

## 5. ขั้นต่อไป

- [จ้างพนักงานเพิ่ม + ตั้ง persona](agents.md)
- [สร้างโปรเจคให้ agents ทำงานจริงในโฟลเดอร์](projects.md)
- [สั่งงานด้วยเสียง + feed mode](voice-feed.md)
- [ต่อ Telegram ไว้สั่งงานจากมือถือ](channels.md)
