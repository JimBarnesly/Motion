#requires -Version 5.1
[CmdletBinding()]
param([string] $ManifestPath, [switch] $CleanupOnly, [switch] $FunctionsOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Shared fixture functions. Importing them performs no network/policy operation.
function Assert-OfflineLocalPath([string] $Value) {
    if ($Value.Length -gt 4096 -or $Value -notmatch '^[A-Za-z]:\\' -or $Value -match '[\x00-\x1f\x7f/"<>|?*]' -or
        $Value.Substring(2).Contains(':') -or -not [string]::Equals([IO.Path]::GetFullPath($Value), $Value, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid local fixture path.' }
    foreach ($part in $Value.Substring(3).Split('\')) { if (-not $part -or $part -match '[. ]$') { throw 'Invalid local fixture component.' } }
}
function Assert-OfflineNoReparse([string] $Value) {
    Assert-OfflineLocalPath $Value
    $root = [IO.Path]::GetPathRoot($Value)
    if ([IO.DriveInfo]::new($root).DriveType -ne [IO.DriveType]::Fixed) { throw 'A fixed local drive is required.' }
    $partPath = $root
    foreach ($part in $Value.Substring(3).Split('\')) {
        $partPath = [IO.Path]::Combine($partPath, $part)
        if ([IO.File]::GetAttributes($partPath) -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse paths are not accepted.' }
    }
}
function Assert-OfflineHost([switch] $SystemWorker) {
    if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or
        $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Windows PowerShell 5.1 x64 is required.' }
    $systemShell = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\powershell.exe')
    if (-not [string]::Equals([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $systemShell, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected PowerShell executable.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($SystemWorker) {
        if ($identity.User.Value -cne 'S-1-5-18') { throw 'The independent watchdog must run as SYSTEM.' }
    } else {
        if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
            $env:GITHUB_RUN_ID -notmatch '^[1-9][0-9]{0,19}$' -or $env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$' -or
            -not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'An elevated disposable GitHub-hosted Windows runner is required.'
        }
    }
}
function Import-OfflineModules {
    $env:PSModulePath = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\Modules')
    foreach ($module in @('NetSecurity', 'ScheduledTasks', 'CimCmdlets')) {
        Import-Module ([IO.Path]::Combine($env:PSModulePath, "$module\$module.psd1")) -ErrorAction Stop
    }
}
function Write-OfflineJson([string] $Path, $Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $Value -Depth 12 -Compress))
    if ($bytes.Length -gt 131072) { throw 'Fixture evidence exceeded its bound.' }
    $temporary = "$Path.pending"
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($temporary, $Path)
}
function Read-OfflineJson([string] $Path) {
    Assert-OfflineNoReparse $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -le 0 -or $stream.Length -gt 131072) { throw 'Invalid fixture JSON size.' }
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true), $false)
        try { return ConvertFrom-Json -InputObject $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}
function Get-OfflineIdentity($Process) {
    $Process.Refresh()
    if ($Process.HasExited) { throw 'An authenticated fixture process exited.' }
    [void]$Process.Handle
    return [pscustomobject]@{ processId = $Process.Id; path = $Process.MainModule.FileName;
        start = $Process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); sessionId = $Process.SessionId }
}
function Assert-OfflineIdentity($Actual, $Expected) {
    if ($Actual.processId -ne $Expected.processId -or $Actual.start -cne $Expected.start -or $Actual.sessionId -ne $Expected.sessionId -or
        -not [string]::Equals($Actual.path, $Expected.path, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture process identity changed.' }
}
function Get-OfflineHash([string] $Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}
function Test-OfflineDeadline([double] $ElapsedSeconds) {
    if ([double]::IsNaN($ElapsedSeconds) -or [double]::IsInfinity($ElapsedSeconds) -or $ElapsedSeconds -lt 0) { throw 'Invalid monotonic elapsed time.' }
    return $ElapsedSeconds -lt 240
}
function Get-OfflineRules([string] $Store) {
    $rows = @(Get-NetFirewallRule -PolicyStore $Store -ErrorAction Stop)
    if ($rows.Count -gt 20000) { throw 'Unexpectedly large firewall policy.' }
    return $rows
}
function Remove-OfflineRules($Manifest) {
    $names = @($Manifest.outRule, $Manifest.inRule, $Manifest.selfTestRule)
    $owned = @(Get-OfflineRules 'PersistentStore' | Where-Object { $_.Name -cin $names })
    foreach ($item in $owned) { $item | Remove-NetFirewallRule -ErrorAction Stop }
    foreach ($storeName in @('PersistentStore', 'ActiveStore')) {
        if (@(Get-OfflineRules $storeName | Where-Object { $_.Name -cin $names }).Count -ne 0) { throw 'Owned firewall rules remain.' }
    }
}
function Read-OfflineManifest([string] $Path) {
    Assert-OfflineNoReparse $Path
    if ([IO.Path]::GetFileName($Path) -cne 'manifest.json') { throw 'Unexpected fixture manifest name.' }
    $m = Read-OfflineJson $Path
    $keys = @('schemaVersion','fixtureId','commit','runId','root','taskName','outRule','inRule','selfTestRule','coordinator','installerPath','callbackPath','watchdogSha256','maxSeconds')
    if (@($m.psobject.Properties).Count -ne $keys.Count) { throw 'Unknown fixture manifest fields.' }
    foreach ($key in $keys) { if ($key -cnotin @($m.psobject.Properties.Name)) { throw 'Missing fixture manifest field.' } }
    if ($m.schemaVersion -ne 1 -or $m.fixtureId -notmatch '^[a-f0-9]{32}$' -or $m.commit -notmatch '^[a-f0-9]{40}$' -or
        $m.runId -notmatch '^[1-9][0-9]{0,19}$' -or $m.maxSeconds -ne 240 -or $m.watchdogSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid fixture manifest.' }
    $prefix = "MotionInstallerOffline-$($m.fixtureId)"
    if ($m.taskName -cne $prefix -or $m.outRule -cne "$prefix-Out" -or $m.inRule -cne "$prefix-In" -or $m.selfTestRule -cne "$prefix-SelfTest" -or
        -not [string]::Equals($m.root, [IO.Path]::GetDirectoryName($Path), [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($m.root) -cne $prefix) { throw 'Fixture ownership binding failed.' }
    foreach ($value in @($m.installerPath,$m.callbackPath,$m.root)) { Assert-OfflineLocalPath $value }
    $c = $m.coordinator
    if (@($c.psobject.Properties).Count -ne 4 -or $c.processId -le 0 -or $c.processId -gt [int]::MaxValue -or $c.sessionId -lt 0 -or
        $c.start -isnot [string] -or $c.start -notmatch '^[1-9][0-9]{14,18}$' -or
        -not [string]::Equals($c.path, [IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\v1.0\powershell.exe'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid coordinator identity.' }
    [void][long]::Parse($c.start)
    return $m
}
function Stop-OfflineChildren($Manifest, [bool] $ParentGenerationAuthenticated = $false) {
    # Only the two explicitly registered direct children are eligible. A shared
    # updater service is not treated as an owned process merely by its filename.
    $terminated = @()
    $failures = @()
    foreach ($entry in @(@('installer-process.json',$Manifest.installerPath),@('callback-process.json',$Manifest.callbackPath))) {
        $recordPath = [IO.Path]::Combine($Manifest.root,$entry[0])
        $records = @()
        if ([IO.File]::Exists($recordPath)) { $records = @(Read-OfflineJson $recordPath) }
        else {
            $intentPath = [IO.Path]::Combine($Manifest.root,($entry[0] -replace '-process.json$','-intent.json'))
            if (-not [IO.File]::Exists($intentPath)) { continue }
            if (-not $ParentGenerationAuthenticated) {
                $failures += 'UnresolvedParentGeneration'
                continue
            }
            # Close the StartProcess -> receipt-write interruption gap. Only a
            # direct child with this exact expected executable and generation
            # is eligible, never a service or a guessed process-name match.
            $candidates = @(Get-CimInstance -Namespace root/CIMV2 -ClassName Win32_Process -Filter "ParentProcessId = $($Manifest.coordinator.processId)" -OperationTimeoutSec 5 -ErrorAction Stop)
            if ($candidates.Count -gt 32) { throw 'Unexpected recovery process count.' }
            foreach ($candidate in $candidates) {
                if (-not [string]::Equals($candidate.ExecutablePath,$entry[1],[StringComparison]::OrdinalIgnoreCase)) { continue }
                $temporaryProcess = $null
                try {
                    try { $temporaryProcess = [Diagnostics.Process]::GetProcessById([int]$candidate.ProcessId) } catch [ArgumentException] { continue }
                    if (-not $temporaryProcess.HasExited) {
                        $identity = Get-OfflineIdentity $temporaryProcess
                        if ([long]$identity.start -ge [long]$Manifest.coordinator.start) { $records += $identity }
                    }
                } finally { if ($null -ne $temporaryProcess) { $temporaryProcess.Dispose() } }
            }
        }
        foreach ($record in $records) {
            if (-not [string]::Equals($record.path,$entry[1],[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected child path in recovery record.' }
            $child = $null
            try {
                try { $child = [Diagnostics.Process]::GetProcessById([int]$record.processId) } catch [ArgumentException] { continue }
                if ($child.HasExited) { continue }
                $current = Get-OfflineIdentity $child
                if ($current.start -cne $record.start) { continue }
                Assert-OfflineIdentity $current $record
                if ([long]$record.start -lt [long]$Manifest.coordinator.start) { throw 'Invalid child generation.' }
                $rows = @(Get-CimInstance -Namespace root/CIMV2 -ClassName Win32_Process -Filter "ProcessId = $($record.processId)" -OperationTimeoutSec 5 -ErrorAction Stop)
                if ($rows.Count -ne 1 -or $rows[0].ParentProcessId -ne $Manifest.coordinator.processId) { throw 'Unexpected recovery parent.' }
                $child.Kill()
                if (-not $child.WaitForExit(5000)) { throw 'Owned child did not terminate.' }
                $terminated += $record.processId
            } catch {
                # Exit between HasExited, identity acquisition and Kill is
                # harmless only when the same retained handle is now exited.
                if ($null -eq $child -or -not $child.HasExited) { $failures += $_.Exception.GetType().FullName }
            } finally { if ($null -ne $child) { $child.Dispose() } }
        }
    }
    if ($failures.Count -ne 0) { throw 'One or more authenticated child cleanup operations failed.' }
    return $terminated
}
function Remove-OfflineTask($Manifest) {
    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -ceq '\' -and $_.TaskName -ceq $Manifest.taskName })
    if ($tasks.Count -gt 1) { throw 'Ambiguous cleanup task.' }
    if ($tasks.Count -eq 1) {
        $actions = @($tasks[0].Actions)
        $expectedArguments = '-NoLogo -NoProfile -NonInteractive -File "' + $PSScriptRoot + '\windows-installer-offline-watchdog.ps1" -ManifestPath "' + $Manifest.root + '\manifest.json"'
        if ($actions.Count -ne 1 -or -not [string]::Equals($actions[0].Execute,
            [IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\v1.0\powershell.exe'),[StringComparison]::OrdinalIgnoreCase) -or
            $actions[0].Arguments -cne $expectedArguments
        ) { throw 'Cleanup task action changed.' }
        Stop-ScheduledTask -TaskPath '\' -TaskName $Manifest.taskName -ErrorAction Stop
        Unregister-ScheduledTask -TaskPath '\' -TaskName $Manifest.taskName -Confirm:$false -ErrorAction Stop
    }
}
if ($FunctionsOnly) { return }

$owner = $null
$parentAuthority = $false
$manifest = $null
$watchdogProof = [ordered]@{ schemaVersion=1; status='failed'; reason='initialization'; elapsedMilliseconds=$null;
    cleanupScope='Exact fixture rules and authenticated direct children; coordinator removes the watchdog task.';
    rulesRemoved=$false; childCleanupConfirmed=$false; taskRemoved=$false; cleanupPassed=$false; terminated=@(); error=$null }
try {
    Assert-OfflineHost -SystemWorker:(-not $CleanupOnly)
    Import-OfflineModules
    $manifest = Read-OfflineManifest $ManifestPath
    if ($CleanupOnly) {
        if ($manifest.commit -cne $env:GITHUB_SHA -or $manifest.runId -cne $env:GITHUB_RUN_ID) { throw 'Cleanup is for another workflow run.' }
        # A live coordinator owns normal cleanup. Emergency/always cleanup may
        # terminate it only after the exact generation has been authenticated.
        try { $owner = [Diagnostics.Process]::GetProcessById([int]$manifest.coordinator.processId) } catch [ArgumentException] { $owner=$null }
        if ($null -ne $owner -and -not $owner.HasExited) {
            $current = Get-OfflineIdentity $owner
            # An old manifest may outlive its PID. Preserve an unrelated new
            # generation while still removing this fixture's exact rules/task.
            if ($current.start -ceq $manifest.coordinator.start -and $current.sessionId -eq $manifest.coordinator.sessionId -and
                [string]::Equals($current.path,$manifest.coordinator.path,[StringComparison]::OrdinalIgnoreCase)) {
                $parentAuthority=$true
                $owner.Kill(); if (-not $owner.WaitForExit(5000)) { throw 'Coordinator did not terminate for final cleanup.' }
            }
        }
        $watchdogProof.terminated = @(Stop-OfflineChildren $manifest $parentAuthority)
        $watchdogProof.childCleanupConfirmed=$true
        Remove-OfflineRules $manifest
        $watchdogProof.rulesRemoved=$true
        Remove-OfflineTask $manifest
        $watchdogProof.taskRemoved=$true
        $watchdogProof.cleanupPassed=$true; $watchdogProof.status='passed'; $watchdogProof.reason='final-cleanup'
    } else {
        if ((Get-OfflineHash $PSCommandPath) -cne $manifest.watchdogSha256) { throw 'Watchdog source identity changed.' }
        $owner = [Diagnostics.Process]::GetProcessById([int]$manifest.coordinator.processId)
        Assert-OfflineIdentity (Get-OfflineIdentity $owner) $manifest.coordinator
        $parentAuthority=$true
        $selfTest = @(Get-OfflineRules 'ActiveStore' | Where-Object { $_.Name -ceq $manifest.selfTestRule })
        if ($selfTest.Count -ne 1 -or "$($selfTest[0].Enabled)" -cne 'False') { throw 'Disabled cleanup control is missing.' }
        $localSelfTest = @(Get-OfflineRules 'PersistentStore' | Where-Object { $_.Name -ceq $manifest.selfTestRule })
        if ($localSelfTest.Count -ne 1) { throw 'The cleanup control is not locally owned.' }
        $localSelfTest[0] | Remove-NetFirewallRule -ErrorAction Stop
        if (@(Get-OfflineRules 'ActiveStore' | Where-Object { $_.Name -ceq $manifest.selfTestRule }).Count -ne 0) { throw 'Cleanup control was not removed.' }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        Write-OfflineJson ([IO.Path]::Combine($manifest.root,'ready.json')) ([ordered]@{schemaVersion=1; fixtureId=$manifest.fixtureId; process=(Get-OfflineIdentity ([Diagnostics.Process]::GetCurrentProcess())); systemSid='S-1-5-18'; selfTestRemoved=$true; maxSeconds=240})
        $stopPath = [IO.Path]::Combine($manifest.root,'stop.json')
        while (-not [IO.File]::Exists($stopPath)) {
            $owner.Refresh()
            if ($owner.HasExited) { $watchdogProof.reason='coordinator-exited'; break }
            if ($clock.Elapsed.TotalSeconds -ge 240) { $watchdogProof.reason='deadline'; break }
            Start-Sleep -Milliseconds 100
        }
        # A stop file appearing at the deadline cannot turn expiry into success.
        $watchdogProof.elapsedMilliseconds=$clock.ElapsedMilliseconds
        if (-not (Test-OfflineDeadline $clock.Elapsed.TotalSeconds)) {
            $watchdogProof.reason='deadline'
            $owner.Refresh()
            if (-not $owner.HasExited) { Assert-OfflineIdentity (Get-OfflineIdentity $owner) $manifest.coordinator; $owner.Kill(); [void]$owner.WaitForExit(5000) }
        } elseif ([IO.File]::Exists($stopPath)) {
            $stop = Read-OfflineJson $stopPath
            if (@($stop.psobject.Properties).Count -ne 2 -or $stop.fixtureId -cne $manifest.fixtureId -or $stop.reason -cnotin @('complete','failed')) { throw 'Invalid stop signal.' }
            $watchdogProof.reason = if (Test-OfflineDeadline $clock.Elapsed.TotalSeconds) { $stop.reason } else { 'deadline' }
        } else {
            $owner.Refresh()
            if (-not $owner.HasExited) { Assert-OfflineIdentity (Get-OfflineIdentity $owner) $manifest.coordinator; $owner.Kill(); [void]$owner.WaitForExit(5000) }
        }
        if ($watchdogProof.reason -ceq 'deadline') {
            $owner.Refresh()
            if (-not $owner.HasExited) { Assert-OfflineIdentity (Get-OfflineIdentity $owner) $manifest.coordinator; $owner.Kill(); [void]$owner.WaitForExit(5000) }
        }
        $watchdogProof.terminated = @(Stop-OfflineChildren $manifest $parentAuthority)
        $watchdogProof.childCleanupConfirmed=$true
        Remove-OfflineRules $manifest
        $watchdogProof.rulesRemoved=$true
        $watchdogProof.cleanupPassed=$true
        $watchdogProof.elapsedMilliseconds=$clock.ElapsedMilliseconds
        if (-not (Test-OfflineDeadline $clock.Elapsed.TotalSeconds)) { $watchdogProof.reason='deadline' }
        if ($watchdogProof.reason -ceq 'complete') { $watchdogProof.status='passed' }
    }
} catch {
    $watchdogProof.error=[ordered]@{type=$_.Exception.GetType().FullName; hresult=('{0:X8}' -f $_.Exception.HResult)}
    if ($null -ne $manifest) {
        try { Remove-OfflineRules $manifest; $watchdogProof.rulesRemoved=$true } catch { $watchdogProof.rulesRemoved=$false }
        if ($CleanupOnly) { try { Remove-OfflineTask $manifest; $watchdogProof.taskRemoved=$true } catch { $watchdogProof.taskRemoved=$false } }
        # Removing rules alone never claims successful process/task cleanup.
        $watchdogProof.cleanupPassed=$false
    }
} finally {
    if ($null -ne $owner) { $owner.Dispose() }
    if ($null -ne $manifest) {
        $fileName = if ($CleanupOnly) { 'final-cleanup-' + [Guid]::NewGuid().ToString('N') + '.json' } else { 'watchdog-final.json' }
        Write-OfflineJson ([IO.Path]::Combine($manifest.root,$fileName)) $watchdogProof
    }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $watchdogProof -Depth 6 -Compress))
if (-not $watchdogProof.cleanupPassed -or $watchdogProof.status -cne 'passed') { exit 1 }
