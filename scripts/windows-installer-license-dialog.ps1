#requires -Version 5.1
# Source-bound CI inspection: NSIS3.11 MUI2 Pages/License.nsh and English.nlf;
# Tauri CLI2.11.4 commit8909f221d1515955fc843808032bdc5d62209c96.
# https://nsis.sourceforge.io/Docs/AppendixD.html (user Cancel exit1)
# https://learn.microsoft.com/windows/win32/winmsg/wm-gettext
# https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw
param(
    [Parameter(Mandatory = $true)][string] $InstallerPath,
    [Parameter(Mandatory = $true)][string] $ExpectedSha256,
    [Parameter(Mandatory = $true)][string] $LicensePath,
    [Parameter(Mandatory = $true)][string] $InstallDirectory,
    [Parameter(Mandatory = $true)][string] $OutputPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$clock = [Diagnostics.Stopwatch]::StartNew()
$installer = $null; $automation = $null; $installerGuard = $null; $licenseGuard = $null; $outputGuard = $null
$workerDirectory = $null; $workerFile = $null; $workerGuard = $null; $workerFileCreated = $false; $destinationValidated = $false
$exitCode = 1; $failureCode = 'INVALID_INPUT'
$proof = [ordered]@{ schemaVersion = 1; commit = $env:GITHUB_SHA; status = 'failed'; phase = 'preflight';
    installer = $null; license = $null; inspection = $null; cleanupPassed = $false; cleanupFailures = @();
    scope = 'Automated display inspection and cancellation only. No agreement, installation, or external-user consent is asserted.' }

function Assert-LocalPath([string] $Path) {
    if ($Path.Length -gt 4096 -or $Path -notmatch '^[A-Za-z]:\\' -or $Path -match '[\x00-\x1f\x7f/"<>|?*]' -or
        $Path.Substring(2).Contains(':') -or -not [string]::Equals([IO.Path]::GetFullPath($Path), $Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Expected a normalized absolute local Windows path.'
    }
    foreach ($part in $Path.Substring(3).Split('\')) {
        if ($part.Length -eq 0 -or $part -match '[. ]$' -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') {
            throw 'Unsupported Windows path component.'
        }
    }
}
function Assert-Ancestry([string] $Path) {
    Assert-LocalPath $Path
    $root = [IO.Path]::GetPathRoot($Path)
    if ([IO.DriveInfo]::new($root).DriveType -ne [IO.DriveType]::Fixed) { throw 'Acceptance paths must be on fixed local drives.' }
    $current = $root
    foreach ($part in $Path.Substring($root.Length).Split('\')) {
        $current = [IO.Path]::Combine($current, $part)
        $item = Get-Item -LiteralPath $current -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Acceptance directory ancestry must contain ordinary directories only.'
        }
    }
}
function Open-ReadGuard([string] $Path, [long] $Maximum) {
    Assert-Ancestry ([IO.Path]::GetDirectoryName($Path))
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0 -or $item.Length -gt $Maximum) {
        throw 'Expected a bounded regular input file.'
    }
    return [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
}
function Get-StreamHash($Stream) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $Stream.Position = 0; return [BitConverter]::ToString($algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $Stream.Position = 0 }
}
function Get-Identity($Process) {
    $Process.Refresh()
    if ($Process.HasExited) { throw 'The retained process has exited.' }
    return [ordered]@{ processId = $Process.Id; executablePath = $Process.MainModule.FileName;
        startTimeFileTimeUtc = $Process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture);
        sessionId = $Process.SessionId }
}
function Assert-SameIdentity($Actual, $Expected) {
    if ($Actual.processId -ne $Expected.processId -or $Actual.sessionId -ne $Expected.sessionId -or
        $Actual.startTimeFileTimeUtc -cne $Expected.startTimeFileTimeUtc -or
        -not [string]::Equals($Actual.executablePath, $Expected.executablePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The retained process identity changed.'
    }
}

# This worker has no installer-launch capability. Its parent retains the actual
# started process handle and enforces an independent deadline around UIA calls.
$worker = {
    $ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $watch = [Diagnostics.Stopwatch]::StartNew(); $process = $null
    $result = [ordered]@{ schemaVersion = 1; ok = $false; phase = 'input'; controls = @(); agreeInvoked = $false }
    function Deadline { if ($watch.ElapsedMilliseconds -gt 55000) { throw 'Licence UI inspection deadline exceeded.' } }
    function Identity-Differences($Expected, $Actual, [string[]] $Fields) {
        foreach ($field in $Fields) {
            $same = if ($field -ceq 'executablePath') {
                [string]::Equals($Actual.$field, $Expected.$field, [StringComparison]::OrdinalIgnoreCase)
            } else { $Actual.$field -ceq $Expected.$field }
            if (-not $same) { [pscustomobject]@{ field = $field; expected = $Expected.$field; actual = $Actual.$field } }
        }
    }
    function Dialog-Decision($Expected, $Actual, [long] $ElapsedMilliseconds, [string] $PreviousTitle = '') {
        if ($ElapsedMilliseconds -lt 0 -or $Actual.enabled -isnot [bool] -or $Actual.offscreen -isnot [bool]) {
            throw 'Invalid retained-dialog readiness observation.'
        }
        if ($PreviousTitle.Length -ne 0 -and ($PreviousTitle -cne 'Motion Setup' -or $Expected.name -cne 'Motion Setup ')) {
            throw 'Unsupported installer title transition.'
        }
        $identityChanges = @(Identity-Differences $Expected $Actual @('processId', 'nativeWindowHandle', 'runtimeId'))
        $pending = @(Identity-Differences $Expected $Actual @('enabled', 'offscreen'))
        if ($Actual.name -cne $Expected.name) {
            $titleChange = [pscustomobject]@{ field = 'name'; expected = $Expected.name; actual = $Actual.name }
            if ($PreviousTitle.Length -ne 0 -and $Actual.name -ceq $PreviousTitle) { $pending += $titleChange }
            else { $identityChanges += $titleChange }
        }
        $action = if ($identityChanges.Count -ne 0) { 'reject-identity' }
            elseif ($ElapsedMilliseconds -ge 3000) { 'readiness-timeout' }
            elseif ($pending.Count -ne 0) { 'wait' }
            else { 'ready' }
        return [ordered]@{ action = $action; rejectedFields = $identityChanges; pendingReadiness = $pending;
            elapsedMilliseconds = $ElapsedMilliseconds; timeoutMilliseconds = 3000 }
    }
    function Identity {
        Deadline; $process.Refresh()
        if ($process.HasExited) {
            $result['processObservation'] = [ordered]@{ rejectedFields = @([ordered]@{ field = 'hasExited'; expected = $false; actual = $true }) }
            throw 'Installer exited before the expected UI action.'
        }
        $actual = [ordered]@{ processId = $process.Id; sessionId = $process.SessionId;
            startTimeFileTimeUtc = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture);
            executablePath = $process.MainModule.FileName }
        $changes = @(Identity-Differences $request.identity $actual @('processId', 'sessionId', 'startTimeFileTimeUtc', 'executablePath'))
        $result['processObservation'] = [ordered]@{ expected = $request.identity; actual = $actual; rejectedFields = $changes }
        if ($changes.Count -ne 0) {
            throw ('Installer process identity changed: ' + (($changes | ForEach-Object { $_.field }) -join ', ') + '.')
        }
    }
    function Windows {
        Identity
        $condition = [System.Windows.Automation.AndCondition]::new(
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$process.Id),
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window))
        $found = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
        if ($found.Count -gt 16) { throw 'Installer window count exceeded its bound.' }
        foreach ($item in $found) { $item }
    }
    function Elements($Root) {
        $queue = [Collections.Generic.Queue[object]]::new(); $queue.Enqueue(@($Root, 0))
        $found = [Collections.Generic.List[object]]::new(); $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        while ($queue.Count -gt 0) {
            Deadline; $entry = $queue.Dequeue(); $found.Add($entry[0]); $child = $walker.GetFirstChild($entry[0])
            while ($null -ne $child) {
                if ($entry[1] -ge 16 -or $found.Count + $queue.Count -ge 256) { throw 'Installer control tree exceeded its bound.' }
                $queue.Enqueue(@($child, ($entry[1] + 1))); $child = $walker.GetNextSibling($child)
            }
        }
        return $found.ToArray()
    }
    function Summary($Element) {
        $c = $Element.Current; $name = [string]$c.Name; $id = [string]$c.AutomationId; $class = [string]$c.ClassName
        return [ordered]@{ name = $name.Substring(0, [Math]::Min(120, $name.Length)); automationId = $id.Substring(0, [Math]::Min(40, $id.Length));
            className = $class.Substring(0, [Math]::Min(80, $class.Length)); controlType = $c.ControlType.ProgrammaticName;
            processId = $c.ProcessId; nativeWindowHandle = $c.NativeWindowHandle; enabled = $c.IsEnabled; offscreen = $c.IsOffscreen }
    }
    function Visible($Element) { return $Element.Current.ProcessId -eq $process.Id -and $Element.Current.IsEnabled -and -not $Element.Current.IsOffscreen }
    function Dialog([string] $PreviousTitle = '') {
        $readinessClock = [Diagnostics.Stopwatch]::StartNew(); $waited = $false
        $expected = [ordered]@{ processId = $request.identity.processId; nativeWindowHandle = $dialogHandle;
            runtimeId = $dialogRuntime; name = $dialogTitle; enabled = $true; offscreen = $false }
        while ($true) {
            Identity
            $current = $dialog.Current
            $actual = [ordered]@{ processId = $current.ProcessId; nativeWindowHandle = $current.NativeWindowHandle;
                runtimeId = ($dialog.GetRuntimeId() -join ','); name = $current.Name; enabled = $current.IsEnabled; offscreen = $current.IsOffscreen }
            Deadline
            $decision = Dialog-Decision $expected $actual $readinessClock.ElapsedMilliseconds $PreviousTitle
            $result['dialogObservation'] = [ordered]@{ phase = $result.phase; expected = $expected; actual = $actual; decision = $decision }
            if ($decision.action -ceq 'reject-identity') {
                throw ('Installer window identity changed: ' + (($decision.rejectedFields | ForEach-Object { $_.field }) -join ', ') + '.')
            }
            if ($decision.action -ceq 'readiness-timeout') { throw 'The retained installer window did not become ready within 3000ms.' }
            if ($decision.action -ceq 'ready') {
                if ($waited) {
                    $result.lastReadinessWait['resolved'] = $true
                    $result.lastReadinessWait['elapsedMilliseconds'] = $readinessClock.ElapsedMilliseconds
                    $result.lastReadinessWait['readyState'] = $actual
                }
                return
            }
            if (-not $waited) {
                $result['lastReadinessWait'] = [ordered]@{ phase = $result.phase; expected = $expected; firstPendingState = $actual;
                    resolved = $false; elapsedMilliseconds = $readinessClock.ElapsedMilliseconds }
                $waited = $true
            }
            Start-Sleep -Milliseconds 50
        }
    }
    function Button($Elements, [string] $Name, [string] $Id) {
        $matches = @($Elements | Where-Object { (Visible $_) -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
            $_.Current.Name.Replace('&', '') -ceq $Name -and $_.Current.AutomationId -ceq $Id })
        if ($matches.Count -gt 1) { throw 'Installer button is ambiguous.' }
        if ($matches.Count -eq 0) { return $null }
        return $matches[0]
    }
    function Invoke-Button($Element, [string] $ExpectedName, [string] $ExpectedId) {
        Identity
        if (-not (Visible $Element) -or $Element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or
            $Element.Current.Name.Replace('&', '') -cne $ExpectedName -or $Element.Current.AutomationId -cne $ExpectedId -or $ExpectedName -ceq 'I Agree') {
            throw 'The exact non-agreement action is unavailable.'
        }
        $pattern = $null
        if (-not $Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw 'The button does not expose InvokePattern.' }
        $pattern.Invoke()
    }
    function Normalize([string] $Text) { return [regex]::Replace($Text.TrimStart([char]0xfeff), '\s+', ' ').Trim() }
    function TextHash([string] $Text) {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { return [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-', '').ToLowerInvariant() }
        finally { $algorithm.Dispose() }
    }
    try {
        $line = [Text.StringBuilder]::new()
        while ($true) { $char = [Console]::In.Read(); if ($char -eq -1 -or $char -eq 10) { break }; if ($line.Length -ge 16384) { throw 'Worker input exceeded its bound.' }; [void]$line.Append([char]$char) }
        if ($line.Length -eq 0 -or [Console]::In.Read() -ne -1) { throw 'Expected one worker request.' }
        $request = ConvertFrom-Json -InputObject $line.ToString()
        $process = [Diagnostics.Process]::GetProcessById([int]$request.identity.processId); [void]$process.Handle
        Identity
        if ($process.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'Installer is outside the interactive session.' }
        $expected = [IO.File]::ReadAllText($request.licensePath, [Text.UTF8Encoding]::new($false, $true))
        if ($expected.Length -eq 0 -or $expected.Length -gt 65536) { throw 'Licence source text exceeded its bound.' }
        $normalizedExpected = Normalize $expected
        if ((TextHash $normalizedExpected) -cne $request.normalizedSha256) { throw 'Licence source identity changed.' }
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        # Only documented read-only messages below WM_USER are sent. NSIS3.11
        # MUI2 Pages/License.nsh identifies licence control1000; modern.exe uses
        # RICHEDIT20W. WM_GETTEXT is limited below64K and has a1-second deadline.
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MotionLicenseReadOnly {
  [DllImport("user32.dll", SetLastError=true, ExactSpelling=true)] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", ExactSpelling=true)] static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll", ExactSpelling=true)] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern int GetClassNameW(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll", ExactSpelling=true)] static extern int GetWindowLongW(IntPtr h, int index);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint m, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint m, UIntPtr w, StringBuilder l, uint flags, uint timeout, out UIntPtr result);
  public static void Check(IntPtr parent, IntPtr child, uint expected) {
    uint owner; var name = new StringBuilder(64);
    if (parent == IntPtr.Zero || child == IntPtr.Zero || !IsChild(parent, child) ||
        GetWindowThreadProcessId(child, out owner) == 0 || owner != expected || GetDlgCtrlID(child) != 1000 ||
        GetClassNameW(child, name, name.Capacity) == 0 || !String.Equals(name.ToString(), "RICHEDIT20W", StringComparison.OrdinalIgnoreCase) ||
        (GetWindowLongW(child, -16) & 0x800) == 0) throw new InvalidOperationException("Licence control is not the source-defined read-only RichEdit.");
  }
  public static string Read(IntPtr parent, IntPtr child, uint expected) {
    Check(parent, child, expected); UIntPtr size;
    if (SendMessageTimeoutW(child, 0x000E, UIntPtr.Zero, IntPtr.Zero, 0x22, 1000, out size) == IntPtr.Zero ||
        size.ToUInt64() == 0 || size.ToUInt64() >= 65536) throw new InvalidOperationException("Licence text length is unavailable or too large.");
    var text = new StringBuilder(checked((int)size.ToUInt64() + 1)); UIntPtr copied;
    if (SendMessageTimeoutW(child, 0x000D, (UIntPtr)(uint)text.Capacity, text, 0x22, 1000, out copied) == IntPtr.Zero ||
        copied.ToUInt64() != (ulong)text.Length || copied.ToUInt64() >= (ulong)text.Capacity) throw new InvalidOperationException("Licence text read did not complete.");
    Check(parent, child, expected); return text.ToString();
  }
}
'@
        $result.phase = 'welcome'; $dialog = $null
        while ($null -eq $dialog) {
            $matches = @(Windows | Where-Object { (Visible $_) -and $_.Current.Name -ceq 'Motion Setup' -and $_.Current.ClassName -ceq '#32770' })
            if ($matches.Count -gt 1) { throw 'Installer window is ambiguous.' }
            if ($matches.Count -eq 1) { $dialog = $matches[0] } else { Start-Sleep -Milliseconds 100 }
        }
        $dialogHandle = $dialog.Current.NativeWindowHandle; $dialogRuntime = $dialog.GetRuntimeId() -join ','
        $dialogTitle = 'Motion Setup'
        if ($dialogHandle -eq 0 -or $dialogRuntime.Length -eq 0) { throw 'Installer window has no native identity.' }
        $next = $null
        while ($null -eq $next) {
            Dialog; $controls = @(Elements $dialog)
            $result.controls = @($controls | Select-Object -First 48 | ForEach-Object { Summary $_ })
            $welcome = @($controls | Where-Object { (Visible $_) -and $_.Current.Name -ceq 'Welcome to Motion Setup' })
            if ($welcome.Count -gt 1) { throw 'The Welcome page is ambiguous.' }
            if ($welcome.Count -eq 1) { $next = Button $controls 'Next >' '1' }
            if ($null -eq $next) { Start-Sleep -Milliseconds 100 }
        }
        Dialog; Invoke-Button $next 'Next >' '1'
        $result.phase = 'license'; $licenseControl = $null; $agree = $null; $cancel = $null
        # NSIS3.11 MUI2 License.nsh:48 sets Caption " ". Ui.c:605-607
        # appends that exact subcaption to the base title without trimming.
        # Only this authorized page transition may wait for the old title;
        # after it completes, the one trailing ASCII space is required.
        $dialogTitle = 'Motion Setup '
        Dialog -PreviousTitle 'Motion Setup'
        while ($null -eq $licenseControl -or $null -eq $agree -or $null -eq $cancel) {
            Dialog; $controls = @(Elements $dialog)
            $result.controls = @($controls | Select-Object -First 48 | ForEach-Object { Summary $_ })
            $matches = @($controls | Where-Object { (Visible $_) -and $_.Current.AutomationId -ceq '1000' -and $_.Current.ClassName -ieq 'RICHEDIT20W' })
            if ($matches.Count -gt 1) { throw 'Licence text control is ambiguous.' }
            if ($matches.Count -eq 1) { $licenseControl = $matches[0] }
            $agree = Button $controls 'I Agree' '1'; $cancel = Button $controls 'Cancel' '2'
            if ($null -eq $licenseControl -or $null -eq $agree -or $null -eq $cancel) { Start-Sleep -Milliseconds 100 }
        }
        if (@($controls | Where-Object { (Visible $_) -and $_.Current.Name -ceq 'License Agreement' }).Count -ne 1) { throw 'The source-defined Licence Agreement page was not displayed.' }
        Dialog
        [MotionLicenseReadOnly]::Check([IntPtr]$dialogHandle, [IntPtr]$licenseControl.Current.NativeWindowHandle, [uint32]$process.Id)
        $actual = $null; $method = $null; $pattern = $null
        if ($licenseControl.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
            $readOnly = $pattern.DocumentRange.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)
            if ($readOnly -is [bool] -and $readOnly) { $actual = $pattern.DocumentRange.GetText(65537); $method = 'TextPattern.DocumentRange' }
        }
        if ($null -eq $actual) {
            $pattern = $null
            if ($licenseControl.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and $pattern.Current.IsReadOnly) {
                $actual = $pattern.Current.Value; $method = 'ValuePattern'
            }
        }
        if ($null -eq $actual) {
            $actual = [MotionLicenseReadOnly]::Read([IntPtr]$dialogHandle, [IntPtr]$licenseControl.Current.NativeWindowHandle, [uint32]$process.Id)
            $method = 'bounded read-only WM_GETTEXT'
        }
        if ($actual.Length -gt 65536 -or $actual.Length -eq 0 -or (Normalize $actual) -cne $normalizedExpected) { throw 'The complete displayed licence does not match the source text.' }
        Dialog
        if (-not (Visible $agree) -or $agree.Current.Name.Replace('&', '') -cne 'I Agree') { throw 'The agreement button changed before observation.' }
        $result['license'] = [ordered]@{ fullNormalizedTextMatched = $true; method = $method; sourceCharacters = $expected.Length;
            displayedCharacters = $actual.Length; normalizedCharacters = $normalizedExpected.Length; normalizedSha256 = TextHash $normalizedExpected;
            control = Summary $licenseControl }
        $result['agreeButton'] = Summary $agree
        $result['dialog'] = [ordered]@{ nativeWindowHandle = $dialogHandle; runtimeId = $dialogRuntime; processId = $process.Id; name = $dialogTitle }
        $result.phase = 'cancel'; Dialog; Invoke-Button $cancel 'Cancel' '2'; $confirmation = $false
        while (-not $process.HasExited) {
            Deadline
            try {
                $windows = @(Windows)
                foreach ($window in $windows) {
                    if ($window.Current.NativeWindowHandle -eq $dialogHandle -or -not (Visible $window)) { continue }
                    if ($confirmation -or $window.Current.Name -cne 'Motion Setup' -or $window.Current.ClassName -cne '#32770') { throw 'An unexpected window appeared during cancellation.' }
                    $controls = @(Elements $window)
                    if (@($controls | Where-Object { (Visible $_) -and $_.Current.Name -ceq 'Are you sure you want to quit Motion Setup?' }).Count -ne 1) { throw 'Unknown cancellation confirmation text.' }
                    $yes = Button $controls 'Yes' '6'
                    if ($null -eq $yes) { throw 'The exact quit confirmation is unavailable.' }
                    Invoke-Button $yes 'Yes' '6'; $confirmation = $true
                }
            } catch {
                $process.Refresh()
                if ($process.HasExited) { break }
                throw
            }
            Start-Sleep -Milliseconds 100; $process.Refresh()
        }
        if ($process.ExitCode -ne 1) { throw 'Installer did not return the documented user-cancel exit code.' }
        $result['cancel'] = [ordered]@{ invoked = $true; confirmationInvoked = $confirmation; processExited = $true; exitCode = $process.ExitCode }
        $result.phase = 'complete'; $result.ok = $true
    } catch {
        $message = $_.Exception.Message
        $result['error'] = $message.Substring(0, [Math]::Min(600, $message.Length))
    } finally { if ($null -ne $process) { $process.Dispose() } }
    $json = ConvertTo-Json -InputObject $result -Depth 10 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 65536) { throw 'UI evidence exceeded its bound.' }
    [Console]::Out.WriteLine($json)
    if ($result.ok) { exit 0 } else { exit 1 }
}

