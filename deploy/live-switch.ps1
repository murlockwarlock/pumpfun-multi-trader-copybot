[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('stop', 'resume', 'status')]
    [string]$Action,
    [string]$ServerConfigPath
)

$ErrorActionPreference = 'Stop'
if (-not $ServerConfigPath) {
    $ServerConfigPath = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'server-config.path') -Raw).Trim()
}
$server = @{}
Get-Content -LiteralPath $ServerConfigPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $key, $value = $line.Split('=', 2)
        $server[$key.Trim()] = $value.Trim().Trim('"').Trim("'")
    }
}
. (Join-Path $PSScriptRoot "ssh-common.ps1")
$sshOptions = @(Get-DeploySshOptions -Key $server['DEPLOY_KEY'] -Port $server['DEPLOY_PORT'])
$sshArgs = $sshOptions + @("$($server['DEPLOY_USER'])@$($server['DEPLOY_HOST'])")
$killFile = '/opt/pr6spr-paper-copybot/shared/data/STOP_LIVE'
$remote = switch ($Action) {
    'stop' { "sudo install -o ubuntu -g ubuntu -m 0600 /dev/null '$killFile' && echo live=stopped" }
    'resume' { "sudo rm -f -- '$killFile' && echo live=resumed" }
    'status' { "if sudo test -f '$killFile'; then echo live=stopped; else echo live=active; fi" }
}
& ssh @sshArgs $remote
if ($LASTEXITCODE -ne 0) { throw "Unable to perform live action: $Action" }
