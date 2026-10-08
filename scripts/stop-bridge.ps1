# stop-bridge.ps1 — 停止飞书桥
# 通过放置 state\bridge.stop 标记，让 watchdog 优雅退出，并清理残留进程。
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$StopMarker  = Join-Path $ProjectRoot 'state\bridge.stop'
$LockFile    = Join-Path $ProjectRoot 'state\bridge.lock'

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  飞书 ↔ Claude 桥接器 · 停止"          -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1) 放停止标记，让 watchdog 下一轮循环优雅退出
if (-not (Test-Path (Split-Path $StopMarker -Parent))) {
    New-Item -ItemType Directory -Path (Split-Path $StopMarker -Parent) -Force | Out-Null
}
Set-Content -Path $StopMarker -Value '' -Encoding UTF8
Write-Host "已放置停止标记 state\bridge.stop" -ForegroundColor Cyan

# 2) 若单实例锁里记录的 PID 还活着，直接结束它（不等 watchdog 下一轮）
if (Test-Path $LockFile) {
    try {
        $pidVal = [int](Get-Content $LockFile -Raw).Trim()
        $p = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
        if ($p) {
            Stop-Process -Id $pidVal -Force
            Write-Host ("已结束桥接器进程（PID {0}）" -f $pidVal) -ForegroundColor Green
        }
    } catch { }
}

# 3) 杀死 watchdog 本身——watchdog 在 backoff 期间会长时间 sleep，
#    只靠 stop 标记不一定立刻生效，直接结束 watchdog 进程最可靠。
Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*watchdog*' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        Write-Host ("已结束 watchdog 进程（PID {0}）" -f $_.ProcessId) -ForegroundColor Green
    }

# 4) 清理残留的 Claude/MCP 子进程
Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'src\\(index|claude|mcp)\\' } |
    ForEach-Object {
        Stop-Process -Id $_.Id -Force
        Write-Host ("已结束残留进程（PID {0}）" -f $_.Id) -ForegroundColor Gray
    }

Write-Host ""
Write-Host "桥接器已停止。下次启动：双击 启动桥接器.bat 或重启电脑（若注册了计划任务）。" -ForegroundColor Gray
Write-Host "按任意键关闭此窗口..." -ForegroundColor Gray
try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { }
