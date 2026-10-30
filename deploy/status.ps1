[CmdletBinding()]
param([string]$ServerConfigPath)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
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
$sshArgs = @(
    '-i', $server['DEPLOY_KEY'],
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', $server['DEPLOY_PORT'],
    "$($server['DEPLOY_USER'])@$($server['DEPLOY_HOST'])"
)
$command = @'
sudo systemctl --no-pager --full status pr6spr-paper-copybot.service
invocation=$(sudo systemctl show -p InvocationID --value pr6spr-paper-copybot.service)
printf '\nCurrent-process logs:\n'
sudo journalctl _SYSTEMD_INVOCATION_ID=$invocation -n 30 --no-pager -o cat
printf '\nPaper records: '
if sudo test -f /opt/pr6spr-paper-copybot/shared/data/paper-trades.jsonl; then
  sudo wc -l /opt/pr6spr-paper-copybot/shared/data/paper-trades.jsonl | awk '{print $1}'
else
  echo 0
fi
printf 'Live records: '
if sudo test -f /opt/pr6spr-paper-copybot/shared/data/live-trades.jsonl; then
  sudo wc -l /opt/pr6spr-paper-copybot/shared/data/live-trades.jsonl | awk '{print $1}'
  printf 'Recent live records:\n'
  sudo tail -n 6 /opt/pr6spr-paper-copybot/shared/data/live-trades.jsonl
else
  echo 0
fi
printf 'Pending manual orders:\n'
if sudo test -d /opt/pr6spr-paper-copybot/shared/data/manual-orders; then
  sudo find /opt/pr6spr-paper-copybot/shared/data/manual-orders -maxdepth 1 -type f \( -name '*.json' -o -name '*.processing' \) -exec cat {} \;
fi
'@
& ssh @sshArgs $command
