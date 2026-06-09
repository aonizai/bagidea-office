# BagIdea Office - one-shot open-source installer (Windows 11).
#
# Installs EVERYTHING needed on a bare machine and leaves you ready to run:
#   Git · Node LTS · Rust · the MSVC C++ Build Tools (the Rust linker) ·
#   Godot 4.6.3 · the Claude Code CLI. Then it clones the repo, builds the Rust
#   shell, brands the window icon, wires the `bagidea` command onto your PATH and
#   drops a Start Menu shortcut. Safe to re-run - every step skips what's done and
#   a re-run does a `git pull` (your data is preserved).
#
#   irm https://raw.githubusercontent.com/bagidea/bagidea-office/main/installer/install.ps1 | iex
#
# Options (env or params):
#   -Repo   <url>     source repo            (default: the public BagIdea Office)
#   -Branch <name>    branch to install      (default: main)
#   -SkipBuildTools   don't auto-install the Visual Studio C++ Build Tools
param(
  [string]$Repo   = $(if ($env:BAGIDEA_REPO)   { $env:BAGIDEA_REPO }   else { "https://github.com/bagidea/bagidea-office.git" }),
  [string]$Branch = $(if ($env:BAGIDEA_BRANCH) { $env:BAGIDEA_BRANCH } else { "main" }),
  # Optional art pack (characters + 3D models + sounds). The licensed packs are
  # NOT in the public repo, so the office falls back to procedural visuals. Point
  # -Assets at YOUR own zip/folder (or set $env:BAGIDEA_ASSETS_URL to a URL you
  # host) and the installer drops them into godot/assets so it looks complete.
  [string]$Assets = $env:BAGIDEA_ASSETS_URL,
  [switch]$SkipBuildTools
)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$APPDIR = Join-Path $env:LOCALAPPDATA "BagIdeaOffice"
$APP    = Join-Path $APPDIR "app"
$GODOTV = "4.6.3"

function Step($n, $m) { Write-Host ""; Write-Host "  [$n] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "      + $m" -ForegroundColor Green }
function Skip($m) { Write-Host "      - $m" -ForegroundColor DarkGray }
function Warn($m) { Write-Host "      ! $m" -ForegroundColor Yellow }
function Have($c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

# Pull freshly-installed tools onto THIS session's PATH (winget updates the
# registry, not the running shell) so git/node/cargo are usable right away.
function Sync-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user    = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($machine, $user) | Where-Object { $_ }
  $cargo = Join-Path $env:USERPROFILE ".cargo\bin"
  if (Test-Path $cargo) { $parts += $cargo }
  $npm = Join-Path $env:APPDATA "npm"
  if (Test-Path $npm) { $parts += $npm }
  $env:Path = ($parts -join ";")
}

Write-Host ""
Write-Host "  ===========================================" -ForegroundColor Cyan
Write-Host "   BagIdea Office - INSTALLER (open source)" -ForegroundColor Cyan
Write-Host "  ===========================================" -ForegroundColor Cyan

if (-not (Have "winget")) {
  Warn "winget not found. Install 'App Installer' from the Microsoft Store, then re-run."
  Warn "Store link: https://apps.microsoft.com/detail/9nblggh4nns1"
  exit 1
}
# NOTE: do NOT name this "Winget" — PowerShell command names are case-insensitive,
# so a function "Winget" shadows winget.exe and `winget install` inside it would
# call the function again forever (CallDepthOverflow). Call the .exe explicitly.
function WingetInstall($id) {
  winget.exe install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Sync-Path
}

# ---- dependencies ------------------------------------------------------------
Step 1 "Git"
if (Have "git") { Skip "already installed ($((git --version)))" }
else { WingetInstall "Git.Git"; if (Have "git") { Ok "installed" } else { Warn "installed - reopen a terminal if 'git' isn't found" } }

Step 2 "Node.js LTS"
if (Have "node") { Skip "already installed ($(node --version))" }
else { WingetInstall "OpenJS.NodeJS.LTS"; if (Have "node") { Ok "installed" } else { Warn "installed - reopen a terminal if 'node' isn't found" } }

Step 3 "Rust toolchain (compiles the desktop shell)"
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
if (Have "cargo") { $cargo = "cargo"; Skip "already installed ($(cargo --version))" }
elseif (Test-Path $cargo) { Skip "already installed" }
else {
  WingetInstall "Rustlang.Rustup"
  $rustup = Join-Path $env:USERPROFILE ".cargo\bin\rustup.exe"
  if (Test-Path $rustup) { & $rustup default stable-x86_64-pc-windows-msvc 2>$null | Out-Null; Ok "installed" }
  else { Warn "Rustup may need a new terminal - re-run this script if the build fails" }
}
Sync-Path

# ---- the C++ build tools Rust needs to LINK (the usual bare-machine blocker) --
Step 4 "Visual Studio C++ Build Tools (Rust linker + Windows SDK)"
function Have-MSVC {
  $vsw = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vsw) {
    $p = & $vsw -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($p) { return $true }
  }
  return [bool](Get-ChildItem "C:\Program Files*\Microsoft Visual Studio\*\*\VC\Tools\MSVC" -Directory -ErrorAction SilentlyContinue)
}
if (Have-MSVC) { Skip "C++ build tools already present" }
elseif ($SkipBuildTools) { Warn "skipped (-SkipBuildTools) - the build will fail without a C++ linker" }
else {
  Warn "Not found. Installing the C++ workload (large download ~2-4 GB, one time)..."
  winget.exe install --id Microsoft.VisualStudio.2022.BuildTools -e --silent `
    --accept-package-agreements --accept-source-agreements `
    --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" | Out-Null
  if (Have-MSVC) { Ok "C++ build tools installed" }
  else { Warn "could not confirm the build tools - if the build fails, install 'Desktop development with C++' from the Visual Studio Installer" }
}

