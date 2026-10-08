# uninstall-service.ps1 — 注销开机自启 + 停止守护 + 清理运行时状态
# 完整卸载：删计划任务、放停止标记、结束守护进程、清理锁与标记文件。
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$TaskName    = 'FeishuClaudeBridge'
$StopMarker  = Join-Path $ProjectRoot 'state\bridge.stop'
$LockFile    = Join-Path $ProjectRoot 'state\bridge.lock'

# 1) 删除计划任务
Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "已删除计划任务 '$TaskName'" -ForegroundColor Green

# 2) 放停止标记，让可能仍在跑的 watchdog 优雅退出
if (-not (Test-Path (Split-Path $StopMarker -Parent))) {
    New-Item -ItemType Directory -Path (Split-Path $StopMarker -Parent) -Force | Out-Null
}
Set-Content -Path $StopMarker -Value '' -Encoding UTF8

# 3) 结束仍存活的桥接器主进程（锁文件里记录的 PID）
if (Test-Path $LockFile) {
    try {
        $pidVal = [int](Get-Content $LockFile -Raw).Trim()
        Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
    } catch { }
}

# 4) 清理运行时文件
Remove-Item $StopMarker -Force -ErrorAction SilentlyContinue
Remove-Item $LockFile -Force -ErrorAction SilentlyContinue

Write-Host "已停止桥接器并清理运行时状态（锁文件 / 停止标记）。" -ForegroundColor Green
