function Get-DeploySshOptions {
    param([string]$Key, [int]$Port, [switch]$Scp)

    $portFlag = if ($Scp) { '-P' } else { '-p' }
    @(
        '-i', $Key,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=12',
        '-o', 'ConnectionAttempts=3',
        '-o', 'ServerAliveInterval=20',
        '-o', 'ServerAliveCountMax=3',
        $portFlag, [string]$Port
    )
}

function Get-DeploySshFailure {
    param([int]$ExitCode, [string]$Diagnostic, [bool]$RemoteCompleted)

    if ($ExitCode -eq 0) { return 'OK' }
    if ($RemoteCompleted -or $ExitCode -ne 255) { return 'REMOTE_COMMAND_FAILURE' }
    if ($Diagnostic -match 'host key verification failed|host identification has changed') { return 'HOST_KEY_FAILURE' }
    if ($Diagnostic -match 'permission denied|authentication failed|too many authentication failures|no supported authentication') { return 'AUTHENTICATION_FAILURE' }
    if ($Diagnostic -match 'connection refused') { return 'CONNECTION_REFUSED' }
    if ($Diagnostic -match 'connect to host .* timed out') { return 'TCP_TIMEOUT' }
    if ($Diagnostic -match 'could not resolve hostname') { return 'DNS_FAILURE' }
    if ($Diagnostic -match 'timed out|connection reset|connection closed|broken pipe|no route to host|network is unreachable') { return 'SSH_TRANSPORT_FAILURE' }
    return 'SSH_FAILURE'
}

function Invoke-DeployReadOnlySsh {
    param(
        [string[]]$Options,
        [string]$Destination,
        [string]$Command,
        [string]$RemoteArguments = '',
        [scriptblock]$RunSsh = {
            param($Arguments, $InputText)
            $ErrorActionPreference = 'Continue'
            $PSNativeCommandUseErrorActionPreference = $false
            $lines = @($InputText | & ssh @Arguments 2>&1)
            @{ ExitCode = $LASTEXITCODE; Lines = $lines }
        },
        [scriptblock]$Backoff = { Start-Sleep -Seconds 2 }
    )

    # Separate an exit from the remote script from OpenSSH's own exit 255.
    $marker = '__COPYBOT_STATUS_STARTED__'
    $endMarker = '__COPYBOT_STATUS_FINISHED__'
    $inputText = "printf '%s\n' '$marker'`ntrap 'echo $endMarker' EXIT`n" + $Command.Replace("`r", '')
    $arguments = @($Options) + @('-T', $Destination, "timeout 20s bash -s -- $RemoteArguments")
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $result = & $RunSsh $arguments $inputText
        $lines = @($result.Lines | ForEach-Object { [string]$_ })
        $markerIndex = [array]::IndexOf($lines, $marker)
        $started = $markerIndex -ge 0
        $finished = $started -and [array]::IndexOf($lines, $endMarker) -gt $markerIndex
        $state = Get-DeploySshFailure $result.ExitCode ($lines -join "`n") $finished
        if ($state -eq 'OK' -and -not $finished) { $state = 'REMOTE_COMMAND_FAILURE' }
        if ($attempt -eq 1 -and $state -in @('TCP_TIMEOUT', 'SSH_TRANSPORT_FAILURE')) {
            & $Backoff
            continue
        }
        $output = if ($finished) { @($lines | Select-Object -Skip ($markerIndex + 1) | Where-Object { $_ -ne $endMarker }) } else { @() }
        return @{ Status = $state; Attempts = $attempt; Output = $output }
    }
}
