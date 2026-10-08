# =====================================================================
#  setup.ps1 - install step 2: npm install + register autostart
#  Config (env / mcp) is handled by the config wizard (configure.ps1),
#  which calls lib\write-config.ps1. This script only installs deps and
#  registers the scheduled task. Run AFTER the config wizard.
# =====================================================================
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 本脚本现位于 scripts/ 下，项目根需上探一层
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root      = Split-Path -Parent $ScriptDir

# ---------- 1) npm install ----------
Write-Host "[1/2] 安装 npm 依赖..."
Push-Location $Root
npm install --omit=dev 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "        npm install 失败，请检查网络后手动执行 npm install" -ForegroundColor Yellow
} else {
    Write-Host "        npm 依赖安装完成" -ForegroundColor Green
}
Pop-Location

# ---------- 2) register scheduled task (autostart) ----------
Write-Host "[2/2] 注册 Windows 计划任务（开机自启）..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'install-service.ps1')

Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host "  立即启动：双击 启动桥接器.bat"
Write-Host "  （或重启电脑，计划任务会自动启动桥接器）"
Write-Host "  修改配置：双击 一键配置.bat"
Write-Host ""
Write-Host "记得在飞书开放平台完成 5 件事：开启 Bot 能力、切长连接、"
Write-Host "订阅 im.message.receive_v1、开权限、发布版本。" -ForegroundColor Cyan
