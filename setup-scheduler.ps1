# setup-scheduler.ps1 — 작업 스케줄러 등록 (관리자 권한 필요)
# 실행 방법: 터미널에서 ! powershell -ExecutionPolicy Bypass -File setup-scheduler.ps1

$projectDir = "C:\Users\R1\Desktop\Terrique_Antigravity\claude-code-blog-builder"
$scriptPath = Join-Path $projectDir "run-daily.ps1"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`"" `
  -WorkingDirectory $projectDir

$trigger = New-ScheduledTaskTrigger -Daily -At "09:00"

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName "TerriqueBlogDaily" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Force

Write-Host ""
Write-Host "✅ 등록 완료 — 매일 오전 09:00 자동 실행" -ForegroundColor Green
Write-Host ""
Write-Host "확인:      Get-ScheduledTask -TaskName 'TerriqueBlogDaily'"
Write-Host "지금 테스트: Start-ScheduledTask -TaskName 'TerriqueBlogDaily'"
Write-Host "삭제:      Unregister-ScheduledTask -TaskName 'TerriqueBlogDaily'"