Step 5 "Godot $GODOTV (renders the office world)"
$gdir = Join-Path $APPDIR "tools\godot"
$gexe = Join-Path $gdir "Godot_v$GODOTV-stable_win64.exe"
if (Test-Path $gexe) { Skip "already installed" }
else {
  New-Item -ItemType Directory -Force $gdir | Out-Null
  $z = Join-Path $env:TEMP "godot.zip"
  try {
    Invoke-WebRequest -Uri "https://github.com/godotengine/godot/releases/download/$GODOTV-stable/Godot_v$GODOTV-stable_win64.exe.zip" -OutFile $z
    Expand-Archive -Path $z -DestinationPath $gdir -Force; Remove-Item $z -ErrorAction SilentlyContinue
    if (Test-Path $gexe) { Ok "installed" } else { Warn "extracted but exe not found" }
  } catch { Warn "download failed - check your connection and re-run" }
}
[Environment]::SetEnvironmentVariable("BAGIDEA_GODOT", $gexe, "User")
$env:BAGIDEA_GODOT = $gexe

Step 6 "Claude Code CLI (the brain of every agent)"
if (Have "claude") { Skip "already installed" }
elseif (Have "npm") { npm install -g @anthropic-ai/claude-code | Out-Null; Sync-Path; Ok "installed - log in later by running: claude" }
else { Warn "npm not on PATH yet - reopen a terminal and run: npm install -g @anthropic-ai/claude-code" }

