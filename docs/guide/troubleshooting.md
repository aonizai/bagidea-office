# แก้ปัญหาที่พบบ่อย

## แก้ปัญหาการติดตั้ง

ตัวติดตั้งออกแบบให้ "จบรวดเดียวบนเครื่องเปล่า" แต่บางเครื่องมีเงื่อนไขต่างกัน
ด้านล่างคืออาการที่พบบ่อยทั้งหมด พร้อมวิธีแก้ — เกือบทุกอย่างแก้ได้ด้วยการ
**เปิดเทอร์มินัลใหม่แล้วรันตัวติดตั้งซ้ำ** (รันซ้ำปลอดภัย ข้อมูลไม่หาย)

**`irm ... | iex` แล้วขึ้น error เรื่อง execution policy**
- รันด้วยบรรทัดนี้แทน:
  ```powershell
  powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/bagidea/bagidea-office/main/installer/install.ps1 | iex"
  ```

**ขึ้น `winget not found`**
- Windows เก่ายังไม่มี winget — ติดตั้ง **App Installer** จาก Microsoft Store
  (`https://apps.microsoft.com/detail/9nblggh4nns1`) แล้วเปิดเทอร์มินัลใหม่ รันซ้ำ

**ลง Git/Node เสร็จแต่ขึ้นว่า `git`/`node` ไม่พบ ตอนรันต่อ**
- winget เขียน PATH ลง registry แต่เทอร์มินัลเดิมยังไม่เห็น — ตัวติดตั้งดึง PATH
  ใหม่ให้แล้วในรอบเดียว แต่ถ้ายังเจอ ให้**ปิดเทอร์มินัลแล้วเปิดใหม่ รันซ้ำ** หายแน่นอน

**`BUILD FAILED` / `cargo build` ขึ้น `error: linker 'link.exe' not found` หรือ `link.exe returned exit code`**
- นี่คืออาการที่พบบ่อยที่สุด: Rust ต้องใช้ **C++ linker** ของ Visual Studio
- ตัวติดตั้งเวอร์ชันนี้ลง **VS C++ Build Tools** ให้อัตโนมัติ แต่ถ้ารอบนั้นข้ามไป/ลงไม่ครบ
  ลงเองด้วย:
  ```powershell
  winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```
  หรือเปิด **Visual Studio Installer** → Modify → ติ๊ก **Desktop development with C++** → Install
- เสร็จแล้ว **เปิดเทอร์มินัลใหม่** (ให้ตัวแปร build แวดล้อมโหลด) แล้วรันตัวติดตั้งซ้ำ

**`cargo`/`rustup` ไม่พบ หลังเพิ่งลง Rust**
- เปิดเทอร์มินัลใหม่ หรือรันชั่วคราว: `$env:Path += ";$env:USERPROFILE\.cargo\bin"` แล้วรันซ้ำ

**ดาวน์โหลด Godot ค้าง/ล้มเหลว**
- ปัญหาเครือข่าย/ไฟร์วอลล์ระหว่างโหลดไฟล์จาก GitHub releases — เช็คเน็ตแล้วรันซ้ำ
  (ตัวติดตั้งจะข้ามขั้นที่เสร็จแล้ว ดาวน์โหลดเฉพาะที่ยังขาด)

**SmartScreen / Defender บล็อกสคริปต์หรือ exe**
- สคริปต์เป็น open-source อ่านได้ที่ repo — กด **More info → Run anyway**
  หรือดาวน์โหลด `install.ps1` มาอ่านก่อนแล้วรันเอง

**build สำเร็จแต่พิมพ์ `bagidea` ไม่เจอ**
- คำสั่งเพิ่งถูกเติมเข้า PATH — **เปิดเทอร์มินัลใหม่** แล้วลองอีกครั้ง
  (หรือเปิดจาก Start Menu → "BagIdea Office")

**อยากเริ่มใหม่ทั้งหมด**
- ลบ `%LOCALAPPDATA%\BagIdeaOffice` แล้วรันตัวติดตั้งใหม่ (ข้อมูลในนั้นจะหายด้วย —
  สำรอง `app\daemon\*.json` ไว้ก่อนถ้าต้องการเก็บ registry/sessions)

## Linux (experimental 🧪)

**คอมไพล์ shell ไม่ผ่าน (ขาด WebKitGTK ฯลฯ)**
- ตัวติดตั้งลง `libwebkit2gtk-4.1-dev` (Ubuntu ใหม่) หรือ `4.0` (เก่า) ให้อัตโนมัติ —
  ถ้าพังให้ลงเองแล้วรัน `./build-linux.sh` ใหม่: `sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev build-essential pkg-config`

**`bagidea: command not found`**
- ตัวติดตั้งทำ symlink ที่ `~/.local/bin/bagidea` — เปิด terminal ใหม่ หรือ
  `export PATH="$HOME/.local/bin:$PATH"`

**วอลเปเปอร์ไม่ติดพื้นหลัง (เป็นหน้าต่างลอย)**
- เช็คว่าเป็น X11: `echo $XDG_SESSION_TYPE` → ถ้าได้ `x11` ต้องมี `wmctrl`/`xdotool`
  (`sudo apt install wmctrl xdotool`). ถ้าได้ `wayland` = ใช้ fallback หน้าต่างเต็มจอล่างสุด (ตามดีไซน์)
- orb โปร่งใสต้องมี compositor ทำงาน (DE ส่วนใหญ่มีให้อยู่แล้ว)

