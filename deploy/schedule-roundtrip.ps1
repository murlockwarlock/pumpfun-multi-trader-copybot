[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Mint,
    [ValidateRange(1, 1440)]
    [int]$HoldMinutes = 30,
    [string]$ServerConfigPath
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RemoteAppDir = '/opt/pr6spr-paper-copybot'
$ServiceName = 'pr6spr-paper-copybot.service'

function Read-EnvFile([string]$Path) {
    $values = @{}
    foreach ($rawLine in Get-Content -LiteralPath $Path) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { continue }
        $values[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim()
    }
    return $values
}

if ($Mint -notmatch '^[1-9A-HJ-NP-Za-km-z]{32,44}$') { throw 'Invalid Solana mint' }
if (-not $ServerConfigPath) {
    $pointer = Join-Path $PSScriptRoot 'server-config.path'
    $ServerConfigPath = (Get-Content -LiteralPath $pointer -Raw).Trim()
}
$server = Read-EnvFile $ServerConfigPath
$destination = "$($server.DEPLOY_USER)@$($server.DEPLOY_HOST)"
. (Join-Path $PSScriptRoot "ssh-common.ps1")
$sshOptions = @(Get-DeploySshOptions -Key $server.DEPLOY_KEY -Port $server.DEPLOY_PORT)
$sshArgs = $sshOptions + @($destination)
$remoteCommand = "node_path=`$(sudo readlink -f /proc/`$(systemctl show -p MainPID --value '$ServiceName')/exe) && cd '$RemoteAppDir/current' && sudo -u ubuntu env MANUAL_ORDER_DIR='$RemoteAppDir/shared/data/manual-orders' `"`$node_path`" deploy/schedule-roundtrip.mjs '$Mint' '$HoldMinutes'"
& ssh @sshArgs $remoteCommand
if ($LASTEXITCODE -ne 0) { throw 'Unable to schedule manual round-trip' }
