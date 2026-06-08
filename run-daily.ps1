# run-daily.ps1 — Windows 작업 스케줄러 실행 진입점
# 직접 테스트: powershell -ExecutionPolicy Bypass -File run-daily.ps1

$projectDir = "C:\Users\R1\Desktop\Terrique_Antigravity\claude-code-blog-builder"
Set-Location $projectDir

$logDir = Join-Path $projectDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "daily-$(Get-Date -Format 'yyyy-MM-dd').log"

"[$(Get-Date -Format 'HH:mm:ss')] 테리크 블로그 자동화 시작" | Tee-Object -FilePath $logFile

node scripts/daily-runner.js 2>&1 | Tee-Object -FilePath $logFile -Append

"[$(Get-Date -Format 'HH:mm:ss')] 완료" | Tee-Object -FilePath $logFile -Append
