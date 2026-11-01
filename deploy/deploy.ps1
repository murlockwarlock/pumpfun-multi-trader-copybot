[CmdletBinding()]
param(
    [string]$ServerConfigPath,
    [string]$RuntimeEnvPath,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RemoteAppDir = '/opt/pr6spr-paper-copybot'
$ServiceName = 'pr6spr-paper-copybot.service'
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$NodePath = if ($NodeCommand) { $NodeCommand.Source } else { $null }

function Read-EnvFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Environment file not found: $Path"
    }
    $values = @{}
    foreach ($rawLine in Get-Content -LiteralPath $Path) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { continue }
        $key = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$key] = $value
    }
    return $values
}

function Require-Value([hashtable]$Values, [string]$Name) {
    if (-not $Values.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace($Values[$Name])) {
        throw "$Name is required"
    }
    return $Values[$Name]
}

if (-not $ServerConfigPath) {
    $pathPointer = Join-Path $PSScriptRoot 'server-config.path'
    if (-not (Test-Path -LiteralPath $pathPointer -PathType Leaf)) {
        throw 'Pass -ServerConfigPath or create deploy/server-config.path.'
    }
    $ServerConfigPath = (Get-Content -LiteralPath $pathPointer -Raw).Trim()
}
if (-not $RuntimeEnvPath) {
    $RuntimeEnvPath = Join-Path $ProjectRoot '.env'
}

$server = Read-EnvFile $ServerConfigPath
$runtime = Read-EnvFile $RuntimeEnvPath
$hostName = Require-Value $server 'DEPLOY_HOST'
$userName = Require-Value $server 'DEPLOY_USER'
$port = Require-Value $server 'DEPLOY_PORT'
$keyPath = Require-Value $server 'DEPLOY_KEY'

if ($port -notmatch '^\d+$') { throw 'DEPLOY_PORT must be numeric.' }
if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw 'DEPLOY_KEY is not readable.' }

$allowedRuntimeKeys = @(
    'TRADING_MODE',
    'TARGET_WALLET',
    'TARGET_WALLETS',
    'LIVE_TRADER_WALLETS',
    'RPC_HTTP_URL',
    'RPC_FALLBACK_HTTP_URL',
    'RPC_WS_URL',
    'PAPER_TRADE_SOL',
    'MAX_OPEN_POSITIONS',
    'MAX_DAILY_LOSS_SOL',
    'MAX_SIGNAL_AGE_MS',
    'LATENCY_PENALTY_BPS',
    'PUMP_FEE_BPS',
    'POLL_INTERVAL_MS',
    'RPC_TIMEOUT_MS',
    'MAX_RPC_SILENCE_MS',
    'STARTUP_BACKFILL_MS',
     'FAST_SIGNAL_ENABLED',
     'FAST_TRADER_WALLETS',
     'FAST_MAX_SIGNAL_AGE_MS',
     'FAST_MAX_ENTRY_DRIFT_BPS',
     'FAST_SKIP_SIMULATION',
     'FAST_SHADOW_PROBE_ENABLED',
     'FALLBACK_CONCURRENCY',
     'SHADOW_ENABLED',
     'SHADOW_TRADE_SOL',
     'SHADOW_MAX_OPEN_POSITIONS_PER_TRADER',
     'SHADOW_MAX_DAILY_LOSS_SOL',
     'SHADOW_LATENCY_PENALTY_BPS',
     'SHADOW_TX_FEE_SOL',
    'LIVE_CONFIRMATION',
    'LIVE_WALLET_FILE',
    'LIVE_WALLET_ADDRESS',
    'LIVE_TRADE_SOL',
    'LIVE_MAX_DAILY_SPEND_SOL',
    'LIVE_MIN_RESERVE_SOL',
    'LIVE_SLIPPAGE_BPS',
    'LIVE_COMPUTE_UNIT_LIMIT',
    'LIVE_PRIORITY_FEE_SOL',
    'LIVE_TIP_SOL',
    'LIVE_SEND_ROUTE',
    'LIVE_SIMULATE',
    'LIVE_MEV_PROTECT',
    'LIVE_CONFIRMATION_TIMEOUT_MS',
    'LIVE_BLOCKHASH_REFRESH_MS',
    'LIVE_MARKET_CACHE_MS',
    'LIVE_MAX_DAILY_LOSS_SOL',
    'LIVE_MAX_CONSECUTIVE_LOSSES',
    'LIVE_MAX_HOLD_MS',
    'LIVE_MAX_ENTRY_DRIFT_BPS',
    'LIVE_EXIT_RETRY_BASE_MS',
    'LIVE_EXIT_RETRY_MAX_MS',
    'LIVE_MAINTENANCE_INTERVAL_MS',
    'HELIUS_API_KEY',
    'HELIUS_SENDER_URL',
    'JITO_URL',
    'JUPITER_API_URL',
    'JUPITER_API_KEY',
    'JUPITER_API_KEY_FILE',
    'JUPITER_TIMEOUT_MS',
    'TELEGRAM_ADMIN_CHAT_ID',
    'TELEGRAM_STATUS_INTERVAL_MS'
)
foreach ($required in @('RPC_HTTP_URL', 'RPC_WS_URL')) {
    $null = Require-Value $runtime $required
}
if ((-not $runtime.ContainsKey('TARGET_WALLETS') -or
     [string]::IsNullOrWhiteSpace($runtime['TARGET_WALLETS'])) -and
    (-not $runtime.ContainsKey('TARGET_WALLET') -or
     [string]::IsNullOrWhiteSpace($runtime['TARGET_WALLET']))) {
    throw 'TARGET_WALLETS or TARGET_WALLET is required'
}

