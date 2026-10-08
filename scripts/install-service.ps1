# install-service.ps1 — register a Windows Task Scheduler task to run the watchdog
# The watchdog handles restarts intelligently: skips launch when memory is low,
# applies exponential backoff on crash loops, and gives up after consecutive failures.

$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$PowerShell  = (Get-Command powershell.exe).Source
$Watchdog    = Join-Path $ScriptDir 'watchdog.ps1'

$TaskName = 'FeishuClaudeBridge'

$Action = New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Watchdog`"" `
    -WorkingDirectory $ProjectRoot

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Force | Out-Null

Write-Host "Task '$TaskName' registered (watchdog-managed)" -ForegroundColor Green
Write-Host "  Start:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Stop:   Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  Remove: powershell -File scripts\uninstall-service.ps1"
Write-Host "  Log:    $ProjectRoot\logs\watchdog.log"