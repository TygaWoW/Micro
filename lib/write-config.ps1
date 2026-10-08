# =====================================================================
#  lib/write-config.ps1 - single source of truth for writing config
#  setup.ps1 and configure.ps1 both call this, so logic never drifts.
#
#  Params (all optional):
#    -AppId, -AppSecret, -ChatId, -JiraBaseUrl, -JiraPat,
#    -ApiBaseUrl, -AuthToken, -Model, -ClaudeBin, -PermissionMode, -ClaudeCwd
#
#  Behavior:
#    1) validate required (AppId / AppSecret / ChatId)
#    2) write root .env (bridge + feishu MCP read it)
#    3) write Claude Code settings.json (ANTHROPIC gateway env, optional)
#    4) register mcpServers (feishu + jira) via claude mcp add, creds in env
# =====================================================================
[CmdletBinding()]
param(
    [string]$AppId = '',
    [string]$AppSecret = '',
    [string]$ChatId = '',
    [string]$JiraBaseUrl = 'https://jira.boomingtechs.cn',
    [string]$JiraPat = '',
    [string]$ApiBaseUrl = '',
    [string]$AuthToken = '',
    [string]$Model = '',
    [string]$ClaudeBin = '',
    [string]$PermissionMode = 'bypassPermissions',
    [string]$ClaudeCwd = '',
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Root     = Split-Path -Parent $PSScriptRoot
$HomePath = $env:USERPROFILE

function Write-Info($msg, $color = 'White') {
    if (-not $Silent) { Write-Host $msg -ForegroundColor $color }
}

# ---------- 1) validate required ----------
$missing = @()
if (-not $AppId)     { $missing += 'feishu.app_id' }
if (-not $AppSecret) { $missing += 'feishu.app_secret' }
if (-not $ChatId)    { $missing += 'default_chat_id' }

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "[错误] 缺少必填配置项：" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "   - $_" -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "请通过 配置.bat 弹窗补全。" -ForegroundColor Cyan
    exit 1
}

# ---------- 2) 自动探测 claude.exe 真实路径 ----------
# 同事电脑上 Claude Code 装法不一，依次探测常见位置，命中即用：
#   1) 用户显式传入的 -ClaudeBin
#   2) npm 全局安装（最常见）：%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
#   3) 官方安装器：%USERPROFILE%\.local\bin\claude.exe
#   4) PATH 里的 claude 命令（Get-Command claude）
function Resolve-ClaudeBin {
    param([string]$explicit)

    # 1) 显式传入且存在
    if ($explicit -and (Test-Path $explicit)) { return $explicit }

    # 2) npm 全局
    $npmGlobal = Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
    if (Test-Path $npmGlobal) { return $npmGlobal }

    # 3) 官方安装器
    $official = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path $official) { return $official }

    # 4) PATH 上的 claude 命令（解析到 exe）
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) {
        # 可能是 .exe 或 .ps1/.cmd shim，只认 .exe 或能定位到真实 exe 的
        if ($cmd.Source -like '*.exe') { return $cmd.Source }
        # 对 npm .cmd shim，回退到 npm 同目录的 node_modules 里的 exe（通常已覆盖）
        $shimDir = Split-Path -Parent $cmd.Source
        $candidate = Join-Path $shimDir 'node_modules\@anthropic-ai\claude-code\bin\claude.exe'
        if (Test-Path $candidate) { return $candidate }
    }

    # 都不命中 —— 返回空，由调用方提示
    return ''
}

$resolvedBin = Resolve-ClaudeBin $ClaudeBin
if ($resolvedBin) {
    $ClaudeBin = $resolvedBin
    Write-Info "[探测] claude.exe → $ClaudeBin" DarkGray
} else {
    # 探测不到时，保留原值（可能为空），仅提示
    Write-Info "[警告] 未找到 claude.exe，请先安装 Claude Code 或手动指定路径。" Yellow
}

if (-not $ClaudeCwd) { $ClaudeCwd = $HomePath }

Write-Info "======================================================" Cyan
Write-Info "  飞书 ⇄ Claude 桥接器 · 写入配置" Cyan
Write-Info "======================================================" Cyan
Write-Info "  App ID     : $AppId"
Write-Info "  默认 chat  : $ChatId"
Write-Info "  Jira 秘钥  : $(if ($JiraPat) { '已配置' } else { '未配置' })"
Write-Info "  Claude     : $ClaudeBin"
Write-Info ""

# ---------- 3) write .env ----------
$envContent = @"
# Feishu app credentials
FEISHU_APP_ID=$AppId
FEISHU_APP_SECRET=$AppSecret

# Default chat (required; bridge only talks in this chat)
FEISHU_CHAT_ID=$ChatId

# Jira credentials (optional; all Jira MCP calls use this PAT)
JIRA_BASE_URL=$JiraBaseUrl
JIRA_PAT=$JiraPat

# Claude Code
CLAUDE_BIN=$ClaudeBin
CLAUDE_PERMISSION_MODE=$PermissionMode
CLAUDE_CWD=$ClaudeCwd

