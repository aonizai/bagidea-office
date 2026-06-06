# Live project viewer — opened by the play button while an AGENT is working
# in the project. Tails the agent's claude session (pretty-printed) so the
# owner watches the real work, and the moment the daemon reports the run
# finished, this SAME window resumes the SAME session interactively.
# One project = one window, no forked sessions.
param([string]$Dir, [string]$Proj)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host ""
Write-Host "  ================ BAGIDEA OFFICE — LIVE VIEW ================" -ForegroundColor Cyan
Write-Host "  agent กำลังทำงานในโปรเจคนี้ — นี่คืองานสดจาก session ของเขา" -ForegroundColor DarkCyan
Write-Host "  เมื่อ agent ทำเสร็จ หน้าต่างนี้จะเข้า session เดิมให้คุณคุมต่อทันที" -ForegroundColor DarkCyan
Write-Host "  =============================================================" -ForegroundColor Cyan
Write-Host ""

$lastTs = ""          # resumed runs copy history into a NEW sid file —
$positions = @{}      # timestamps dedupe across file switches.
$quietPolls = 0

while ($true) {
  $f = Get-ChildItem -Path $Dir -Filter *.jsonl -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) {
    if (-not $positions.ContainsKey($f.FullName)) { $positions[$f.FullName] = [long]0 }
    try {
      $fs = [System.IO.File]::Open($f.FullName, "Open", "Read", "ReadWrite")
      $fs.Position = $positions[$f.FullName]
      $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
      while ($null -ne ($line = $sr.ReadLine())) {
        if (-not $line.Trim()) { continue }
        try { $j = $line | ConvertFrom-Json } catch { continue }
        $ts = [string]$j.timestamp
        if ($ts -and $lastTs -and ($ts -le $lastTs)) { continue }
        if ($ts) { $lastTs = $ts }
        if ($j.type -eq "assistant" -and $j.message -and $j.message.content) {
          foreach ($b in $j.message.content) {
            if ($b.type -eq "tool_use") {
              Write-Host ("   + " + $b.name) -ForegroundColor DarkGray
            } elseif ($b.type -eq "text" -and $b.text) {
              Write-Host ""
              foreach ($tl in ($b.text -split "`n")) { Write-Host ("  " + $tl) -ForegroundColor White }
            }
          }
        }
      }
      $positions[$f.FullName] = $fs.Position
      $sr.Close(); $fs.Close()
    } catch {}
  }
  # Hand-over check: the daemon knows when the agent's run truly ends.
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:8787/projects" -TimeoutSec 4
    $me = $r.projects | Where-Object { $_.id -eq $Proj }
    if (-not $me -or -not $me.ai) {
      $quietPolls++
      if ($quietPolls -ge 2) { break }   # one grace poll: synthesis runs chain
    } else { $quietPolls = 0 }
  } catch { break }                       # daemon gone — just hand over
  Start-Sleep -Milliseconds 900
}

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Yellow
Write-Host "  agent ทำงานจบแล้ว — ส่งมือให้คุณใน session เดิม" -ForegroundColor Yellow
Write-Host "  ============================================================" -ForegroundColor Yellow
Write-Host ""

$f = Get-ChildItem -Path $Dir -Filter *.jsonl -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($f) { claude --resume $f.BaseName } else { claude }
