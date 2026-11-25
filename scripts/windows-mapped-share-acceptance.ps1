#requires -Version 7.0
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Creating a real SMB fixture needs CI administrator privileges. Motion itself
# does not. Never create shares on a user machine or change global SMB policy.
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Mapped SMB acceptance requires a disposable hosted Windows Actions runner.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Creating the isolated SMB test fixture requires an elevated CI token.'
}
foreach ($variable in @('RUNNER_TEMP', 'MOTION_NATIVE_HELPER', 'MOTION_TEST_NODE_BINARY', 'MOTION_TEST_SERVICE_BUNDLE', 'MOTION_ACCEPTANCE_OUTPUT')) {
    $value = [Environment]::GetEnvironmentVariable($variable)
    if ([string]::IsNullOrWhiteSpace($value) -or -not [IO.Path]::IsPathFullyQualified($value)) {
        throw "The installed acceptance environment is missing an absolute $variable path."
    }
}
foreach ($resource in @($env:MOTION_NATIVE_HELPER, $env:MOTION_TEST_NODE_BINARY, $env:MOTION_TEST_SERVICE_BUNDLE)) {
    if (-not (Test-Path -LiteralPath $resource -PathType Leaf)) { throw 'An installed SMB acceptance resource is missing.' }
}
if (-not (Test-Path -LiteralPath $env:MOTION_ACCEPTANCE_OUTPUT -PathType Container)) {
    throw 'The acceptance evidence directory must already exist.'
}

# These OS cmdlets use a real per-logon SMB mapping, not a PowerShell-only drive.
# No credentials, saved mappings, global mappings, guest access or policy repair.
# https://learn.microsoft.com/powershell/module/smbshare/new-smbmapping
# https://learn.microsoft.com/powershell/module/smbshare/new-smbshare
Import-Module SmbShare -ErrorAction Stop
foreach ($name in @('LanmanServer', 'LanmanWorkstation')) {
    if ((Get-Service -Name $name).Status -ne 'Running') {
        throw 'The disposable runner must already provide running SMB services; fixture setup does not reconfigure them.'
    }
}

function Invoke-SmbJob([scriptblock] $Start) {
    $job = & $Start
    try {
        if ($null -eq (Wait-Job -Job $job -Timeout 20)) { throw 'A bounded SMB fixture operation timed out.' }
        Receive-Job -Job $job -ErrorAction Stop
    } finally {
        if ($job.State -notin @('Completed', 'Failed', 'Stopped')) { Stop-Job -Job $job -ErrorAction Stop }
        Remove-Job -Job $job -Force -ErrorAction Stop
    }
}

function Invoke-InstalledVerifier([string] $Phase, [string[]] $Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $env:MOTION_TEST_NODE_BINARY
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.ArgumentList.Add((Join-Path $PSScriptRoot 'windows-mapped-share-verifier.mjs'))
    $start.ArgumentList.Add($Phase)
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $started = $false
    try {
        if (-not $process.Start()) { throw 'The installed verifier process did not start.' }
        $started = $true
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(75000)) {
            $process.Kill($true)
            if (-not $process.WaitForExit(10000)) { throw 'The timed-out fixture process tree did not terminate.' }
            throw 'The installed mapped SMB verifier timed out.'
        }
        $output = $stdout.GetAwaiter().GetResult()
        $diagnostic = $stderr.GetAwaiter().GetResult()
        if ($output.Length -gt 131072 -or $diagnostic.Length -gt 131072) { throw 'The verifier exceeded its output bound.' }
        $output + [Environment]::NewLine + $diagnostic | Set-Content -Encoding utf8 (Join-Path $env:MOTION_ACCEPTANCE_OUTPUT "mapped-share-$Phase.log")
        if ($process.ExitCode -ne 0) { throw "The installed mapped SMB verifier failed in its $Phase phase; see its evidence log." }
        return $output | ConvertFrom-Json -AsHashtable
    } finally {
        if ($started -and -not $process.HasExited) {
            $process.Kill($true)
            if (-not $process.WaitForExit(10000)) { throw 'The fixture process tree did not terminate during cleanup.' }
        }
        $process.Dispose()
    }
}