# Queue
MAX_CONCURRENT_CLAUDE=2
SOFT_TIMEOUT_MS=300000
HARD_TIMEOUT_MS=900000

# Logging
LOG_LEVEL=info
LOG_RETENTION_DAYS=14

# Session pruning
SESSION_PRUNE_DAYS=30
"@
Set-Content -Path (Join-Path $Root '.env') -Value $envContent -Encoding UTF8
Write-Info "[1/4] .env 已生成" Green

# ---------- 4) write Claude Code settings.json (API gateway env, optional) ----------
if ($ApiBaseUrl -or $AuthToken -or $Model) {
    $settingsPath = Join-Path $HomePath '.claude\settings.json'
    $settingsDir  = Join-Path $HomePath '.claude'
    if (-not (Test-Path $settingsDir)) { New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null }

    $settings = @{}
    if (Test-Path $settingsPath) {
        $existing = Get-Content -Raw $settingsPath | ConvertFrom-Json
        foreach ($prop in $existing.PSObject.Properties) { $settings[$prop.Name] = $prop.Value }
    }

    $envBlock = @{}
    if ($ApiBaseUrl) { $envBlock['ANTHROPIC_BASE_URL'] = $ApiBaseUrl }
    if ($AuthToken)  { $envBlock['ANTHROPIC_AUTH_TOKEN'] = $AuthToken }
    if ($Model)      { $settings['model'] = $Model }

    if ($envBlock.Count -gt 0) { $settings['env'] = $envBlock }

    ($settings | ConvertTo-Json -Depth 10) | Set-Content -Path $settingsPath -Encoding UTF8
    Write-Info "[2/4] Claude Code settings.json 已写入 API 环境" Green
} else {
    Write-Info "[2/4] 跳过 — 未配置 Claude API（使用官方订阅）" DarkGray
}

# ---------- 5) register MCP via official claude mcp add ----------
# Key point: inject bot credentials into the MCP subprocess env.
# Claude Code launches MCP with an unpredictable cwd; without injection it can't
# read .env and falls back to identity-less calls -> "permission denied".
# Locate real claude.exe (bypass npm .ps1 shim, which corrupts args / CJK paths)
$claudeMcp = ''
$npmExe    = Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
if (Test-Path $npmExe) {
    $claudeMcp = $npmExe
} else {
    $c = Get-Command claude -ErrorAction SilentlyContinue
    if ($c -and ($c.Source -like '*.exe')) { $claudeMcp = $c.Source }
}
if (-not $claudeMcp) { $claudeMcp = Join-Path $HomePath '.local\bin\claude.exe' }

function Register-Mcp($name, $serverJs, $envPairs) {
    # Idempotent: remove old first (ignore "not found"), then add.
    # Use a child scope with $ErrorActionPreference='Continue' so claude.exe's
    # non-zero exit / stderr (e.g. "No MCP server named X") does not throw under Stop.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $claudeMcp mcp remove $name 2>&1 | Out-Null

        $envArgs = @()
        foreach ($k in $envPairs.Keys) {
            $envArgs += '-e'
            $envArgs += ("{0}={1}" -f $k, $envPairs[$k])
        }

        & $claudeMcp mcp add -s user $name @envArgs -- node $serverJs 2>&1 | Out-Null
        $rc = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    return $rc
}

$feishuServer = Join-Path $Root 'src\mcp\server.js'
$jiraServer   = Join-Path $Root 'src\mcp\jira\server.js'

$feishuEnv = [ordered]@{
    FEISHU_APP_ID     = $AppId
    FEISHU_APP_SECRET = $AppSecret
    FEISHU_CHAT_ID    = $ChatId
}
$jiraEnv = [ordered]@{
    JIRA_PAT      = $JiraPat
    JIRA_BASE_URL = $JiraBaseUrl
}

$rcFeishu = Register-Mcp 'feishu' $feishuServer $feishuEnv
$rcJira   = Register-Mcp 'jira'   $jiraServer   $jiraEnv

if ($rcFeishu -eq 0 -and $rcJira -eq 0) {
    Write-Info "[3/4] MCP 已注册（feishu + jira，用户级作用域）" Green
} else {
    Write-Info "[3/4] 警告：claude mcp add 返回非零码（feishu=$rcFeishu, jira=$rcJira）" Yellow
    Write-Info "      请确认已安装 Claude Code，或手动执行 claude mcp add。" Yellow
}

# Legacy note: old Claude Code stored mcpServers in ~/.claude.json; current uses claude mcp.
$claudeJsonPath = Join-Path $HomePath '.claude.json'
if (Test-Path $claudeJsonPath) {
    try {
        $raw = [System.IO.File]::ReadAllText($claudeJsonPath)
        if ($raw -match '"mcpServers"') {
            Write-Info "      （检测到旧式 ~/.claude.json 的 mcpServers，可忽略——现版本已迁移到 claude mcp）" DarkGray
        }
    } catch { }
}

Write-Info "[4/4] 配置写入完成" Green
Write-Info ""
