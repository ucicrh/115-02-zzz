# 公共電腦下課清理腳本：清除瀏覽器登入狀態、VS Code / Git / CLI 工具的帳號憑證
# 用法（PowerShell）：
#   .\logout-cleanup.ps1 -WhatIf     先預覽會刪什麼，不會真的刪
#   .\logout-cleanup.ps1             正式執行（會先詢問確認）
[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'SilentlyContinue'

function Remove-Target($path) {
    if (Test-Path $path) {
        if ($PSCmdlet.ShouldProcess($path, '刪除')) {
            Remove-Item $path -Recurse -Force
            Write-Host "已刪除: $path"
        }
    }
}

if (-not $WhatIfPreference) {
    $ans = Read-Host '將關閉瀏覽器與 VS Code 並刪除登入資料，確定嗎？(y/N)'
    if ($ans -ne 'y') { Write-Host '已取消'; return }
}

# 1. 先關閉程式，否則資料庫檔案被鎖定刪不掉
if ($PSCmdlet.ShouldProcess('chrome, msedge, firefox, Code', '結束程序')) {
    'chrome', 'msedge', 'firefox', 'Code' | ForEach-Object { Stop-Process -Name $_ -Force }
    Start-Sleep -Seconds 2
}

# 2. Chromium 系瀏覽器（Chrome、Edge）：所有設定檔裡的 cookie、密碼、網站儲存
$chromiumItems = 'Cookies', 'Network\Cookies', 'Login Data', 'Login Data For Account',
'Web Data', 'History', 'Local Storage', 'Session Storage', 'Sessions',
'IndexedDB', 'Service Worker'
$chromiumRoots = "$env:LOCALAPPDATA\Google\Chrome\User Data", "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
foreach ($root in $chromiumRoots) {
    Get-ChildItem $root -Directory | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' } | ForEach-Object {
        foreach ($item in $chromiumItems) { Remove-Target (Join-Path $_.FullName $item) }
    }
}

# 3. Firefox
Get-ChildItem "$env:APPDATA\Mozilla\Firefox\Profiles" -Directory | ForEach-Object {
    'cookies.sqlite', 'logins.json', 'key4.db', 'webappsstore.sqlite', 'storage', 'places.sqlite' |
    ForEach-Object { Remove-Target (Join-Path $_.FullName $_) }
}

# 4. VS Code：登入的 GitHub 等帳號存在 state.vscdb 與 Network 內
$code = "$env:APPDATA\Code"
Remove-Target "$code\User\globalStorage\state.vscdb"
Remove-Target "$code\User\globalStorage\state.vscdb.backup"
Remove-Target "$code\Network"
Remove-Target "$code\Local Storage"
Remove-Target "$code\Session Storage"

# 5. Windows 認證管理員：只刪 Git / GitHub / VS Code / Claude / Gemini 相關項目
$pattern = 'git:|github|vscode|claude|gemini|anthropic'
cmdkey /list | Select-String 'Target:\s*(.+)$' | ForEach-Object {
    $target = $_.Matches[0].Groups[1].Value.Trim()
    if ($target -match $pattern) {
        if ($PSCmdlet.ShouldProcess($target, '刪除認證')) {
            cmdkey /delete:$target | Out-Null
            Write-Host "已刪除認證: $target"
        }
    }
}

# 6. 命令列工具的登入檔
Remove-Target "$env:USERPROFILE\.git-credentials"
Remove-Target "$env:USERPROFILE\.config\gh\hosts.yml"
Remove-Target "$env:APPDATA\GitHub CLI\hosts.yml"
Remove-Target "$env:USERPROFILE\.claude\.credentials.json"
Remove-Target "$env:USERPROFILE\.gemini\oauth_creds.json"

Write-Host "`n完成。建議再重新開機一次，並到各服務的帳號頁面確認沒有殘留的登入裝置。"