try {
    if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or -not [Environment]::Is64BitProcess -or
        $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or
        $env:GITHUB_SHA -notmatch '^[0-9a-f]{40}$') { throw 'Licence acceptance requires a disposable Windows runner and 64-bit PowerShell5.1.' }
    foreach ($path in @($InstallerPath, $LicensePath, $InstallDirectory, $OutputPath, $env:RUNNER_TEMP)) { Assert-LocalPath $path }
    if ($ExpectedSha256 -notmatch '^[0-9a-fA-F]{64}$' -or [IO.Path]::GetExtension($InstallerPath) -ine '.exe' -or
        [IO.Path]::GetFileName($LicensePath) -cne 'INSTALLER-LICENSE.txt' -or [IO.Path]::GetExtension($OutputPath) -ine '.json') { throw 'Invalid licence acceptance input.' }
    Assert-Ancestry ([IO.Path]::GetDirectoryName($OutputPath))
    Assert-Ancestry ([IO.Path]::GetDirectoryName($InstallDirectory))
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($InstallDirectory), $env:RUNNER_TEMP.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or
        (Test-Path -LiteralPath $InstallDirectory) -or (Test-Path -LiteralPath $OutputPath)) { throw 'The output and owned installation destination must start absent.' }
    $destinationValidated = $true
    $outputGuard = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $installerGuard = Open-ReadGuard $InstallerPath 1073741824
    $licenseGuard = Open-ReadGuard $LicensePath 262144
    $installerHash = Get-StreamHash $installerGuard
    if ($installerHash -cne $ExpectedSha256.ToLowerInvariant()) { throw 'Installer bytes do not match the verified candidate.' }
    $licenseHash = Get-StreamHash $licenseGuard
    $reader = [IO.StreamReader]::new($licenseGuard, [Text.UTF8Encoding]::new($false, $true), $true, 4096, $true)
    try { $licenseText = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if ($licenseText.Length -eq 0 -or $licenseText.Length -gt 65536) { throw 'Complete licence text exceeds the supported display bound.' }
    $normalized = [regex]::Replace($licenseText.TrimStart([char]0xfeff), '\s+', ' ').Trim()
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $normalizedHash = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
    $proof.installer = [ordered]@{ path = $InstallerPath; sha256 = $installerHash; byteLength = $installerGuard.Length }
    $proof.license = [ordered]@{ path = $LicensePath; sha256 = $licenseHash; byteLength = $licenseGuard.Length; normalizedSha256 = $normalizedHash }
    # A private file avoids the Windows command-line length limit. These exact
    # source bytes are checked again under a retained read/no-delete guard.
    $workerBytes = [Text.Encoding]::UTF8.GetBytes($worker.ToString())
    if ($workerBytes.Length -gt 65536) { throw 'UI worker source exceeded its bound.' }
    $directorySecurity = [Security.AccessControl.DirectorySecurity]::new()
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $directorySecurity.SetOwner($owner)
    $directorySecurity.SetAccessRuleProtection($true, $false)
    $directorySecurity.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner,
        [Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    $candidateDirectory = Join-Path $env:RUNNER_TEMP ('Motion licence UI worker ' + [Guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $candidateDirectory) { throw 'Worker directory already exists.' }
    [void][IO.Directory]::CreateDirectory($candidateDirectory, $directorySecurity)
    $workerDirectory = $candidateDirectory
    Assert-Ancestry $workerDirectory
    $createdAcl = [IO.Directory]::GetAccessControl($workerDirectory)
    $rules = @($createdAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($createdAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $owner.Value -or
        -not $createdAcl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -cne $owner.Value -or
        $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Worker directory is not owner-private.' }
    $workerFile = Join-Path $workerDirectory 'license-ui-worker.ps1'
    $writer = [IO.File]::Open($workerFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $workerFileCreated = $true
    try { $writer.Write($workerBytes, 0, $workerBytes.Length); $writer.Flush($true) } finally { $writer.Dispose() }
    $workerGuard = Open-ReadGuard $workerFile 65536
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $workerHash = [BitConverter]::ToString($algorithm.ComputeHash($workerBytes)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
    if ((Get-StreamHash $workerGuard) -cne $workerHash) { throw 'UI worker file does not match its embedded source.' }
    $proof['workerSourceSha256'] = $workerHash
    $powerShell = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) 'WindowsPowerShell\v1.0\powershell.exe'
    Assert-Ancestry ([IO.Path]::GetDirectoryName($powerShell))
    $powerShellFile = Get-Item -LiteralPath $powerShell -Force
    if ($powerShellFile.PSIsContainer -or ($powerShellFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'System PowerShell is unavailable.' }
    $proof.phase = 'launch'; $failureCode = 'INSTALLER_PROCESS_FAILED'
    $start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName = $InstallerPath; $start.Arguments = "/D=$InstallDirectory"
    $start.UseShellExecute = $false; $start.WorkingDirectory = [IO.Path]::GetDirectoryName($InstallerPath)
    $installer = [Diagnostics.Process]::new(); $installer.StartInfo = $start
    if (-not $installer.Start()) { throw 'Installer did not start.' }
    [void]$installer.Handle
    $identity = Get-Identity $installer
    if (-not [string]::Equals($identity.executablePath, $InstallerPath, [StringComparison]::OrdinalIgnoreCase) -or
        $identity.sessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'Installer executable or interactive session did not match.' }
    $proof.installer['identity'] = $identity
    $proof.phase = 'inspect'; $failureCode = 'LICENSE_INSPECTION_FAILED'
    $start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName = $powerShell
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -Mta -File "' + $workerFile + '"'
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false); $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $start.EnvironmentVariables['PSModulePath'] = Join-Path ([IO.Path]::GetDirectoryName($powerShell)) 'Modules'
    $automation = [Diagnostics.Process]::new(); $automation.StartInfo = $start
    if (-not $automation.Start()) { throw 'UI worker did not start.' }
    [void]$automation.Handle
    $workerIdentity = Get-Identity $automation
    if (-not [string]::Equals($workerIdentity.executablePath, $powerShell, [StringComparison]::OrdinalIgnoreCase) -or
        $workerIdentity.sessionId -ne $identity.sessionId) { throw 'UI worker executable or session did not match.' }
    $stdout = $automation.StandardOutput.ReadToEndAsync(); $stderr = $automation.StandardError.ReadToEndAsync()
    $request = [ordered]@{ identity = $identity; licensePath = $LicensePath; normalizedSha256 = $normalizedHash }
    $writeInput = $automation.StandardInput.WriteLineAsync((ConvertTo-Json -InputObject $request -Depth 5 -Compress))
    if (-not $writeInput.Wait(2000)) { throw 'UI worker did not accept its bounded request.' }
    $automation.StandardInput.Close()
    while (-not $automation.WaitForExit(100)) {
        if ($clock.ElapsedMilliseconds -gt 70000) { $failureCode = 'DEADLINE_EXCEEDED'; throw 'Licence inspection exceeded its supervised deadline.' }
        try { Assert-SameIdentity (Get-Identity $automation) $workerIdentity }
        catch { $automation.Refresh(); if (-not $automation.HasExited) { throw } }
        if (-not $installer.HasExited) {
            try { Assert-SameIdentity (Get-Identity $installer) $identity }
            catch { $installer.Refresh(); if (-not $installer.HasExited) { throw } }
        }
        if (Test-Path -LiteralPath $InstallDirectory) { throw 'Installation destination appeared before agreement.' }
    }
    if (-not $stdout.Wait(2000) -or -not $stderr.Wait(2000)) { throw 'UI worker output did not close.' }
    if ([Text.Encoding]::UTF8.GetByteCount($stdout.Result) -gt 65536 -or [Text.Encoding]::UTF8.GetByteCount($stderr.Result) -gt 4096) { throw 'UI worker output exceeded its bound.' }
    $inspection = ConvertFrom-Json -InputObject $stdout.Result
    $proof.inspection = $inspection
    if ($automation.ExitCode -ne 0 -or $inspection.schemaVersion -ne 1 -or $inspection.ok -isnot [bool] -or -not $inspection.ok -or
        $inspection.phase -cne 'complete' -or $inspection.agreeInvoked -isnot [bool] -or $inspection.agreeInvoked -or
        $inspection.license.fullNormalizedTextMatched -isnot [bool] -or -not $inspection.license.fullNormalizedTextMatched -or
        $inspection.license.normalizedSha256 -cne $normalizedHash -or $inspection.dialog.processId -ne $identity.processId -or
        $inspection.dialog.name -cne 'Motion Setup ' -or
        $inspection.agreeButton.enabled -isnot [bool] -or -not $inspection.agreeButton.enabled -or
        $inspection.agreeButton.offscreen -isnot [bool] -or $inspection.agreeButton.offscreen -or
        $inspection.agreeButton.name.Replace('&', '') -cne 'I Agree' -or $inspection.agreeButton.processId -ne $identity.processId -or
        $inspection.cancel.invoked -isnot [bool] -or -not $inspection.cancel.invoked -or
        $inspection.cancel.processExited -isnot [bool] -or -not $inspection.cancel.processExited -or $inspection.cancel.exitCode -ne 1 -or
        -not $installer.HasExited -or $installer.ExitCode -ne 1 -or (Test-Path -LiteralPath $InstallDirectory)) {
        throw 'The full licence inspection and cancellation did not complete.'
    }
    if ((Get-StreamHash $installerGuard) -cne $installerHash -or (Get-StreamHash $licenseGuard) -cne $licenseHash) { throw 'Pinned input bytes changed during inspection.' }
    $proof['destinationAbsentBeforeAndAfter'] = $true
    $proof.phase = 'complete'; $proof.status = 'passed'; $exitCode = 0
} catch {
    $message = $_.Exception.Message
    $proof['error'] = [ordered]@{ code = $failureCode; message = $message.Substring(0, [Math]::Min(800, $message.Length)) }
} finally {
    $cleanup = [Collections.Generic.List[string]]::new()
    foreach ($entry in @(@('automation', $automation), @('installer', $installer))) {
        $process = $entry[1]
        if ($null -eq $process) { continue }
        try {
            # These are retained Process objects for children started here. No
            # name, PID-only lookup, descendant scan or taskkill tree is used.
            if (-not $process.HasExited) { $process.Kill(); if (-not $process.WaitForExit(5000)) { throw 'Exact child did not stop.' } }
        } catch { $cleanup.Add("$($entry[0]) process cleanup failed") }
        finally { $process.Dispose() }
    }
    if ($null -ne $workerGuard) { $workerGuard.Dispose() }
    if ($workerFileCreated) {
        try { if (Test-Path -LiteralPath $workerFile) { [IO.File]::Delete($workerFile) } }
        catch { $cleanup.Add('Owned worker file cleanup failed') }
    }
    if ($null -ne $workerDirectory) {
        try { [IO.Directory]::Delete($workerDirectory, $false) }
        catch { $cleanup.Add('Owned worker directory cleanup failed') }
    }
    if ($null -ne $licenseGuard) { $licenseGuard.Dispose() }
    if ($null -ne $installerGuard) { $installerGuard.Dispose() }
    if ($destinationValidated -and (Test-Path -LiteralPath $InstallDirectory)) { $cleanup.Add('Installation destination is no longer absent; retained for diagnosis') }
    $proof.cleanupFailures = $cleanup.ToArray(); $proof.cleanupPassed = $cleanup.Count -eq 0
    if (-not $proof.cleanupPassed) { $proof.status = 'failed'; $exitCode = 1 }
    if ($null -ne $outputGuard) {
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $proof -Depth 14) + "`n")
            if ($bytes.Length -gt 98304) { throw 'Final licence evidence exceeded its bound.' }
            $outputGuard.Write($bytes, 0, $bytes.Length); $outputGuard.Flush($true)
        } finally { $outputGuard.Dispose() }
    }
}
if ($exitCode -ne 0) { [Console]::Error.WriteLine('Installer licence inspection failed; see bounded evidence.') }
exit $exitCode