function Get-FixtureSecurity([string] $Root) {
    $entries = @((Get-Item -LiteralPath $Root -Force)) + @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
    if ($entries.Count -gt 128) { throw 'The controlled fixture exceeded its entry bound.' }
    $result = [ordered]@{}
    foreach ($entry in ($entries | Sort-Object FullName)) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected reparse point in the controlled fixture.' }
        # Binary owner/group/DACL and control flags, without requesting SACL or
        # audit privileges. Do not compare access times changed by valid reads.
        $descriptor = (Get-Acl -LiteralPath $entry.FullName).GetSecurityDescriptorBinaryForm()
        $result[[IO.Path]::GetRelativePath($Root, $entry.FullName)] = [Convert]::ToBase64String($descriptor)
    }
    return $result | ConvertTo-Json -Compress -Depth 4
}

$identifier = [Guid]::NewGuid().ToString('N')
$fixtureRoot = Join-Path $env:RUNNER_TEMP "motion-smb-$identifier"
$backing = Join-Path $fixtureRoot 'backing'
$shareName = "MotionSmbTest_$identifier"
$remotePath = "\\localhost\$shareName"
$mapping = $null
$createdFixture = $false
$shareAttempted = $false
$mappingAttempted = $false
$failure = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
$evidence = [ordered]@{ schemaVersion = 1; commit = $env:GITHUB_SHA; status = 'failed'; phase = 'setup'; cleanupPassed = $false }

