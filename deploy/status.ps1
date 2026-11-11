[CmdletBinding()]
param([string]$ServerConfigPath, [DateTimeOffset]$Since = [DateTimeOffset]::UtcNow.AddHours(-24))

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
$destination = "$($server['DEPLOY_USER'])@$($server['DEPLOY_HOST'])"
$command = @'
set -euo pipefail
root=/opt/pr6spr-paper-copybot/shared
service=pr6spr-paper-copybot.service
printf 'systemd='
sudo -n systemctl show -p ActiveState --value "$service"
if sudo -n test -f "$root/data/STOP_LIVE"; then
  echo 'STOP_LIVE=present'
else
  echo 'STOP_LIVE=not_confirmed'
fi
sudo -n awk -F= '$1 == "LIVE_TRADER_WALLETS" {value=$2} END {print "LIVE_TRADER_WALLETS=" (value=="none"?"none":"not_confirmed")}' "$root/bot.env"
main_pid=$(sudo -n systemctl show -p MainPID --value "$service")
sudo -n python3 - "$1" "$root/data/live-trades.jsonl" "$main_pid" <<'PY'
import datetime, json, sys
from pathlib import Path

try:
    env = Path("/proc", sys.argv[3], "environ").read_bytes().split(b"\0")
except (FileNotFoundError, ProcessLookupError):
    env = []
print("running_LIVE_TRADER_WALLETS=" + ("none" if b"LIVE_TRADER_WALLETS=none" in env else "not_confirmed"))
since = datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
counts = dict.fromkeys(("LIVE_SUBMITTED", "LIVE_SUBMIT_UNKNOWN", "LIVE_BUY", "LIVE_SELL", "LIVE_CLOSE"), 0)
try:
    with open(sys.argv[2], encoding="utf-8") as records:
        for line in records:
            if not line.strip():
                continue
            row = json.loads(line)
            kind = row.get("type")
            if kind in counts and datetime.datetime.fromisoformat(row["at"].replace("Z", "+00:00")) >= since:
                counts[kind] += 1
except FileNotFoundError:
    print("live_trade_journal=missing")
else:
    print("live_trade_journal_since=" + sys.argv[1])
    print("live_dispatch_or_settlement=" + json.dumps(counts))
PY
since_journal=${1/T/ }
sudo -n journalctl -u "$service" --since "${since_journal%Z} UTC" --no-pager -o cat |
  awk '/"event":"live_submitted"|"event":"live_submit_unknown"|"type":"LIVE_SUBMIT_UNKNOWN"/{n++} END{print "systemd_journal_submit_or_ambiguous=" n+0}'
sudo -n systemctl --no-pager --full status "$service" || true
invocation=$(sudo -n systemctl show -p InvocationID --value "$service")
printf '\nCurrent-process logs:\n'
if [ -n "$invocation" ]; then
  sudo -n journalctl "_SYSTEMD_INVOCATION_ID=$invocation" -n 30 --no-pager -o cat
fi
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
printf 'Shadow records: '
if sudo test -f /opt/pr6spr-paper-copybot/shared/data/shadow-trades.jsonl; then
  sudo wc -l /opt/pr6spr-paper-copybot/shared/data/shadow-trades.jsonl | awk '{print $1}'
  printf 'Recent shadow records:\n'
  sudo tail -n 6 /opt/pr6spr-paper-copybot/shared/data/shadow-trades.jsonl
else
  echo 0
fi
printf 'Pending manual orders:\n'
if sudo test -d /opt/pr6spr-paper-copybot/shared/data/manual-orders; then
  sudo -n find /opt/pr6spr-paper-copybot/shared/data/manual-orders -maxdepth 1 -type f \( -name '*.json' -o -name '*.processing' \) -printf '.' | wc -c
fi
'@
$sinceUtc = $Since.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$result = Invoke-DeployReadOnlySsh -Options $sshOptions -Destination $destination -Command $command -RemoteArguments $sinceUtc
if ($result.Status -ne 'OK') {
    throw "SERVER_STATUS_UNKNOWN ($($result.Status), status attempts: $($result.Attempts))"
}
$result.Output
