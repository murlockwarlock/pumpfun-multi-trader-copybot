$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../deploy/ssh-common.ps1')

function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'." }
}

$ssh = @(Get-DeploySshOptions -Key dummy -Port 2222)
$scp = @(Get-DeploySshOptions -Key dummy -Port 2222 -Scp)
foreach ($option in @('ConnectTimeout=12', 'ConnectionAttempts=3', 'ServerAliveInterval=20', 'ServerAliveCountMax=3')) {
    if ($ssh -cnotcontains $option -or $scp -cnotcontains $option) { throw "Missing $option" }
}
Assert-Equal $ssh[-2] '-p'
Assert-Equal $scp[-2] '-P'
Assert-Equal $scp[-1] '2222'
Assert-Equal (Get-DeploySshFailure 255 'ssh: connect to host private port 22: Connection timed out' $false) 'TCP_TIMEOUT'
Assert-Equal (Get-DeploySshFailure 255 'ssh: connect to host private port 22: Connection refused' $false) 'CONNECTION_REFUSED'
Assert-Equal (Get-DeploySshFailure 255 'user@private: Permission denied (publickey).' $false) 'AUTHENTICATION_FAILURE'
Assert-Equal (Get-DeploySshFailure 255 'Host key verification failed.' $false) 'HOST_KEY_FAILURE'
Assert-Equal (Get-DeploySshFailure 255 'Could not resolve hostname private' $false) 'DNS_FAILURE'
Assert-Equal (Get-DeploySshFailure 255 'Connection reset by peer' $false) 'SSH_TRANSPORT_FAILURE'
Assert-Equal (Get-DeploySshFailure 255 'Connection reset by peer' $true) 'REMOTE_COMMAND_FAILURE'
Assert-Equal (Get-DeploySshFailure 124 '' $false) 'REMOTE_COMMAND_FAILURE'

$start = '__COPYBOT_STATUS_STARTED__'
$end = '__COPYBOT_STATUS_FINISHED__'
$probe = @{ Calls = 0; Sleeps = 0 }
$fake = {
    param($Arguments, $InputText)
    $probe.Calls++
    Assert-Equal $Arguments[-1] 'timeout 20s bash -s -- 2026-11-11T06:47:00Z'
    if (!$InputText.Contains($start) -or !$InputText.Contains($end)) { throw 'Missing remote status markers' }
    if (!$InputText.EndsWith("`nexit`n")) { throw 'The remote payload needs an LF-terminated exit' }
    if ($probe.Calls -eq 1) {
        return @{ ExitCode = 255; Lines = @('ssh: connect to host private port 22: Connection timed out') }
    }
    return @{ ExitCode = 0; Lines = @('preamble', $start, 'systemd=active', $end) }
}
$result = Invoke-DeployReadOnlySsh -Options $ssh -Destination 'user@private' -Command 'true' `
    -RemoteArguments '2026-11-11T06:47:00Z' -RunSsh $fake -Backoff { $probe.Sleeps++ }
Assert-Equal $result.Status 'OK'
Assert-Equal $result.Attempts 2
Assert-Equal $result.Output 'systemd=active'
Assert-Equal $probe.Sleeps 1

$result = Invoke-DeployReadOnlySsh -Options $ssh -Destination 'user@private' -Command 'true' `
    -RunSsh { @{ ExitCode = 255; Lines = @($start, 'sudo: permission denied', $end) } } `
    -Backoff { throw 'Remote commands must not be retried' }
Assert-Equal $result.Status 'REMOTE_COMMAND_FAILURE'
Assert-Equal $result.Attempts 1

$result = Invoke-DeployReadOnlySsh -Options $ssh -Destination 'user@private' -Command 'true' `
    -RunSsh { @{ ExitCode = 255; Lines = @('ssh: connect to host private port 22: Connection timed out') } } `
    -Backoff {}
Assert-Equal $result.Status 'TCP_TIMEOUT'
Assert-Equal $result.Attempts 2
Assert-Equal @($result.Output).Count 0

Get-ChildItem (Join-Path $PSScriptRoot '../deploy') -Filter '*.ps1' | ForEach-Object {
    $tokens = $null
    $errors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors)
    if ($errors) { throw "PowerShell syntax error in $($_.Name): $errors" }
}