try {
    if (Test-Path -LiteralPath $fixtureRoot) { throw 'The unique SMB fixture destination already exists.' }
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $createdFixture = $true
    $evidence.phase = 'local-controls'
    $local = Invoke-InstalledVerifier 'prepare' @($backing)
    if ($local.localNativeControls -ne $true -or $local.localServiceControl -ne $true) { throw 'The physical local-path controls did not pass.' }
    $evidence.localNativeControls = $true
    $evidence.localServiceControl = $true

    $evidence.phase = 'share-setup'
    if (@(Get-SmbShare | Where-Object Name -eq $shareName).Count -ne 0) { throw 'The unique fixture share name is already occupied.' }
    $shareAttempted = $true
    Invoke-SmbJob { New-SmbShare -Name $shareName -Path $backing -Temporary -FullAccess $identity.Name -CachingMode None -Confirm:$false -AsJob } | Out-Null
    $shareAccess = @(Get-SmbShareAccess -Name $shareName)
    if ($shareAccess.Count -ne 1 -or $shareAccess[0].AccessControlType -ne 'Allow' -or $shareAccess[0].AccessRight -ne 'Full' -or
        ([Security.Principal.NTAccount]::new($shareAccess[0].AccountName)).Translate([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) {
        throw 'The temporary SMB share must grant access only to the current Windows identity.'
    }
    $occupied = @([IO.Directory]::GetLogicalDrives() | ForEach-Object { $_.Substring(0, 2).ToUpperInvariant() })
    $occupied += @(Get-SmbMapping | Where-Object { -not [string]::IsNullOrWhiteSpace($_.LocalPath) } | ForEach-Object { $_.LocalPath.ToUpperInvariant() })
    foreach ($letter in ('ZYXWVUTSRQPONMLKJIHGFE'.ToCharArray())) {
        $candidate = "${letter}:"
        if ($candidate -notin $occupied -and $null -eq (Get-PSDrive -Name $letter -ErrorAction SilentlyContinue)) { $mapping = $candidate; break }
    }
    if ($null -eq $mapping) { throw 'No unused drive letter is available for the SMB fixture.' }
    $mappingAttempted = $true
    Invoke-SmbJob { New-SmbMapping -LocalPath $mapping -RemotePath $remotePath -Persistent:$false -Confirm:$false -AsJob } | Out-Null
    $observed = @(Get-SmbMapping | Where-Object LocalPath -eq $mapping)
    if ($observed.Count -ne 1 -or $observed[0].RemotePath -ne $remotePath -or $observed[0].Status -ne 'OK') {
        throw 'The real per-logon SMB mapping is not connected to the fixture share.'
    }
    $drive = [IO.DriveInfo]::new("$mapping\")
    if ($drive.DriveType -ne [IO.DriveType]::Network) { throw 'The drive letter is not a real network volume.' }
    $evidence.driveType = 'Network'
    $securityBefore = Get-FixtureSecurity $backing

    $evidence.phase = 'mapped-rejection'
    $verified = Invoke-InstalledVerifier 'verify' @($backing, "$mapping\")
    foreach ($check in @('mappedReadWriteControl', 'nativeMappedVolumeRejected', 'installedServiceRejected', 'physicalTreeUnchanged')) {
        if ($verified[$check] -ne $true) { throw "The required $check evidence was not produced." }
        $evidence[$check] = $true
    }
    if ((Get-FixtureSecurity $backing) -cne $securityBefore) { throw 'Mapped-volume rejection changed a physical owner or security descriptor.' }
    $evidence.securityDescriptorsUnchanged = $true
    $evidence.refusals = $verified.refusals
    $evidence.node = $verified.node
    $evidence.nativeHelperSha256 = $verified.nativeHelperSha256
    $evidence.serviceBundleSha256 = $verified.serviceBundleSha256
    $evidence.phase = 'cleanup'
} catch {
    $failure = $_
} finally {
    # A failed asynchronous setup may still have created its unique resource.
    # Re-observe exact identities; never remove a pre-existing or changed mapping.
    try {
        if ($mappingAttempted) {
            $current = @(Get-SmbMapping | Where-Object LocalPath -eq $mapping)
            if ($current.Count -gt 1 -or ($current.Count -eq 1 -and $current[0].RemotePath -ne $remotePath)) {
                throw 'The fixture drive letter now names an unrelated mapping.'
            }
            if ($current.Count -eq 1) {
                Invoke-SmbJob { Remove-SmbMapping -LocalPath $mapping -Force -Confirm:$false -AsJob } | Out-Null
                if (@(Get-SmbMapping | Where-Object LocalPath -eq $mapping).Count -ne 0) { throw 'The fixture mapping was not removed.' }
            }
        }
    } catch { $cleanupFailures.Add('mapping') }
    try {
        if ($shareAttempted) {
            $current = @(Get-SmbShare | Where-Object Name -eq $shareName)
            if ($current.Count -gt 1 -or ($current.Count -eq 1 -and $current[0].Path -ne $backing)) {
                throw 'The fixture share now names an unrelated backing directory.'
            }
            if ($current.Count -eq 1) {
                Invoke-SmbJob { Remove-SmbShare -Name $shareName -Force -Confirm:$false -AsJob } | Out-Null
                if (@(Get-SmbShare | Where-Object Name -eq $shareName).Count -ne 0) { throw 'The fixture share was not removed.' }
            }
        }
    } catch { $cleanupFailures.Add('share') }
    try {
        if ($createdFixture) {
            if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Force -Recurse }
            if (Test-Path -LiteralPath $fixtureRoot) { throw 'The fixture tree was not removed.' }
        }
    } catch { $cleanupFailures.Add('files') }
    $evidence.cleanupPassed = $cleanupFailures.Count -eq 0
    $evidence.cleanupFailures = @($cleanupFailures.ToArray())
    if ($null -eq $failure -and $evidence.cleanupPassed) { $evidence.status = 'passed'; $evidence.phase = 'complete' }
    $evidence | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $env:MOTION_ACCEPTANCE_OUTPUT 'mapped-share-acceptance.json')
}
if ($cleanupFailures.Count -ne 0) { throw "Mapped SMB fixture cleanup failed: $($cleanupFailures -join ', ')." }
if ($null -ne $failure) { throw $failure }