# ---- the app: clone (or pull) ------------------------------------------------
Step 7 "Get the app -> $APP"
if (-not (Have "git")) { Warn "git not on PATH yet - reopen a terminal and re-run this script"; exit 1 }
New-Item -ItemType Directory -Force $APPDIR | Out-Null
if (Test-Path (Join-Path $APP ".git")) {
  Push-Location $APP
  git fetch --depth 1 origin $Branch 2>$null
  git reset --hard "origin/$Branch" 2>$null
  Pop-Location
  Ok "updated existing clone (git pull) - your data is untouched"
} elseif (Test-Path $APP) {
  $backup = Join-Path $env:TEMP "bagidea_userdata"
  if (Test-Path $backup) { Remove-Item -Recurse -Force $backup }
  New-Item -ItemType Directory -Force $backup | Out-Null
  foreach ($f in @("registry.json","sessions.json","projects.json","jobs.json",
      "calendar.json","notes.json","layout.json","stats.json","proposals.json")) {
    $p = Join-Path $APP "daemon\$f"; if (Test-Path $p) { Copy-Item $p (Join-Path $backup $f) -Force }
  }
  if (Test-Path (Join-Path $APP "daemon\i18n")) { Copy-Item (Join-Path $APP "daemon\i18n") (Join-Path $backup "i18n") -Recurse -Force }
  Remove-Item -Recurse -Force $APP
  git clone --depth 1 --branch $Branch $Repo $APP
  Get-ChildItem $backup -File | ForEach-Object { Copy-Item $_.FullName (Join-Path $APP ("daemon\" + $_.Name)) -Force }
  if (Test-Path (Join-Path $backup "i18n")) { Copy-Item (Join-Path $backup "i18n") (Join-Path $APP "daemon\i18n") -Recurse -Force }
  Ok "cloned + restored your previous data"
} else {
  git clone --depth 1 --branch $Branch $Repo $APP
  Ok "cloned to $APP"
}

# ---- optional art pack (licensed packs are NOT in the public repo) -----------
Step "7b" "Art assets (characters / 3D models / sounds)"
$assetDir = Join-Path $APP "godot\assets"
if ($Assets) {
  try {
    $srcZip = $Assets
    if ($Assets -match "^https?://") {
      $srcZip = Join-Path $env:TEMP "bagidea-assets.zip"
      Warn "downloading art pack..."
      Invoke-WebRequest -Uri $Assets -OutFile $srcZip
    }
    if (Test-Path $srcZip -PathType Container) {
      Copy-Item (Join-Path $srcZip "*") $assetDir -Recurse -Force
      Ok "copied art pack into godot\assets"
    } elseif (Test-Path $srcZip) {
      Expand-Archive -Path $srcZip -DestinationPath $assetDir -Force
      Ok "art pack installed into godot\assets"
    } else {
      Warn "art pack not found: $Assets (skipping; procedural visuals)"
    }
  } catch {
    Warn "art pack step failed (skipping; procedural visuals)"
  }
} elseif (Test-Path (Join-Path $assetDir "characters")) {
  Skip "art assets are bundled with the install"
} else {
  Skip "no art assets found; using built-in procedural visuals"
}

# ---- build the Rust shell ----------------------------------------------------
Step 8 "Build the desktop shell (first build can take a few minutes)"
$exe = Join-Path $APP "shell\target\release\bagidea-office-shell.exe"
if (Have "cargo") { $cargo = "cargo" }
Push-Location (Join-Path $APP "shell")
& $cargo build --release
Pop-Location
if (Test-Path $exe) { Ok "built -> $exe" }
else {
  Warn "BUILD FAILED. Most often this means the C++ linker is missing."
  Warn "Fix it, then re-run this script:"
  Warn "  winget install Microsoft.VisualStudio.2022.BuildTools --override `"--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`""
  Warn "  (or open the Visual Studio Installer and add 'Desktop development with C++')"
  Warn "Then reopen a terminal and run this installer again."
}

# ---- branded window/taskbar icon (BAG IDEA, never a Godot icon) --------------
Step 9 "Brand the window icon"
$bindir  = Join-Path $APP "godot\bin"
$branded = Join-Path $bindir "BagIdeaOffice.exe"
$ico     = Join-Path $APP "godot\assets\brand\logo.ico"
if ((Test-Path $gexe) -and (Test-Path $ico)) {
  New-Item -ItemType Directory -Force $bindir | Out-Null
  $rcedit = Join-Path $env:TEMP "rcedit-x64.exe"
  if (-not (Test-Path $rcedit)) {
    try { Invoke-WebRequest -Uri "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe" -OutFile $rcedit } catch {}
  }
  Copy-Item $gexe $branded -Force
  if (Test-Path $rcedit) {
    & $rcedit $branded --set-icon $ico --set-version-string "FileDescription" "BagIdea Office" --set-version-string "ProductName" "BagIdea Office" 2>$null
    Ok "branded exe ready - the taskbar shows BAG IDEA from launch"
  } else { Warn "couldn't fetch rcedit - the default Godot icon will be used" }
} else { Skip "skipped (Godot or logo.ico missing)" }

# ---- hook paths: the permission/notify hooks use absolute paths --------------
Step 10 "Point the Claude hooks at this install"
foreach ($cfg in @("$APP\.claude\settings.json", "$APP\workspace\.claude\settings.json")) {
  if (Test-Path $cfg) {
    $txt = Get-Content $cfg -Raw
    $txt = [regex]::Replace($txt, '"command":\s*"[^"]*?([\w-]+\.ps1)"', { param($m)
      '"command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"' +
      ($APP -replace '\\','\\') + '\\daemon\\' + $m.Groups[1].Value + '\""' })
    Set-Content $cfg $txt -Encoding utf8
  }
}
Ok "hooks now resolve to the install path"

# ---- CLI on PATH + Start Menu shortcut ---------------------------------------
Step 11 "Add 'bagidea' to PATH + Start Menu shortcut"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$APP*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$APP", "User"); Ok "added bagidea to PATH (open a new terminal to use it)" }
else { Skip "already on PATH" }
if (Test-Path $exe) {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut([IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\BagIdea Office.lnk"))
  $lnk.TargetPath = $exe; $lnk.WorkingDirectory = Split-Path $exe; $lnk.Save()
  Ok "created Start Menu shortcut"
}

# ---- summary -----------------------------------------------------------------
Write-Host ""
if (Test-Path $exe) {
  Write-Host "  =============================================" -ForegroundColor Green
  Write-Host "   Done - BagIdea Office is installed!" -ForegroundColor Green
  Write-Host "  =============================================" -ForegroundColor Green
  Write-Host "   1) Open a NEW terminal and run:  claude   (log in to Claude, first time only)" -ForegroundColor Yellow
  Write-Host "   2) Then:  bagidea start   (or Start Menu > BagIdea Office)" -ForegroundColor Cyan
  Write-Host ""
  $go = Read-Host "  Launch it now? (y/n)"
  if ($go -eq "y") { Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) }
} else {
  Write-Host "  =============================================" -ForegroundColor Yellow
  Write-Host "   Almost there - the shell wasn't built yet." -ForegroundColor Yellow
  Write-Host "  =============================================" -ForegroundColor Yellow
  Write-Host "   See the build hint above (usually the C++ Build Tools)," -ForegroundColor Yellow
  Write-Host "   then open a NEW terminal and run this installer again." -ForegroundColor Yellow
  Write-Host "   Full guide + fixes: https://bagidea.github.io/bagidea-office/docs.html#install-win" -ForegroundColor Cyan
}
Write-Host ""
