# BagIdea AI Agents Office — one-shot installer.
# Installs every dependency, clones the app, builds it, wires the CLI, and
# launches the office. Safe to re-run (each step skips what already exists).
#
#   irm https://raw.githubusercontent.com/bagidea/bagidea-ai-agents-office/main/installer/install.ps1 | iex
#   (or run this file directly)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$APPDIR  = Join-Path $env:LOCALAPPDATA "BagIdeaOffice"
$REPO    = "https://github.com/bagidea/bagidea-ai-agents-office.git"
$GODOTV  = "4.6.3"
$GODOTZ  = "Godot_v$GODOTV-stable_win64.exe.zip"
$GODOTURL= "https://github.com/godotengine/godot/releases/download/$GODOTV-stable/$GODOTZ"

function Step($n, $msg) { Write-Host ""; Write-Host "  [$n] $msg" -ForegroundColor Cyan }
function Ok($msg)  { Write-Host "      + $msg" -ForegroundColor Green }
function Skip($msg){ Write-Host "      - $msg" -ForegroundColor DarkGray }
function Warn($msg){ Write-Host "      ! $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "   BagIdea AI Agents Office - INSTALLER" -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan

# ---- 0) winget --------------------------------------------------------------
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Warn "ไม่พบ winget - ติดตั้ง 'App Installer' จาก Microsoft Store ก่อน แล้วรันใหม่"
  exit 1
}

# ---- 1) Git -------------------------------------------------------------------
Step 1 "Git"
if (Get-Command git -ErrorAction SilentlyContinue) { Skip "มีอยู่แล้ว" }
else { winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements; Ok "ติดตั้งแล้ว (เปิดเทอร์มินัลใหม่ถ้า git ยังไม่เจอ)" }

# ---- 2) Node.js ---------------------------------------------------------------
Step 2 "Node.js LTS"
if (Get-Command node -ErrorAction SilentlyContinue) { Skip "มีอยู่แล้ว ($(node --version))" }
else { winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements; Ok "ติดตั้งแล้ว" }

# ---- 3) Claude Code CLI --------------------------------------------------------
Step 3 "Claude Code CLI (สมองของ agents)"
if (Get-Command claude -ErrorAction SilentlyContinue) { Skip "มีอยู่แล้ว" }
else {
  npm install -g @anthropic-ai/claude-code
  Ok "ติดตั้งแล้ว - อย่าลืม login ครั้งแรกด้วยคำสั่ง: claude"
}

# ---- 4) Rust (สำหรับคอมไพล์ shell) ----------------------------------------------
Step 4 "Rust toolchain"
if (Get-Command cargo -ErrorAction SilentlyContinue) { Skip "มีอยู่แล้ว" }
else { winget install --id Rustlang.Rustup -e --silent --accept-package-agreements --accept-source-agreements; Ok "ติดตั้งแล้ว" }

# ---- 5) Godot engine ------------------------------------------------------------
Step 5 "Godot $GODOTV (ตัว render โลกออฟฟิศ)"
$gdir = Join-Path $APPDIR "tools\godot"
$gexe = Join-Path $gdir "Godot_v$GODOTV-stable_win64.exe"
if (Test-Path $gexe) { Skip "มีอยู่แล้ว" }
else {
  New-Item -ItemType Directory -Force $gdir | Out-Null
  $zip = Join-Path $env:TEMP $GODOTZ
  Write-Host "      ดาวน์โหลด Godot..." -ForegroundColor DarkGray
  Invoke-WebRequest -Uri $GODOTURL -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $gdir -Force
  Remove-Item $zip -Force
  if (Test-Path $gexe) { Ok "ติดตั้งแล้ว" } else { Warn "แตก zip แล้วไม่พบ exe - เช็คโฟลเดอร์ $gdir" }
}
[Environment]::SetEnvironmentVariable("BAGIDEA_GODOT", $gexe, "User")
$env:BAGIDEA_GODOT = $gexe

# ---- 6) ตัวโปรแกรม -----------------------------------------------------------------
Step 6 "BagIdea Office (clone / update)"
$app = Join-Path $APPDIR "app"
if (Test-Path (Join-Path $app ".git")) {
  Push-Location $app; git pull --ff-only; Pop-Location; Ok "อัปเดตโค้ดแล้ว"
} else {
  New-Item -ItemType Directory -Force $APPDIR | Out-Null
  git clone $REPO $app
  if (Test-Path $app) { Ok "clone แล้ว -> $app" } else { Warn "clone ไม่สำเร็จ"; exit 1 }
}

# ---- 7) คอมไพล์ shell ----------------------------------------------------------------
Step 7 "คอมไพล์ตัวโปรแกรม (ครั้งแรกใช้เวลา ~2-3 นาที)"
$exe = Join-Path $app "shell\target\release\bagidea-office-shell.exe"
if (Test-Path $exe) { Skip "มี exe อยู่แล้ว" }
else {
  Push-Location (Join-Path $app "shell")
  cargo build --release
  Pop-Location
  if (Test-Path $exe) { Ok "คอมไพล์เสร็จ" } else { Warn "คอมไพล์ไม่สำเร็จ - เปิดเทอร์มินัลใหม่ (ให้ PATH ของ rust มา) แล้วรันสคริปต์นี้อีกครั้ง"; exit 1 }
}

# ---- 8) ผูกคำสั่ง bagidea เข้า PATH -----------------------------------------------------
Step 8 "คำสั่ง bagidea (CLI)"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$app*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$app", "User")
  Ok "เพิ่มเข้า PATH แล้ว - เปิดเทอร์มินัลใหม่แล้วใช้ได้เลย: bagidea help"
} else { Skip "อยู่ใน PATH แล้ว" }

# ---- 9) Shortcut ---------------------------------------------------------------------
Step 9 "Shortcut"
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut([IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\BagIdea Office.lnk"))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = Split-Path $exe
$lnk.Save()
Ok "สร้าง Start Menu shortcut แล้ว"

# ---- done ----------------------------------------------------------------------------
Write-Host ""
Write-Host "  =============================================" -ForegroundColor Green
Write-Host "   ติดตั้งเสร็จแล้ว!" -ForegroundColor Green
Write-Host "  =============================================" -ForegroundColor Green
Write-Host ""
Write-Host "   ครั้งแรก: เปิดเทอร์มินัลใหม่ แล้วรัน  claude  เพื่อ login Claude ก่อน" -ForegroundColor Yellow
Write-Host "   จากนั้นเปิดออฟฟิศ:  bagidea start   (หรือ Start Menu > BagIdea Office)" -ForegroundColor Cyan
Write-Host ""
$go = Read-Host "  เปิดโปรแกรมเลยไหม? (y/n)"
if ($go -eq "y") { Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) }
