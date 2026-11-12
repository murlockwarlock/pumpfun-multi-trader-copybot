[CmdletBinding()]
param(
    [string]$ServerConfigPath,
    [string]$TokenFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ServerConfigPath) {
    $ServerConfigPath = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'server-config.path') -Raw).Trim()
}
if (-not $TokenFile) { $TokenFile = Join-Path $ProjectRoot 'secrets\telegram-bot-token' }
if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) { throw 'Telegram token file is missing' }
$token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
if ($token -notmatch '^\d{8,12}:[A-Za-z0-9_-]{30,}$') { throw 'Telegram token format is invalid' }
Remove-Variable token

$server = @{}
Get-Content -LiteralPath $ServerConfigPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $key, $value = $line.Split('=', 2)
        $server[$key.Trim()] = $value.Trim().Trim('"').Trim("'")
    }
}
$destination = "$($server['DEPLOY_USER'])@$($server['DEPLOY_HOST'])"
. (Join-Path $PSScriptRoot "ssh-common.ps1")
$sshOptions = @(Get-DeploySshOptions -Key $server['DEPLOY_KEY'] -Port $server['DEPLOY_PORT'])
$sshArgs = $sshOptions + @($destination)
$scpArgs = @(Get-DeploySshOptions -Key $server['DEPLOY_KEY'] -Port $server['DEPLOY_PORT'] -Scp)
$remoteTemporary = "/tmp/pr6spr-telegram-$([guid]::NewGuid().ToString('N'))"
try {
    & scp @scpArgs $TokenFile "${destination}:$remoteTemporary"
    if ($LASTEXITCODE -ne 0) { throw 'Telegram token upload failed' }
    $remote = "sudo install -d -o ubuntu -g ubuntu -m 0700 /opt/pr6spr-paper-copybot/shared/secrets && sudo install -o ubuntu -g ubuntu -m 0600 '$remoteTemporary' /opt/pr6spr-paper-copybot/shared/secrets/telegram-bot-token"
    & ssh @sshArgs $remote
    if ($LASTEXITCODE -ne 0) { throw 'Remote Telegram token installation failed' }
    Write-Output 'telegram_token=provisioned mode=0600'
} finally {
    & ssh @sshArgs "rm -f '$remoteTemporary'" 2>$null | Out-Null
}
