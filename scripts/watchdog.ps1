# watchdog.ps1 — Smart guardian for Feishu-Claude bridge
# Invoked once by Task Scheduler. Handles restarts with memory checks
# and exponential backoff to avoid crash-loops from OOM kills.
# NEVER gives up — only a stop marker (state\bridge.stop) exits.

param(
    [int]$MinFreeMemoryGB = 2,
    [int]$StableThresholdSec = 60
)

$ErrorActionPreference = 'Stop'
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$NodePath    = (Get-Command node.exe).Source
$EntryPath   = Join-Path $ProjectRoot 'src\index.js'
$WatchdogLog = Join-Path $ProjectRoot 'logs\watchdog.log'
$BridgeLogDir = Join-Path $ProjectRoot 'logs'
$StopMarker  = Join-Path $ProjectRoot 'state\bridge.stop'
$RestartMarker = Join-Path $ProjectRoot 'state\bridge.restart'

function Log-Watchdog($msg) {
    $ts     = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line   = "[$ts] [watchdog] $msg"
    $parent = Split-Path $WatchdogLog -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Add-Content -Path $WatchdogLog -Value $line -Encoding UTF8
    Write-Host $line
}

function Get-FreeMemoryGB {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    if (-not $os) { return 999 }
    [math]::Round($os.FreePhysicalMemory / 1MB, 1)
}

function Log-BridgeCrashDiagnosis {
    # Pull the last 20 lines of today's bridge log for crash diagnosis
    $todayLog = Join-Path $BridgeLogDir "bridge-$((Get-Date).ToString('yyyy-MM-dd')).log"
    if (-not (Test-Path $todayLog)) {
        Log-Watchdog "no bridge log found at $todayLog — skipping diagnosis"
        return
    }
    try {
        $lines = Get-Content -Path $todayLog -Tail 20 -ErrorAction SilentlyContinue
        if ($lines) {
            Log-Watchdog "=== crash diagnosis: last 20 lines of bridge log ==="
            foreach ($line in $lines) {
                Log-Watchdog "  [bridge] $line"
            }
            Log-Watchdog "=== end diagnosis ==="
        }
    } catch {
        Log-Watchdog "failed to read bridge log for diagnosis: $_"
    }
}

Log-Watchdog "watchdog started | minFreeMem=${MinFreeMemoryGB}GB | never gives up (stop marker only)"

$crashCount = 0
$backoffMin = 0
$restartDelaySec = 5
$MAX_BACKOFF_MIN = 30  # cap at 30 minutes — never grow beyond this

while ($true) {
    # 停止标记：手动放一个 state\bridge.stop 文件即可让 watchdog 优雅退出
    if (Test-Path $StopMarker) {
        Log-Watchdog "stop marker detected — watchdog exiting"
        Remove-Item $StopMarker -Force -ErrorAction SilentlyContinue
        break
    }

    $freeGB = Get-FreeMemoryGB

    if ($freeGB -lt $MinFreeMemoryGB) {
        Log-Watchdog "SKIP — free mem ${freeGB}GB < ${MinFreeMemoryGB}GB threshold, sleeping 5min"
        Start-Sleep -Seconds 300
        continue
    }

    if ($backoffMin -gt 0) {
        Log-Watchdog "backoff: waiting ${backoffMin}min before retry (crash #${crashCount})"
        Start-Sleep -Seconds ($backoffMin * 60)
    }

    Log-Watchdog "launching bridge (crashCount=${crashCount}, backoffMin=${backoffMin}, freeMem=${freeGB}GB)"

    # 互斥兜底：若已有一个桥 node 进程在跑（比如计划任务与手动启动撞车），
    # 本轮不重复拉起，直接进入下一次循环等待。避免多实例。
    $alreadyRunning = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*src\index.js*' -or $_.CommandLine -like '*feishu-claude-bridge*index.js*' }
    if ($alreadyRunning) {
        $existingPids = ($alreadyRunning | ForEach-Object { $_.ProcessId }) -join ','
        Log-Watchdog "bridge already running (PID=$existingPids) — skip launch"
        $crashCount = 0
        $backoffMin = 0
        Start-Sleep -Seconds 5
        continue
    }

    $startedAt = Get-Date
    $proc = Start-Process -FilePath $NodePath -ArgumentList "`"$EntryPath`"" -WorkingDirectory $ProjectRoot -PassThru -NoNewWindow
    Log-Watchdog "bridge started (PID=$($proc.Id))"

    $proc.WaitForExit()
    $exitCode = $proc.ExitCode
    $runtime  = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 0)

    Log-Watchdog "bridge exited | exitCode=${exitCode} | uptimeSec=${runtime}"

    # 检测 restart 标记（来自飞书 /restart 命令）：此次退出是用户主动触发，不清除计数，立即重拉
    if (Test-Path $RestartMarker) {
        Remove-Item $RestartMarker -Force -ErrorAction SilentlyContinue
        Log-Watchdog "restart marker detected — intentional restart, skipping backoff"
        $crashCount = 0
        $backoffMin = 0
        Log-Watchdog "restarting bridge in ${restartDelaySec}s"
        Start-Sleep -Seconds $restartDelaySec
        continue
    }

    # 检测 stop 标记（来自飞书 /exit 命令）：立即退出，不等下一轮循环
    if (Test-Path $StopMarker) {
        Log-Watchdog "stop marker detected after bridge exit — watchdog exiting"
        Remove-Item $StopMarker -Force -ErrorAction SilentlyContinue
        break
    }

    # 常驻守护：无论正常退出还是异常，都重新拉起。
    # 只有上面的 stop 标记能真正让 watchdog 停止。
    # NEVER give up — exponential backoff caps at 30 minutes.
    if ($runtime -gt $StableThresholdSec) {
        # 运行足够久（>60s）说明不是瞬间崩溃：正常退出/被杀 → 清零计数，立即重启不等待
        $crashCount = 0
        $backoffMin = 0
    } else {
        # 瞬时崩溃（<60s）：诊断并累积计数，指数退避
        Log-BridgeCrashDiagnosis
        $crashCount++
        $backoffMin = [math]::Min([math]::Pow(2, [math]::Max(0, $crashCount - 1)), $MAX_BACKOFF_MIN)
    }

    # No more "FATAL: giving up" — watchdog lives forever.
    # Only the stop marker can end it.

    # 重启前短停，避免锁文件/端口未释放导致的死循环
    Log-Watchdog "restarting bridge in ${restartDelaySec}s"
    Start-Sleep -Seconds $restartDelaySec
}

Log-Watchdog "watchdog exiting"