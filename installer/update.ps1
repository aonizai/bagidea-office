# BagIdea Office updater.
#   .git present  -> git pull + rebuild the shell only if shell/ changed
#   no .git        -> hand off to install.ps1 (fresh clone, data preserved)
# Run via:  bagidea update  |  the in-app refresh button  |  directly.
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host ""
Write-Host "  ===== BagIdea Office - UPDATE =====" -ForegroundColor Cyan

# 1) Stop the running suite (shell + wallpaper + daemon).
#    IMPORTANT: the wallpaper exe is the BRANDED "BagIdeaOffice.exe" (rcedit
#    copy of Godot), NOT "Godot*". Missing it left the wallpaper running while
#    the shell died — the UI vanished and the update looked stuck. Match all.
Write-Host "  [1/4] Stopping the app..." -ForegroundColor DarkCyan
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq "node.exe" -and $_.CommandLine -match "server\.js") -or
  $_.Name -eq "bagidea-office-shell.exe" -or
  $_.Name -eq "BagIdeaOffice.exe" -or
  $_.Name -like "Godot*"
} | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }
Start-Sleep 2

# No git checkout: hand off to the installer (it clones + preserves data).
if (-not (Test-Path (Join-Path $root ".git"))) {
  Write-Host "  [2/2] Not a git checkout - running the installer..." -ForegroundColor DarkCyan
  & (Join-Path $PSScriptRoot "install.ps1")
  exit 0
}

# 2) Pull the latest code.
Write-Host "  [2/4] Pulling latest code..." -ForegroundColor DarkCyan
$before = git rev-parse HEAD
git pull --ff-only
$after = git rev-parse HEAD
if ($before -eq $after) { Write-Host "  - Already up to date" -ForegroundColor DarkGray }

# 3) Rebuild the shell only when its source changed (and cargo exists).
$shellChanged = git diff --name-only $before $after -- shell/ | Measure-Object -Line
if ($shellChanged.Lines -gt 0) {
  $cargo = Get-Command cargo -ErrorAction SilentlyContinue
  if (-not $cargo) {
    $cb = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
    if (Test-Path $cb) { $cargo = $cb }
  }
  if ($cargo) {
    Write-Host "  [3/4] Rebuilding the shell (shell/ changed)..." -ForegroundColor DarkCyan
    Push-Location (Join-Path $root "shell")
    & $(if ($cargo -is [string]) { $cargo } else { $cargo.Source }) build --release
    Pop-Location
  } else {
    Write-Host "  [3/4] ! shell/ changed but no Rust toolchain - keeping the current exe" -ForegroundColor Yellow
    Write-Host "        Install:  winget install Rustlang.Rustup  then run 'bagidea update' again" -ForegroundColor Yellow
  }
} else {
  Write-Host "  [3/4] shell unchanged - skipping the build" -ForegroundColor DarkGray
}

# 3b) One-time: enable launch-with-Windows for users from before it became the install
#     default (the reported "didn't come back after a reboot" case). Guarded by a marker
#     so we set it ONCE and never re-enable after someone deliberately turns it off.
$flagDir = Join-Path $env:LOCALAPPDATA "BagIdeaOffice"
$flag = Join-Path $flagDir "startup-default.applied"
if (-not (Test-Path $flag)) {
  $runKey = "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
  reg query $runKey /v BagIdeaOffice 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $shexe = Join-Path $root "shell\target\release\bagidea-office-shell.exe"
    if (Test-Path $shexe) {
      reg add $runKey /v BagIdeaOffice /t REG_SZ /d "$shexe" /f | Out-Null
      Write-Host "  [+] Enabled launch-with-Windows (one-time default - bagidea startup off to undo)" -ForegroundColor DarkCyan
    }
  }
  New-Item -ItemType Directory -Force $flagDir | Out-Null
  New-Item -ItemType File -Force $flag | Out-Null
}

# 4) Relaunch.
Write-Host "  [4/4] Relaunching..." -ForegroundColor DarkCyan
$exe = Join-Path $root "shell\target\release\bagidea-office-shell.exe"
if (Test-Path $exe) {
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
  Write-Host ""
  Write-Host "  Updated -> $(git rev-parse --short HEAD)" -ForegroundColor Green
} else {
  Write-Host "  ! shell exe not found - run 'cargo build --release' in shell/ first" -ForegroundColor Red
}
