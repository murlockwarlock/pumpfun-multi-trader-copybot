[CmdletBinding()]
param([string]$ServerConfigPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $ServerConfigPath) {
    $pointer = Join-Path $PSScriptRoot 'server-config.path'
    $ServerConfigPath = (Get-Content -LiteralPath $pointer -Raw).Trim()
}

$server = @{}
Get-Content -LiteralPath $ServerConfigPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $key, $value = $line.Split('=', 2)
        $server[$key.Trim()] = $value.Trim().Trim('"').Trim("'")
    }
}

$sshArgs = @(
    '-i', $server['DEPLOY_KEY'],
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', $server['DEPLOY_PORT'],
    "$($server['DEPLOY_USER'])@$($server['DEPLOY_HOST'])"
)
$archiveId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$archiveDir = "/opt/pr6spr-paper-copybot/shared/data/archive/$archiveId"
$remoteCommand = @"
sudo bash -lc 'set -euo pipefail
service=pr6spr-paper-copybot.service
data=/opt/pr6spr-paper-copybot/shared/data
archive=$archiveDir
systemctl stop "`$service"
trap "systemctl start \"`$service\" >/dev/null 2>&1 || true" ERR
mkdir -p "`$archive"
for name in paper-trades.jsonl paper-state.json; do
  if [ -f "`$data/`$name" ]; then mv -- "`$data/`$name" "`$archive/`$name"; fi
done
systemctl start "`$service"
trap - ERR
systemctl is-active --quiet "`$service"
echo "archive=`$archive"
if [ -f "`$data/paper-trades.jsonl" ]; then
  echo "paper_records=`$(wc -l < "`$data/paper-trades.jsonl")"
else
  echo "paper_records=0"
fi
echo "ingestion_state=preserved"'
"@

& ssh @sshArgs $remoteCommand
if ($LASTEXITCODE -ne 0) { throw 'Remote paper reset failed.' }
