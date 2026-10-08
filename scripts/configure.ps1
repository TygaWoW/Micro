
# =====================================================================
#  configure.ps1 - 飞书桥接器配置向导（WinForms 弹窗）
#  双击 配置.bat 打开，或一键安装后自动弹出。
#  字段：飞书 app_id / app_secret / 默认 chat_id / Jira PAT（可选）
#  访问控制只靠「锁定默认 chat」——同 chat 内所有人都可交互，不设白名单。
#  保存时调用 lib/write-config.ps1 写入 .env + 注册 MCP。
# =====================================================================
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 本脚本现位于 scripts/ 下，项目根需上探一层
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root      = Split-Path -Parent $ScriptDir
$EnvPath   = Join-Path $Root '.env'
$Writer    = Join-Path $Root 'lib\write-config.ps1'

# ---- 读取现有 .env 预填 ----
function Read-DotEnv($path) {
    $map = @{}
    if (Test-Path $path) {
        foreach ($raw in Get-Content $path) {
            $t = $raw.Trim()
            if (-not $t -or $t.StartsWith('#')) { continue }
            $i = $t.IndexOf('=')
            if ($i -lt 0) { continue }
            $k = $t.Substring(0, $i).Trim()
            $v = $t.Substring($i + 1).Trim()
            if ($k) { $map[$k] = [string]$v }
        }
    }
    return $map
}

$existing  = Read-DotEnv $EnvPath
$preAppId  = [string]($existing['FEISHU_APP_ID'])
$preSecret = [string]($existing['FEISHU_APP_SECRET'])
$preChatId = [string]($existing['FEISHU_CHAT_ID'])
$preJira   = [string]($existing['JIRA_PAT'])

# ---- 加载 WinForms ----
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = '飞书 ⇄ Claude 桥接器 · 配置向导'
$form.Size = New-Object System.Drawing.Size(560, 480)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false

# 布局常量（script 作用域，供辅助函数读取）
$script:padX = 20
$script:curY = 20
$script:labW = 140
$script:bkW  = 380
$script:bkH  = 26

function New-FieldLine([string]$labelStr, [string]$defVal, [bool]$isSecret) {
    $script:curY += 4

    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = $labelStr
    $lbl.Location = New-Object System.Drawing.Point($script:padX, ($script:curY + 3))
    $lbl.Size = New-Object System.Drawing.Size($script:labW, 20)
    [void]$form.Controls.Add($lbl)

    $box = New-Object System.Windows.Forms.TextBox
    $box.Location = New-Object System.Drawing.Point(($script:padX + $script:labW), $script:curY)
    $box.Size = New-Object System.Drawing.Size($script:bkW, $script:bkH)
    $box.Text = $defVal
    if ($isSecret) { $box.UseSystemPasswordChar = $true }
    [void]$form.Controls.Add($box)

    $script:curY += 34
    return $box
}

$boxAppId  = New-FieldLine '飞书 App ID：'      $preAppId  $false
$boxSecret = New-FieldLine '飞书 App Secret：'  $preSecret $true
$boxChatId = New-FieldLine '默认 Chat ID：'     $preChatId $false
$boxJira   = New-FieldLine 'Jira 秘钥(PAT)：'   $preJira   $true

# 提示文字
$hint = New-Object System.Windows.Forms.Label
$hint.Text = '默认 Chat ID：群聊填 oc_xxx，私聊填 ou_xxx。' + "`n" +
             '同 chat 内所有人都可交互，无需白名单。' + "`n" +
             'Jira 秘钥可留空，后续需 Jira MCP 访问的操作都用这个秘钥。'
$hint.Location = New-Object System.Drawing.Point($script:padX, ($script:curY + 6))
$hint.Size = New-Object System.Drawing.Size(500, 60)
$hint.ForeColor = [System.Drawing.Color]::Gray
[void]$form.Controls.Add($hint)
$script:curY += 66

# 按钮
$btnOk = New-Object System.Windows.Forms.Button
$btnOk.Text = '保存配置'
$btnOk.Location = New-Object System.Drawing.Point(($script:padX + $script:labW + $script:bkW - 185), $script:curY)
$btnOk.Size = New-Object System.Drawing.Size(90, 34)
[void]$form.Controls.Add($btnOk)

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = '取消'
$btnCancel.Location = New-Object System.Drawing.Point(($script:padX + $script:labW + $script:bkW - 85), $script:curY)
$btnCancel.Size = New-Object System.Drawing.Size(90, 34)
[void]$form.Controls.Add($btnCancel)

$form.AcceptButton = $btnOk
$form.CancelButton = $btnCancel

$btnOk.Add_Click({
    $vals = @(
        $boxAppId.Text.Trim(),
        $boxSecret.Text.Trim(),
        $boxChatId.Text.Trim(),
        $boxJira.Text.Trim()
    )

    $missingLabels = @('飞书 App ID', '飞书 App Secret', '默认 Chat ID')
    $missing = @()
    for ($i = 0; $i -lt 3; $i++) {
        if (-not $vals[$i]) { $missing += $missingLabels[$i] }
    }

    if ($missing.Count -gt 0) {
        [System.Windows.Forms.MessageBox]::Show(
            "以下必填项还未填写：`n  " + ($missing -join "`n  "),
            '提示', 'OK', 'Warning') | Out-Null
        return
    }

    $writerArgs = @(
        '-AppId', $vals[0],
        '-AppSecret', $vals[1],
        '-ChatId', $vals[2],
        '-JiraPat', $vals[3]
    )

    & powershell -NoProfile -ExecutionPolicy Bypass -File $Writer @writerArgs
    $rc = $LASTEXITCODE

    $script:form.DialogResult = 'OK'
    $script:form.Close()

    if ($rc -eq 0) {
        [System.Windows.Forms.MessageBox]::Show('配置已保存并生效。', '完成', 'OK', 'Information') | Out-Null
    } else {
        [System.Windows.Forms.MessageBox]::Show("写入配置时出错（退出码 $rc）。`n请查看终端输出。", '出错', 'OK', 'Error') | Out-Null
    }
})

$btnCancel.Add_Click({
    $script:form.DialogResult = 'Cancel'
    $script:form.Close()
})

$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
