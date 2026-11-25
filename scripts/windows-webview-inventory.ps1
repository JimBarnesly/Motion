#requires -Version 7.0
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string] $OutputPath,
    [ValidateSet('before-install', 'after-install', 'diagnostic')][string] $Phase = 'diagnostic'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'WebView2 inventory requires Windows.' }
if (-not [IO.Path]::IsPathFullyQualified($OutputPath) -or [IO.Path]::GetExtension($OutputPath) -ne '.json') {
    throw 'WebView2 inventory requires an absolute JSON evidence path.'
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($OutputPath)) -PathType Container)) {
    throw 'The inventory evidence directory must already exist.'
}
if (Test-Path -LiteralPath $OutputPath) { throw 'WebView2 inventory evidence must start absent.' }

# Read-only machine observations, not an installation or absence verdict. In
# particular, registry entries alone do not prove which engine Motion uses.
# No uninstall command, native DLL, registry write, service or policy change.
function Get-ProbeError($Record) {
    return [ordered]@{
        type = $Record.Exception.GetType().FullName
        hresult = '{0:X8}' -f $Record.Exception.HResult
        category = [string]$Record.CategoryInfo.Category
    }
}

function Get-BoundedString($Value, [int] $Limit = 128) {
    if ($Value -is [string] -and $Value.Length -le $Limit -and $Value -notmatch '[\x00-\x1f\x7f]') { return $Value }
    return $null
}

function Test-RuntimeVersion($Value) {
    $parsed = $null
    return $Value -is [string] -and $Value -match '^\d{1,10}(\.\d{1,10}){3}$' -and
        [version]::TryParse($Value, [ref]$parsed) -and $parsed -gt [version]'0.0.0.0'
}

function Read-RuntimeRegistration([Microsoft.Win32.RegistryHive] $Hive, [Microsoft.Win32.RegistryView] $View) {
    $result = [ordered]@{ hive = [string]$Hive; view = [string]$View; status = 'unknown'; pv = $null; validVersion = $false }
    if ($View -eq [Microsoft.Win32.RegistryView]::Registry64 -and -not [Environment]::Is64BitOperatingSystem) {
        $result.status = 'not-applicable'
        return $result
    }
    $base = $null
    $runtimeKey = $null
    $uninstallKey = $null
    try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, $View)
        $runtimeKey = $base.OpenSubKey('SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', $false)
        if ($null -eq $runtimeKey) {
            $result.status = 'key-missing'
        } elseif ('pv' -notin $runtimeKey.GetValueNames()) {
            $result.status = 'value-missing'
        } else {
            $value = $runtimeKey.GetValue('pv', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $result.status = 'observed'
            $result.valueKind = [string]$runtimeKey.GetValueKind('pv')
            $result.pv = Get-BoundedString $value
            $result.validVersion = $result.valueKind -eq 'String' -and (Test-RuntimeVersion $result.pv)
            if ($null -eq $result.pv) { $result.status = 'invalid-value' }
        }
        # Read only flags and command presence. Do not emit or execute command
        # text, which is neither a support guarantee nor trusted shell input.
        $uninstallKey = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView', $false)
        $result.uninstall = [ordered]@{ registered = $null -ne $uninstallKey }
        if ($null -ne $uninstallKey) {
            foreach ($name in @('NoRemove', 'NoModify', 'SystemComponent')) {
                $value = $uninstallKey.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                $result.uninstall[$name] = if ($value -is [int] -or $value -is [long]) { $value } else { $null }
            }
            foreach ($name in @('UninstallString', 'QuietUninstallString')) {
                $value = $uninstallKey.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                $result.uninstall["${name}Present"] = $value -is [string] -and -not [string]::IsNullOrWhiteSpace($value)
            }
        }
    } catch {
        $result.status = 'error'
        $result.error = Get-ProbeError $_
    } finally {
        if ($null -ne $uninstallKey) { $uninstallKey.Dispose() }
        if ($null -ne $runtimeKey) { $runtimeKey.Dispose() }
        if ($null -ne $base) { $base.Dispose() }
    }
    return $result
}

function Read-RuntimeFiles([string] $Location, [string] $Folder) {
    $result = [ordered]@{ location = $Location; status = 'unknown'; versionDirectoriesTruncated = $false; executables = @() }
    if ([string]::IsNullOrWhiteSpace($Folder)) { $result.status = 'not-applicable'; return $result }
    try {
        $application = Join-Path $Folder 'Microsoft\EdgeWebView\Application'
        if (-not (Test-Path -LiteralPath $application -PathType Container)) { $result.status = 'directory-missing'; return $result }
        $parent = Get-Item -LiteralPath $application -Force
        if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { $result.status = 'reparse-point-not-inspected'; return $result }
        $versions = @(Get-ChildItem -LiteralPath $application -Directory -Force |
            Where-Object { $_.Name -match '^\d{1,10}(\.\d{1,10}){3}$' } | Select-Object -First 17)
        $result.versionDirectoriesTruncated = $versions.Count -gt 16
        $executables = foreach ($directory in ($versions | Select-Object -First 16)) {
            $entry = [ordered]@{ directoryVersion = $directory.Name; status = 'unknown' }
            try {
                if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    $entry.status = 'reparse-point-not-inspected'
                } else {
                    $path = Join-Path $directory.FullName 'msedgewebview2.exe'
                    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                        $entry.status = 'executable-missing'
                    } else {
                        $file = Get-Item -LiteralPath $path -Force
                        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                            $entry.status = 'reparse-point-not-inspected'
                        } elseif ($file.Length -gt 67108864) {
                            $entry.status = 'file-exceeds-probe-bound'
                        } else {
                            $entry.status = 'observed'
                            $entry.byteLength = $file.Length
                            $entry.fileVersion = Get-BoundedString $file.VersionInfo.FileVersion
                            $entry.productVersion = Get-BoundedString $file.VersionInfo.ProductVersion
                            $entry.sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
                        }
                    }
                }
            } catch { $entry.status = 'error'; $entry.error = Get-ProbeError $_ }
            $entry
        }
        $result.executables = @($executables)
        $result.status = if ($result.versionDirectoriesTruncated) { 'partial' } else { 'observed' }
    } catch { $result.status = 'error'; $result.error = Get-ProbeError $_ }
    return $result
}

# Querying ServerManager can be unavailable under PowerShell 7. Keep that as an
# explicit unknown, and bound the optional feature query to twenty seconds.
$rds = [ordered]@{ status = 'untested'; feature = 'RDS-RD-Server' }
$job = $null
try {
    $job = Start-Job -ScriptBlock {
        $ErrorActionPreference = 'Stop'
        $command = Get-Command Get-WindowsFeature -ErrorAction SilentlyContinue
        if ($null -eq $command) { return @{ status = 'unsupported'; reason = 'Get-WindowsFeature-unavailable' } }
        $feature = @(Get-WindowsFeature -Name 'RDS-RD-Server' -ErrorAction Stop)
        if ($feature.Count -ne 1) { return @{ status = 'unsupported'; reason = 'session-host-feature-unavailable' } }
        return @{ status = 'observed'; installed = [bool]$feature[0].Installed; installState = [string]$feature[0].InstallState }
    }
    if ($null -eq (Wait-Job -Job $job -Timeout 20)) {
        $rds.status = 'timeout'
    } else {
        $observations = @(Receive-Job -Job $job -ErrorAction Stop)
        if ($observations.Count -ne 1 -or $observations[0].status -notin @('observed', 'unsupported')) {
            $rds.status = 'invalid-result'
        } else {
            foreach ($name in @('status', 'installed', 'installState', 'reason')) {
                if ($observations[0].ContainsKey($name)) { $rds[$name] = $observations[0][$name] }
            }
        }
    }
} catch { $rds.status = 'error'; $rds.error = Get-ProbeError $_ }
finally {
    if ($null -ne $job) {
        if ($job.State -notin @('Completed', 'Failed', 'Stopped')) { Stop-Job -Job $job }
        Remove-Job -Job $job -Force
    }
}

$registrations = foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
        Read-RuntimeRegistration $hive $view
    }
}
$locations = @(
    Read-RuntimeFiles 'ProgramFilesX86' ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86))
    Read-RuntimeFiles 'ProgramFiles' ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles))
    Read-RuntimeFiles 'LocalApplicationData' ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData))
)
$report = [ordered]@{
    schemaVersion = 1
    phase = $Phase
    observedAtUtc = [DateTime]::UtcNow.ToString('o')
    imageVersion = Get-BoundedString $env:ImageVersion
    osVersion = [Environment]::OSVersion.Version.ToString()
    osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    registrations = @($registrations)
    locations = $locations
    rdsSessionHost = $rds
    nativeVersionProbe = @{ status = 'untested'; reason = 'No independently verified WebView2Loader probe is provided.' }
    genuineAbsenceProven = $false
    limitations = @('Registry and files are separate observations; they do not identify a running engine.', 'Missing entries or probe failures do not prove genuine runtime absence.', 'No uninstallation was attempted.')
}
$json = $report | ConvertTo-Json -Depth 8
if ($json.Length -gt 131072) { throw 'WebView2 inventory exceeded its evidence bound.' }
$stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
} finally { $stream.Dispose() }
Write-Host "WebView2 $Phase inventory recorded; native absence remains untested."
