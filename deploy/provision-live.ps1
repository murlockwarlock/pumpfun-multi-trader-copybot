[CmdletBinding()]
param(
    [string]$ServerConfigPath,
    [string]$SecretsDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ServerConfigPath) {
    $ServerConfigPath = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'server-config.path') -Raw).Trim()
}
if (-not $SecretsDirectory) { $SecretsDirectory = Join-Path $ProjectRoot 'secrets' }
$walletFile = Join-Path $SecretsDirectory 'live-wallet.json'
$jupiterFile = Join-Path $SecretsDirectory 'jupiter-api-key'
foreach ($file in @($walletFile, $jupiterFile)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing secret file: $file" }
}

$walletBytes = Get-Content -LiteralPath $walletFile -Raw | ConvertFrom-Json
if ($walletBytes.Count -ne 64) { throw 'live-wallet.json must contain exactly 64 bytes' }
if ((Get-Item -LiteralPath $jupiterFile).Length -lt 20) { throw 'Jupiter API key file is too short' }

$server = @{}
Get-Content -LiteralPath $ServerConfigPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $key, $value = $line.Split('=', 2)
        $server[$key.Trim()] = $value.Trim().Trim('"').Trim("'")
    }
}
$destination = "$($server['DEPLOY_USER'])@$($server['DEPLOY_HOST'])"
$sshArgs = @(
    '-i', $server['DEPLOY_KEY'],
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', $server['DEPLOY_PORT'],
    $destination
)
$scpArgs = @(
    '-i', $server['DEPLOY_KEY'],
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-P', $server['DEPLOY_PORT']
)
$id = [guid]::NewGuid().ToString('N')
$remoteWallet = "/tmp/pr6spr-live-$id-wallet.json"
$remoteJupiter = "/tmp/pr6spr-live-$id-jupiter-key"
try {
    & scp @scpArgs $walletFile "${destination}:$remoteWallet"
    if ($LASTEXITCODE -ne 0) { throw 'Wallet upload failed' }
    & scp @scpArgs $jupiterFile "${destination}:$remoteJupiter"
    if ($LASTEXITCODE -ne 0) { throw 'Jupiter key upload failed' }
    $remote = "sudo install -d -o ubuntu -g ubuntu -m 0700 /opt/pr6spr-paper-copybot/shared/secrets && sudo install -o ubuntu -g ubuntu -m 0600 '$remoteWallet' /opt/pr6spr-paper-copybot/shared/secrets/live-wallet.json && sudo install -o ubuntu -g ubuntu -m 0600 '$remoteJupiter' /opt/pr6spr-paper-copybot/shared/secrets/jupiter-api-key"
    & ssh @sshArgs $remote
    if ($LASTEXITCODE -ne 0) { throw 'Remote secret installation failed' }
    Write-Output 'wallet=provisioned mode=0600'
    Write-Output 'jupiter_key=provisioned mode=0600'
} finally {
    & ssh @sshArgs "rm -f '$remoteWallet' '$remoteJupiter'" 2>$null | Out-Null
}