**ไม่มีเสียง (`bagidea say`)**
- ลง player: `sudo apt install pulseaudio-utils alsa-utils`

> เจอปัญหาอื่นบน Linux: แจ้ง [issue](https://github.com/bagidea/bagidea-office/issues)
> พร้อม distro, desktop, และ `echo $XDG_SESSION_TYPE`

## โปรแกรม / วอลเปเปอร์

**เปิดแล้วไม่มีอะไรเกิดขึ้น / วอลเปเปอร์ไม่เปลี่ยน**
- เปิดซ้ำสองรอบ? โปรแกรมเป็น single-instance — ตัวที่สองจะเงียบๆ ออกเอง
  เช็ค tray icon ก่อน (อาจเปิดอยู่แล้ว)
- Godot หาไม่เจอ: ตั้ง env `BAGIDEA_GODOT` ชี้ไปที่ exe ของ Godot 4.6.x
  แล้วเปิดใหม่ (ตัวติดตั้งตั้งให้อัตโนมัติ)
- `bagidea status` บอกได้ว่า daemon ขึ้นหรือยัง

**อยากซ่อนออฟฟิศชั่วคราว (ประชุม/อัดจอ)**
- คลิกขวา tray icon → **Hide office** — วอลเปเปอร์กลับเป็นปกติ เสียงเงียบ
  แต่ agents ทำงานต่อเบื้องหลังครบ — กดอีกครั้งเพื่อเรียกกลับ

**ปิดโปรแกรมยังไงให้สนิท**
- ทางเดียวคือ tray icon → **Exit BagIdea Office** (หรือ `bagidea stop`) —
  ปิดทั้งชุด + คืนวอลเปเปอร์เดิม

## Agents

**agent ไม่ตอบเลย / task.failed ทันที**
- login Claude หรือยัง? เปิดเทอร์มินัล รัน `claude` หนึ่งครั้ง
- โควต้า/credit หมดก็อาการเดียวกัน — ลอง `claude -p "hi"` ดูคำตอบตรงๆ

**การ์ดขอ permission เด้งทั้งที่ติ๊ก tools ให้แล้ว**
- ติ๊กใน "หน้าแก้ไข agent" แล้วกดบันทึกหรือยัง? tools ที่ให้ = เงียบเสมอ
- เครื่องมือที่*ไม่ได้*ติ๊กยังถามตามปกติ — กด **✓✓ ตลอดไป** เพื่อจำถาวร

**สั่งแล้วเงียบ ไม่เห็นความเคลื่อนไหว**
- ดูแถบ 🔵 NOW WORKING / 📡 feed — งานอาจกำลังรันอยู่
- `bagidea feed` ในเทอร์มินัลก็เห็นเหตุการณ์สดทั้งหมด

## Projects

**กด ▶ แล้วขึ้น "No conversation found to continue"**
- เป็นข้อจำกัดของ `claude -c` กับ session ที่เกิดแบบ headless — ปุ่ม ▶
  เวอร์ชันปัจจุบันใช้ `claude --resume <id>` ตรงๆ แล้ว ไม่ควรเจออีก
  (เจอ = เวอร์ชันเก่า → `bagidea update`)

**ลบโปรเจค (🗑) ไม่สำเร็จ**
- มีโปรแกรมล็อกไฟล์อยู่ — ระบบจะปิด dev server ที่ agent ลืมทิ้งไว้ให้เอง
  แล้วลองใหม่ ถ้ายังไม่ได้จะบอก error ในแถว: ปิดเทอร์มินัล/Explorer
  ที่ค้างอยู่ในโฟลเดอร์นั้นแล้วกดซ้ำ

**สถานะหน้าต่าง (เปิด/ปิด) ไม่ตรง**
- ระบบกวาดทุก 5 วินาที — รอแป๊บเดียว หรือปิด-เปิดแท็บ PROJECTS

## เสียง (F6)

**กดแล้วไม่มีอะไรขึ้น**
- เปิด Windows Voice Typing หรือยัง: Settings → Time & language → Speech
  → online speech recognition + ติดตั้งภาษาไทย
- ลองกด `Win+H` ตรงๆ ในช่องข้อความใดๆ — ถ้าไม่ขึ้นแปลว่าฟีเจอร์ OS ยังไม่พร้อม
- ปุ่มชน? เปลี่ยนคีย์ใน ⚙ → AGENTS → PUSH-TO-TALK HOTKEY

**พูดแล้วข้อความไปลงโปรแกรมอื่น**
- เวอร์ชันปัจจุบันบังคับ focus ก่อนเปิดไมค์แล้ว — ถ้ายังเจอ ให้คลิกหน้าต่าง
  แชทหนึ่งครั้งก่อนกด F6 และแจ้ง issue มาได้เลย

## Channels

**Telegram ขึ้น error: bad token** — token ผิด/หมดอายุ ขอใหม่จาก @BotFather
**Discord ค้าง connecting** — ลืมเปิด MESSAGE CONTENT INTENT ในหน้า Bot
**LINE ไม่เด้ง** — webhook URL ต้องเป็น public HTTPS และลงท้าย
`/channels/line/webhook`; เช็คว่า cloudflared ยังรันอยู่

## ดู log ดิบ

- เหตุการณ์ทั้งหมด: `daemon/journal.jsonl`
- ประวัติแชท: `daemon/sessions.json`
- รัน daemon เองเพื่อดู console สด: ปิดโปรแกรมก่อน แล้ว `node daemon\server.js`