if (-not $NodePath) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
        $NodePath = $bundledNode
    }
}
if (-not $NodePath) { throw 'Node.js is required for local tests.' }

if (-not $SkipTests) {
    & $NodePath --test
    if ($LASTEXITCODE -ne 0) { throw 'Local tests failed.' }
}

$ssh = (Get-Command ssh -ErrorAction Stop).Source
$scp = (Get-Command scp -ErrorAction Stop).Source
$tar = (Get-Command tar -ErrorAction Stop).Source
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pr6spr-deploy-" + [guid]::NewGuid().ToString('N'))
$bundlePath = Join-Path $tempDir 'bundle.tar.gz'
$remoteEnvPath = Join-Path $tempDir 'bot.env'
$releaseId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$remoteBundle = "/tmp/pr6spr-paper-copybot-$releaseId.tar.gz"
$remoteEnv = "/tmp/pr6spr-paper-copybot-$releaseId.env"
$remoteScript = "/tmp/pr6spr-paper-copybot-$releaseId-deploy.sh"
$destination = "$userName@$hostName"
$sshArgs = @(
    '-i', $keyPath,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', $port,
    $destination
)
$scpArgs = @(
    '-i', $keyPath,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-P', $port
)

New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    $runtimeLines = [System.Collections.Generic.List[string]]::new()
    if (-not $runtime.ContainsKey('TRADING_MODE')) {
        $runtimeLines.Add('TRADING_MODE=paper')
    }
    foreach ($name in $allowedRuntimeKeys) {
        if (-not $runtime.ContainsKey($name)) { continue }
        $value = [string]$runtime[$name]
        if ($value.Contains("`n") -or $value.Contains("`r")) { throw "Invalid newline in $name" }
        $runtimeLines.Add("$name=$value")
    }
    $runtimeLines.Add("LOG_FILE=$RemoteAppDir/shared/data/paper-trades.jsonl")
    $runtimeLines.Add("STATE_FILE=$RemoteAppDir/shared/data/paper-state.json")
    $runtimeLines.Add("INGESTION_STATE_FILE=$RemoteAppDir/shared/data/ingestion-state.json")
    $runtimeLines.Add("LIVE_LOG_FILE=$RemoteAppDir/shared/data/live-trades.jsonl")
     $runtimeLines.Add("LIVE_STATE_FILE=$RemoteAppDir/shared/data/live-state.json")
     $runtimeLines.Add("SHADOW_LOG_FILE=$RemoteAppDir/shared/data/shadow-trades.jsonl")
     $runtimeLines.Add("SHADOW_STATE_DIR=$RemoteAppDir/shared/data/shadow-state")
    $runtimeLines.Add("LIVE_KILL_SWITCH_FILE=$RemoteAppDir/shared/data/STOP_LIVE")
    $runtimeLines.Add("LIVE_AUTO_PAUSE_FILE=$RemoteAppDir/shared/data/AUTO_PAUSE_BUYS")
    $runtimeLines.Add("MANUAL_ORDER_DIR=$RemoteAppDir/shared/data/manual-orders")
    if ($runtime.ContainsKey('TRADING_MODE') -and $runtime['TRADING_MODE'] -eq 'live') {
        $runtimeLines.Add("JUPITER_API_KEY_FILE=$RemoteAppDir/shared/secrets/jupiter-api-key")
        $runtimeLines.Add("TELEGRAM_BOT_TOKEN_FILE=$RemoteAppDir/shared/secrets/telegram-bot-token")
    }
    $runtimeText = ($runtimeLines -join "`n") + "`n"
    [System.IO.File]::WriteAllText($remoteEnvPath, $runtimeText, [System.Text.UTF8Encoding]::new($false))

    Push-Location $ProjectRoot
    try {
        & $tar -czf $bundlePath `
            --exclude='.env' `
            --exclude='data' `
            --exclude='secrets' `
            --exclude='mysecrets.txt' `
            --exclude='node_modules' `
            --exclude='deploy/.env' `
            --exclude='deploy/server-config.path' `
            --exclude='deploy/secrets.path' `
            .
        if ($LASTEXITCODE -ne 0) { throw 'Unable to create deployment bundle.' }
    } finally {
        Pop-Location
    }

    $bundleSha = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
    & $scp @scpArgs $bundlePath "${destination}:$remoteBundle"
    if ($LASTEXITCODE -ne 0) { throw 'Bundle upload failed.' }
    & $scp @scpArgs $remoteEnvPath "${destination}:$remoteEnv"
    if ($LASTEXITCODE -ne 0) { throw 'Environment upload failed.' }
    & $scp @scpArgs (Join-Path $PSScriptRoot 'remote_deploy.sh') "${destination}:$remoteScript"
    if ($LASTEXITCODE -ne 0) { throw 'Remote script upload failed.' }

    $remoteCommand = "bash '$remoteScript' '$remoteBundle' '$bundleSha' '$releaseId' '$remoteEnv' '$RemoteAppDir' '$ServiceName'"
    & $ssh @sshArgs $remoteCommand
    if ($LASTEXITCODE -ne 0) { throw 'Remote deployment failed.' }
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    $cleanupCommand = "rm -f '$remoteBundle' '$remoteEnv' '$remoteScript'"
    & $ssh @sshArgs $cleanupCommand 2>$null | Out-Null
}
