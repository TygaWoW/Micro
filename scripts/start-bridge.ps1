# start-bridge.ps1 — 手动启动飞书桥
# 职责：把桥接器交给 watchdog 守护，本窗口只是「一次性拉起」，关掉不影响桥继续跑。
#
# 进程归属说明（解决“进程不明确”）：
#   - 桥接器唯一由 watchdog.ps1 守护（计划任务 FeishuClaudeBridge 调用）。
#   - 本脚本 = 手动触发 watchdog 的一个入口；关掉这个 powershell 窗口，
#     watchdog 拉起的 node 进程会继续跑，不会跟着停。
#   - 想彻底停止，放一个 state\bridge.stop 文件，watchdog 会优雅退出。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$Watchdog    = Join-Path $ScriptDir 'watchdog.ps1'
$StopMarker  = Join-Path $ProjectRoot 'state\bridge.stop'
$LockFile    = Join-Path $ProjectRoot 'state\bridge.lock'

# 找出真实在跑的桥接器 node 进程（src\index.js）。不再只信 lock 文件——它可能脏，
# 或被新进程覆盖，导致去重失效。这里直接用进程命令行来判断。
function Get-RunningBridgePid {
    $proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*feishu-claude-bridge*index.js*' -or $_.CommandLine -like '*src\index.js*' } |
        Select-Object -First 1
    if ($proc) { return [int]$proc.ProcessId } else { return $null }
}

# 找出真实在跑的 watchdog 进程（避免「桥还在、watchdog 却被重复拉起」）。
function Get-RunningWatchdogPid {
    $proc = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*watchdog.ps1*' } |
        Select-Object -First 1
    if ($proc) { return [int]$proc.ProcessId } else { return $null }
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  飞书 ↔ Claude 桥接器 · 启动"          -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 清掉可能残留的停止标记（上次若手动 stop 过，这里重新启动要清除）
if (Test-Path $StopMarker) {
    Remove-Item $StopMarker -Force -ErrorAction SilentlyContinue
    Write-Host "已清除残留的停止标记，准备启动..." -ForegroundColor DarkGray
}

# 死锁清理：锁文件记录的 PID 已不存在时，视为残留，自动清除
if ((Test-Path $LockFile) -and (-not (Get-RunningBridgePid))) {
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}

# 已有守护实例在跑？直接提示，不再重复拉起
$existing = Get-RunningBridgePid
if ($existing) {
    Write-Host ("检测到桥接器已在运行（PID {0}）。" -f $existing) -ForegroundColor Green
    Write-Host "如需重启，请先运行 scripts\stop-bridge.ps1 停掉，再重新启动。" -ForegroundColor Gray
    Write-Host ""
    Write-Host "桥接器已在后台运行，本窗口可安全关闭。" -ForegroundColor Gray
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { }
    exit 0
}

Write-Host "正在通过 watchdog 拉起桥接器（后台守护）..." -ForegroundColor Cyan
Write-Host "关闭本窗口不会停止桥接器；停止请用 scripts\stop-bridge.ps1。" -ForegroundColor DarkGray
Write-Host ""

# 后台化启动 watchdog：让它脱离本窗口成为独立进程，关掉本窗口后桥+守护继续跑。
# 之前用 `& powershell -File watchdog.ps1` 前台挂载，watchdog 与本窗口同进程链，
# 窗口一关整条链被终止，桥也跟着死——就是「关窗失效」的根因。
$watchdogPid = Get-RunningWatchdogPid
if ($watchdogPid) {
    Write-Host ("检测到 watchdog 已在运行（PID {0}），不重复拉起。" -f $watchdogPid) -ForegroundColor DarkGray
} else {
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$Watchdog`"" `
        -WorkingDirectory $ProjectRoot -WindowStyle Hidden
}

Write-Host ""
Write-Host "桥接器已在后台启动，本窗口可以安全关闭。" -ForegroundColor Green
Write-Host "按任意键关闭此窗口..." -ForegroundColor Gray
try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { }
