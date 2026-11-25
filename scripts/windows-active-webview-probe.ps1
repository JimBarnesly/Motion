#requires -Version 5.1
# Read-only CI evidence. No registry fallback, remote CIM session, native DLL
# execution, process termination, or production Motion capability is used.
# API contracts: learn.microsoft.com/windows/win32/fwp/wmi/nettcpipprov/msft-nettcpconnection
# and learn.microsoft.com/windows/win32/cimwin32prov/win32-process.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$clock = [Diagnostics.Stopwatch]::StartNew()
$motionProcess = $null
$runtimeProcess = $null
$fileGuard = $null
$hash = $null
$failureCode = 'INVALID_INPUT'
$exitCode = 1
$proof = [ordered]@{ schemaVersion = 1; operation = 'active-webview'; ok = $false; phase = 'input';
    motionIdentity = $null; listener = $null; runtimeIdentity = $null; parentProcessId = $null;
    executable = $null; minimumVersion = $null; cdpProduct = $null; rechecked = $false; error = $null }

function Stop-Probe([string] $Code) { $script:failureCode = $Code; throw 'Active WebView2 evidence was not established.' }
function Assert-Deadline { if ($clock.ElapsedMilliseconds -gt 25000) { Stop-Probe 'DEADLINE_EXCEEDED' } }
function Assert-Keys($Value, [string[]] $Names) {
    if ($null -eq $Value -or $Value -isnot [pscustomobject]) { Stop-Probe 'INVALID_INPUT' }
    $actual = @($Value.psobject.Properties.Name)
    if ($actual.Count -ne $Names.Count) { Stop-Probe 'INVALID_INPUT' }
    foreach ($name in $actual) { if ($name -cnotin $Names) { Stop-Probe 'INVALID_INPUT' } }
}
function Assert-LocalPath($Value) {
    if ($Value -isnot [string] -or $Value.Length -gt 4096 -or $Value -notmatch '^[A-Za-z]:\\' -or
        $Value -match '[\x00-\x1f\x7f/]' -or $Value.Substring(2).Contains(':') -or
        -not [string]::Equals([IO.Path]::GetFullPath($Value), $Value, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Expected a normalized local path.'
    }
    foreach ($part in $Value.Substring(3).Split('\')) {
        if ($part.Length -eq 0 -or $part -match '[. ]$') { throw 'Unsupported local path component.' }
    }
}
function Read-Version($Value) {
    if ($Value -isnot [string] -or $Value -notmatch '^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){3}$') { throw 'Invalid numeric runtime version.' }
    $parts = $Value.Split('.')
    foreach ($part in $parts) { if ([int]$part -gt 65535) { throw 'Invalid numeric runtime component.' } }
    if ([int]$parts[0] -eq 0) { throw 'Runtime version is missing.' }
    return [version]$Value
}
function Read-Request {
    $text = [Text.StringBuilder]::new()
    while ($true) {
        $character = [Console]::In.Read()
        if ($character -eq -1 -or $character -eq 10) { break }
        if ($text.Length -ge 16384) { Stop-Probe 'INVALID_INPUT' }
        [void]$text.Append([char]$character)
    }
    if ($text.Length -eq 0 -or [Console]::In.Read() -ne -1) { Stop-Probe 'INVALID_INPUT' }
    return ConvertFrom-Json -InputObject $text.ToString()
}
function Assert-IdentityInput($Identity) {
    Assert-Keys $Identity @('processId', 'executablePath', 'startTimeFileTimeUtc', 'sessionId')
    if (($Identity.processId -isnot [int] -and $Identity.processId -isnot [long]) -or $Identity.processId -le 0 -or $Identity.processId -gt [int]::MaxValue -or
        ($Identity.sessionId -isnot [int] -and $Identity.sessionId -isnot [long]) -or $Identity.sessionId -lt 0 -or $Identity.sessionId -gt [int]::MaxValue -or
        $Identity.startTimeFileTimeUtc -isnot [string] -or $Identity.startTimeFileTimeUtc -notmatch '^[1-9]\d{14,18}$') { Stop-Probe 'INVALID_INPUT' }
    [void][long]::Parse($Identity.startTimeFileTimeUtc, [Globalization.CultureInfo]::InvariantCulture)
    Assert-LocalPath $Identity.executablePath
    if (-not [string]::Equals([IO.Path]::GetFileName($Identity.executablePath), 'motion-desktop.exe', [StringComparison]::OrdinalIgnoreCase)) { Stop-Probe 'INVALID_INPUT' }
}
function Get-Identity($Process) {
    Assert-Deadline
    $Process.Refresh()
    if ($Process.HasExited) { throw 'The retained process exited.' }
    return [ordered]@{ processId = $Process.Id; executablePath = $Process.MainModule.FileName;
        startTimeFileTimeUtc = $Process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture);
        sessionId = $Process.SessionId }
}
function Assert-SameIdentity($Actual, $Expected) {
    if ($Actual.processId -ne $Expected.processId -or $Actual.sessionId -ne $Expected.sessionId -or
        $Actual.startTimeFileTimeUtc -cne $Expected.startTimeFileTimeUtc -or
        -not [string]::Equals($Actual.executablePath, $Expected.executablePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The retained process identity changed.' }
}
function Get-Listener([int] $Port) {
    Assert-Deadline
    # No ComputerName/CimSession: local COM/WMI only. State 2 is documented Listen.
    $rows = @(Get-CimInstance -Namespace 'root/StandardCimv2' -ClassName MSFT_NetTCPConnection -OperationTimeoutSec 5 -ErrorAction Stop `
        -Filter "LocalPort = $Port AND State = 2" -Property LocalAddress, LocalPort, OwningProcess, State)
    if ($rows.Count -eq 0) { Stop-Probe 'LISTENER_NOT_FOUND' }
    if ($rows.Count -gt 2) { Stop-Probe 'LISTENER_AMBIGUOUS' }
    $owner = [long]$rows[0].OwningProcess
    $addresses = [Collections.Generic.List[string]]::new()
    foreach ($row in $rows) {
        if ($row.LocalPort -ne $Port -or $row.State -ne 2 -or $owner -le 0 -or $owner -gt [int]::MaxValue -or
            $row.OwningProcess -ne $owner -or $row.LocalAddress -cnotin @('127.0.0.1', '::1') -or $addresses.Contains($row.LocalAddress)) {
            Stop-Probe 'LISTENER_IDENTITY_MISMATCH'
        }
        $addresses.Add($row.LocalAddress)
    }
    if (-not $addresses.Contains('127.0.0.1')) { Stop-Probe 'LISTENER_IDENTITY_MISMATCH' }
    $addresses.Sort([StringComparer]::Ordinal)
    return [ordered]@{ port = $Port; addresses = $addresses.ToArray(); owningProcessId = [int]$owner }
}
function Assert-Parent($Runtime, $Motion) {
    Assert-Deadline
    $rows = @(Get-CimInstance -Namespace 'root/CIMV2' -ClassName Win32_Process -OperationTimeoutSec 5 -ErrorAction Stop `
        -Filter "ProcessId = $($Runtime.processId)" -Property ProcessId, ParentProcessId, SessionId, CreationDate, ExecutablePath)
    if ($rows.Count -ne 1 -or $rows[0].ProcessId -ne $Runtime.processId -or $rows[0].ParentProcessId -ne $Motion.processId -or
        $rows[0].SessionId -ne $Runtime.sessionId -or $Runtime.sessionId -ne $Motion.sessionId -or
        [long]$Runtime.startTimeFileTimeUtc -lt [long]$Motion.startTimeFileTimeUtc -or
        -not [string]::Equals($rows[0].ExecutablePath, $Runtime.executablePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The runtime parent or process generation did not match.'
    }
    # CIM datetime is microsecond precision; FILETIME is 100 ns. Compare at the
    # common precision while retaining the exact FILETIME from the live handle.
    $created = $rows[0].CreationDate.ToUniversalTime().ToFileTimeUtc()
    if ([Math]::Abs([decimal]$created - [decimal][long]$Runtime.startTimeFileTimeUtc) -ge 10) { throw 'The CIM runtime generation changed.' }
}
function Assert-NoReparsePath([string] $Path) {
    Assert-LocalPath $Path
    $root = [IO.Path]::GetPathRoot($Path)
    if ([IO.DriveInfo]::new($root).DriveType -ne [IO.DriveType]::Fixed) { throw 'The runtime is not on a fixed local drive.' }
    $current = $root
    foreach ($part in $Path.Substring($root.Length).Split('\')) {
        $current = [IO.Path]::Combine($current, $part)
        if ([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) { throw 'A runtime path component is a reparse point.' }
    }
}
function Get-RuntimeLocation([string] $Path) {
    Assert-NoReparsePath $Path
    if (-not [string]::Equals([IO.Path]::GetFileName($Path), 'msedgewebview2.exe', [StringComparison]::OrdinalIgnoreCase)) { throw 'The listener is not WebView2.' }
    $directory = [IO.Path]::GetDirectoryName($Path)
    $directoryVersion = [IO.Path]::GetFileName($directory)
    [void](Read-Version $directoryVersion)
    $application = [IO.Path]::GetDirectoryName($directory)
    $known = [ordered]@{
        ProgramFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
        ProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
        LocalApplicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    }
    foreach ($name in $known.Keys) {
        if ([string]::IsNullOrWhiteSpace($known[$name])) { continue }
        $expected = [IO.Path]::Combine($known[$name], 'Microsoft\EdgeWebView\Application')
        if ([string]::Equals($application, $expected, [StringComparison]::OrdinalIgnoreCase)) {
            return [ordered]@{ knownLocation = $name; applicationRoot = $application; directoryVersion = $directoryVersion }
        }
    }
    throw 'The selected runtime is outside the known Evergreen locations.'
}
function Get-NumericFileVersion($Info, [bool] $Product = $false) {
    $value = if ($Product) { '{0}.{1}.{2}.{3}' -f $Info.ProductMajorPart, $Info.ProductMinorPart, $Info.ProductBuildPart, $Info.ProductPrivatePart }
        else { '{0}.{1}.{2}.{3}' -f $Info.FileMajorPart, $Info.FileMinorPart, $Info.FileBuildPart, $Info.FilePrivatePart }
    [void](Read-Version $value)
    return $value
}

try {
    $request = Read-Request
    Assert-Keys $request @('schemaVersion', 'operation', 'motionIdentity', 'debugPort', 'minimumVersion', 'cdpProduct')
    if ($request.schemaVersion -ne 1 -or $request.operation -cne 'active-webview') { Stop-Probe 'INVALID_INPUT' }
    Assert-IdentityInput $request.motionIdentity
    if (($request.debugPort -isnot [int] -and $request.debugPort -isnot [long]) -or $request.debugPort -lt 1 -or $request.debugPort -gt 65535) { Stop-Probe 'INVALID_INPUT' }
    $minimum = Read-Version $request.minimumVersion
    if ($null -ne $request.cdpProduct -and ($request.cdpProduct -isnot [string] -or $request.cdpProduct.Length -eq 0 -or
        $request.cdpProduct.Length -gt 256 -or $request.cdpProduct -match '[\x00-\x1f\x7f]')) { Stop-Probe 'INVALID_INPUT' }
    if ($null -ne $request.cdpProduct -and $request.cdpProduct.StartsWith('Edg/', [StringComparison]::Ordinal)) { [void](Read-Version $request.cdpProduct.Substring(4)) }
    $proof.minimumVersion = $request.minimumVersion
    $proof.cdpProduct = $request.cdpProduct

    $proof.phase = 'host'; $failureCode = 'UNSUPPORTED_HOST'
    if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or -not [Environment]::Is64BitProcess -or
        $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { Stop-Probe 'UNSUPPORTED_HOST' }
    $powershellRoot = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0')
    if (-not [string]::Equals([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
        [IO.Path]::Combine($powershellRoot, 'powershell.exe'), [StringComparison]::OrdinalIgnoreCase)) { Stop-Probe 'UNSUPPORTED_HOST' }
    $proof.phase = 'modules'; $failureCode = 'UNSUPPORTED_PROBE'
    $env:PSModulePath = [IO.Path]::Combine($powershellRoot, 'Modules')
    Import-Module ([IO.Path]::Combine($env:PSModulePath, 'CimCmdlets\CimCmdlets.psd1')) -ErrorAction Stop

    $proof.phase = 'motion'; $failureCode = 'PROCESS_IDENTITY_MISMATCH'
    $motionProcess = [Diagnostics.Process]::GetProcessById($request.motionIdentity.processId)
    [void]$motionProcess.Handle
    $motionIdentity = Get-Identity $motionProcess
    Assert-SameIdentity $motionIdentity $request.motionIdentity
    if ($motionIdentity.sessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { Stop-Probe 'PROCESS_IDENTITY_MISMATCH' }
    $proof.motionIdentity = $motionIdentity

    $proof.phase = 'listener'; $failureCode = 'LISTENER_QUERY_FAILED'
    $listener = Get-Listener $request.debugPort
    $proof.listener = $listener
    $proof.phase = 'runtime'; $failureCode = 'RUNTIME_IDENTITY_MISMATCH'
    if ($listener.owningProcessId -eq $motionIdentity.processId) { Stop-Probe 'RUNTIME_IDENTITY_MISMATCH' }
    $runtimeProcess = [Diagnostics.Process]::GetProcessById($listener.owningProcessId)
    [void]$runtimeProcess.Handle
    $runtimeIdentity = Get-Identity $runtimeProcess
    Assert-LocalPath $runtimeIdentity.executablePath
    if (-not [string]::Equals([IO.Path]::GetFileName($runtimeIdentity.executablePath), 'msedgewebview2.exe', [StringComparison]::OrdinalIgnoreCase) -or
        $runtimeIdentity.sessionId -ne $motionIdentity.sessionId -or [long]$runtimeIdentity.startTimeFileTimeUtc -lt [long]$motionIdentity.startTimeFileTimeUtc) {
        Stop-Probe 'RUNTIME_IDENTITY_MISMATCH'
    }
    $proof.runtimeIdentity = $runtimeIdentity
    $proof.phase = 'parent'; $failureCode = 'RUNTIME_PARENT_MISMATCH'
    Assert-Parent $runtimeIdentity $motionIdentity
    $proof.parentProcessId = $motionIdentity.processId

    $proof.phase = 'path'; $failureCode = 'RUNTIME_PATH_INVALID'
    $path = $runtimeIdentity.executablePath
    $location = Get-RuntimeLocation $path
    $fileGuard = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $byteLength = $fileGuard.Length
    if ($byteLength -le 0 -or $byteLength -gt 67108864) { throw 'The runtime executable exceeded its bound.' }
    Assert-NoReparsePath $path
    $proof.phase = 'version'; $failureCode = 'RUNTIME_VERSION_MISMATCH'
    # Refresh only after the read-only/no-write/no-delete file guard is held.
    Assert-SameIdentity (Get-Identity $runtimeProcess) $runtimeIdentity
    $moduleVersion = Get-NumericFileVersion $runtimeProcess.MainModule.FileVersionInfo
    $fileInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($path)
    $fileVersion = Get-NumericFileVersion $fileInfo
    $productVersion = Get-NumericFileVersion $fileInfo $true
    if ($moduleVersion -cne $fileVersion -or $productVersion -cne $fileVersion -or $location.directoryVersion -cne $fileVersion) { Stop-Probe 'RUNTIME_VERSION_MISMATCH' }
    $hash = [Security.Cryptography.SHA256]::Create()
    $digest = [BitConverter]::ToString($hash.ComputeHash($fileGuard)).Replace('-', '').ToLowerInvariant()
    Assert-Deadline
    $proof.executable = [ordered]@{ path = $path; knownLocation = $location.knownLocation; applicationRoot = $location.applicationRoot;
        directoryVersion = $location.directoryVersion; moduleVersion = $moduleVersion; fileVersion = $fileVersion;
        productVersion = $productVersion; byteLength = $byteLength; sha256 = $digest }
    $proof.phase = 'minimum'; $failureCode = 'RUNTIME_TOO_OLD'
    if ((Read-Version $fileVersion) -lt $minimum) { Stop-Probe 'RUNTIME_TOO_OLD' }
    if ($null -ne $request.cdpProduct -and $request.cdpProduct.StartsWith('Edg/', [StringComparison]::Ordinal) -and
        $request.cdpProduct.Substring(4) -cne $fileVersion) { Stop-Probe 'CDP_VERSION_MISMATCH' }

    $proof.phase = 'recheck'; $failureCode = 'EVIDENCE_CHANGED'
    Assert-SameIdentity (Get-Identity $motionProcess) $motionIdentity
    Assert-SameIdentity (Get-Identity $runtimeProcess) $runtimeIdentity
    Assert-Parent $runtimeIdentity $motionIdentity
    $again = Get-Listener $request.debugPort
    if ($again.owningProcessId -ne $listener.owningProcessId -or ($again.addresses -join ',') -cne ($listener.addresses -join ',')) { Stop-Probe 'EVIDENCE_CHANGED' }
    $againLocation = Get-RuntimeLocation $path
    $againFile = [Diagnostics.FileVersionInfo]::GetVersionInfo($path)
    if ($againLocation.knownLocation -cne $location.knownLocation -or $againLocation.directoryVersion -cne $fileVersion -or
        (Get-NumericFileVersion $againFile) -cne $fileVersion -or (Get-NumericFileVersion $againFile $true) -cne $fileVersion -or $fileGuard.Length -ne $byteLength) { Stop-Probe 'EVIDENCE_CHANGED' }
    Assert-SameIdentity (Get-Identity $motionProcess) $motionIdentity
    Assert-SameIdentity (Get-Identity $runtimeProcess) $runtimeIdentity
    Assert-Deadline
    $proof.rechecked = $true
    $proof.ok = $true
    $proof.phase = 'complete'
    $exitCode = 0
} catch {
    $proof.error = [ordered]@{ code = $failureCode; exceptionType = $_.Exception.GetType().FullName; hresult = '{0:X8}' -f $_.Exception.HResult }
} finally {
    if ($null -ne $hash) { $hash.Dispose() }
    if ($null -ne $fileGuard) { $fileGuard.Dispose() }
    if ($null -ne $runtimeProcess) { $runtimeProcess.Dispose() }
    if ($null -ne $motionProcess) { $motionProcess.Dispose() }
}
$json = ConvertTo-Json -InputObject $proof -Depth 7 -Compress
if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 65536) { throw 'Active WebView2 evidence exceeded its bound.' }
[Console]::Out.WriteLine($json)
exit $exitCode
