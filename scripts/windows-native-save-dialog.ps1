#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$proof = [ordered]@{ schemaVersion = 1; event = 'result'; operation = $null; ok = $false; phase = 'input' }
$failureCode = 'INVALID_INPUT'
$targetProcess = $null
$exitCode = 1
$dialogTitle = 'Save verified Motion backup'
$filenameControlName = 'File name:'
$filenameControlId = '1001'
$clock = [Diagnostics.Stopwatch]::StartNew()

function Write-Protocol($Value) {
    $json = ConvertTo-Json -InputObject $Value -Depth 8 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 65536) { throw 'Native dialog evidence exceeded its bound.' }
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Read-Request {
    $text = [Text.StringBuilder]::new()
    while ($true) {
        $character = [Console]::In.Read()
        if ($character -eq -1 -or $character -eq 10) { break }
        if ($text.Length -ge 16384) { throw 'Native dialog request exceeded its bound.' }
        [void]$text.Append([char]$character)
    }
    if ($text.Length -eq 0 -or [Console]::In.Read() -ne -1) { throw 'Expected exactly one bounded JSON request.' }
    return ConvertFrom-Json -InputObject $text.ToString()
}

function Assert-Keys($Value, [string[]]$Names) {
    if ($null -eq $Value -or $Value -isnot [pscustomobject]) { throw 'Expected a structured native dialog request.' }
    $actual = @($Value.psobject.Properties.Name)
    if ($actual.Count -ne $Names.Count -or @($actual | Where-Object { $_ -cnotin $Names }).Count -ne 0) {
        throw 'Unexpected native dialog request fields.'
    }
}

function Assert-DrivePath($Value) {
    if ($Value -isnot [string] -or $Value.Length -gt 32768 -or $Value -notmatch '^[A-Za-z]:\\' -or
        $Value -match '[\x00-\x1f/]' -or $Value.Substring(2).Contains(':') -or
        -not [string]::Equals([IO.Path]::GetFullPath($Value), $Value, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Expected a normalized local Windows path.'
    }
}

function Get-ProcessIdentity($Process) {
    $Process.Refresh()
    if ($Process.HasExited) { throw 'The selected Motion process has exited.' }
    return [ordered]@{
        processId = $Process.Id
        executablePath = $Process.MainModule.FileName
        startTimeFileTimeUtc = $Process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
        sessionId = $Process.SessionId
    }
}

function Assert-ProcessIdentity {
    $actual = Get-ProcessIdentity $targetProcess
    if ($actual.processId -ne $identity.processId -or $actual.sessionId -ne $identity.sessionId -or
        $actual.startTimeFileTimeUtc -cne $identity.startTimeFileTimeUtc -or
        -not [string]::Equals($actual.executablePath, $identity.executablePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The selected Motion process identity changed.'
    }
}

function Assert-Deadline {
    if ($clock.ElapsedMilliseconds -gt 55000) { throw 'Native dialog automation reached its deadline.' }
}

function Get-TargetWindows {
    Assert-Deadline
    Assert-ProcessIdentity
    $condition = [System.Windows.Automation.AndCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$identity.processId),
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window))
    # Search only top-level windows; all further traversal is inside the exact
    # process/title match. No unscoped keyboard/coordinate fallback or desktop
    # descendant scan; input requires observed authenticated foreground/focus.
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    if ($windows.Count -gt 32) { throw 'The selected process exposed too many windows.' }
    foreach ($window in $windows) { $window }
}

function Get-SaveDialog {
    $matches = @(Get-TargetWindows | Where-Object { $_.Current.Name -ceq $dialogTitle })
    if ($matches.Count -gt 1) { throw 'The selected process exposed ambiguous backup dialogs.' }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}

function Get-RuntimeKey($Element) { return ($Element.GetRuntimeId() -join ',') }

function Assert-DialogIdentity {
    Assert-ProcessIdentity
    $found = Get-SaveDialog
    if ($null -eq $found -or (Get-RuntimeKey $found) -cne $dialogRuntime -or
        $found.Current.NativeWindowHandle -ne $dialogHandle -or $found.Current.ProcessId -ne $identity.processId -or
        $dialog.Current.Name -cne $dialogTitle -or $dialog.Current.IsOffscreen -or -not $dialog.Current.IsEnabled) {
        throw 'The retained backup dialog is no longer the active authenticated dialog.'
    }
}

function Set-DialogControlFocus($Element) {
    Assert-DialogIdentity
    $runtime = Get-RuntimeKey $Element
    if ($Element.Current.ProcessId -ne $identity.processId -or -not $Element.Current.IsEnabled -or
        $Element.Current.IsOffscreen -or -not $Element.Current.IsKeyboardFocusable) {
        throw 'The retained dialog control cannot receive focus.'
    }
    $Element.SetFocus()
    $focusDeadline = $clock.ElapsedMilliseconds + 3000
    while ($true) {
        Assert-DialogIdentity
        if ((Get-RuntimeKey $Element) -cne $runtime -or $Element.Current.ProcessId -ne $identity.processId -or
            -not $Element.Current.IsEnabled -or $Element.Current.IsOffscreen) {
            throw 'The retained dialog control changed while receiving focus.'
        }
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($Element.Current.HasKeyboardFocus -and $null -ne $focused -and
            $focused.Current.ProcessId -eq $identity.processId -and (Get-RuntimeKey $focused) -ceq $runtime) {
            return [ordered]@{ observed = $true; runtimeId = $runtime; control = Get-ControlSummary $Element }
        }
        if ($clock.ElapsedMilliseconds -ge $focusDeadline) { throw 'The retained dialog control did not receive focus.' }
        Start-Sleep -Milliseconds 50
    }
}

function Get-DialogElements($Root) {
    $queue = [Collections.Generic.Queue[object]]::new()
    $queue.Enqueue([pscustomobject]@{ element = $Root; depth = 0 })
    $elements = [Collections.Generic.List[object]]::new()
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    while ($queue.Count -gt 0) {
        Assert-Deadline
        $entry = $queue.Dequeue()
        $elements.Add($entry.element)
        $child = $walker.GetFirstChild($entry.element)
        while ($null -ne $child) {
            if ($entry.depth -ge 20 -or $elements.Count + $queue.Count -ge 512) { throw 'Backup dialog control tree exceeded its bound.' }
            $queue.Enqueue([pscustomobject]@{ element = $child; depth = $entry.depth + 1 })
            $child = $walker.GetNextSibling($child)
        }
    }
    return $elements.ToArray()
}

function Get-ControlSummary($Element) {
    $current = $Element.Current
    $name = [string]$current.Name
    $automationId = [string]$current.AutomationId
    return [ordered]@{
        name = $name.Substring(0, [Math]::Min(120, $name.Length))
        automationId = $automationId.Substring(0, [Math]::Min(120, $automationId.Length))
        controlType = $current.ControlType.ProgrammaticName
        processId = $current.ProcessId
        nativeWindowHandle = $current.NativeWindowHandle
        enabled = $current.IsEnabled
        offscreen = $current.IsOffscreen
        keyboardFocusable = $current.IsKeyboardFocusable
        hasKeyboardFocus = $current.HasKeyboardFocus
    }
}

function Initialize-DialogKeyboard {
    # winuser.h layouts are matched to the locked windows-sys 0.61.2 SDK
    # bindings. Input requires native foreground/focus checks before and after
    # the batch; a failed check stops the fixture without retargeting or retrying.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
public static class MotionDialogKeyboard {
    [StructLayout(LayoutKind.Sequential)]
    public struct KeyboardInput { public ushort virtualKey, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MouseInput { public int x, y; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    public struct HardwareInput { public uint message; public ushort low, high; }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MouseInput mouse;
        [FieldOffset(0)] public KeyboardInput keyboard;
        [FieldOffset(0)] public HardwareInput hardware;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct Input { public uint type; public InputUnion data; }
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct GuiThreadInfo {
        public uint size, flags;
        public IntPtr active, focus, capture, menuOwner, moveSize, caret;
        public Rect caretRect;
    }
    public sealed class Target {
        public long foregroundWindow, focusedWindow;
        public uint processId, threadId;
    }
    public sealed class Receipt {
        public int expectedEvents, insertedEvents, utf16CodeUnits;
        public Target before, after;
    }

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern uint SendInput(uint count, [In] Input[] inputs, int size);

    public static void AssertLayouts() {
        if (IntPtr.Size != 8 || Marshal.SizeOf(typeof(Input)) != 40 ||
            Marshal.OffsetOf(typeof(Input), "data").ToInt32() != 8 ||
            Marshal.SizeOf(typeof(KeyboardInput)) != 24 || Marshal.SizeOf(typeof(MouseInput)) != 32 ||
            Marshal.SizeOf(typeof(HardwareInput)) != 8 || Marshal.SizeOf(typeof(GuiThreadInfo)) != 72)
            throw new InvalidOperationException("The native keyboard ABI does not match x64 winuser.h.");
    }

    private static Input Key(ushort key, ushort scan, uint flags) {
        Input result = new Input();
        result.type = 1; // INPUT_KEYBOARD
        result.data.keyboard.virtualKey = key;
        result.data.keyboard.scan = scan;
        result.data.keyboard.flags = flags;
        return result;
    }

    public static Input[] BuildInputs(string text) {
        if (String.IsNullOrEmpty(text) || text.Length > 8192)
            throw new ArgumentException("The keyboard destination exceeded its fixture bound.");
        Input[] inputs = new Input[checked(4 + text.Length * 2)];
        inputs[0] = Key(0x11, 0, 0); // VK_CONTROL down
        inputs[1] = Key(0x41, 0, 0); // VK_A down
        inputs[2] = Key(0x41, 0, 2); // KEYEVENTF_KEYUP
        inputs[3] = Key(0x11, 0, 2);
        for (int index = 0; index < text.Length; index++) {
            if (Char.IsControl(text[index])) throw new ArgumentException("Control characters cannot be typed into the filename.");
            // Preserve UTF-16 code units, including surrogate pairs. Unicode
            // packets generate the dialog's real keyboard/WM_CHAR path.
            inputs[4 + index * 2] = Key(0, text[index], 4); // KEYEVENTF_UNICODE
            inputs[5 + index * 2] = Key(0, text[index], 6);
        }
        return inputs;
    }

    public static Input[] PendingKeyUps(Input[] inputs, uint inserted) {
        if (inputs == null || inserted > inputs.Length) throw new ArgumentException("Invalid keyboard insertion count.");
        if (inserted == inputs.Length) return new Input[0];
        if (inserted == 1 || inserted == 3) return new Input[] { Key(0x11, 0, 2) };
        if (inserted == 2) return new Input[] { Key(0x41, 0, 2), Key(0x11, 0, 2) };
        if (inserted > 4 && inserted % 2 == 1) return new Input[] { inputs[inserted] };
        return new Input[0];
    }

    public static Target AssertTarget(IntPtr dialog, IntPtr filename, uint expectedProcessId) {
        if (dialog == IntPtr.Zero || filename == IntPtr.Zero || expectedProcessId == 0 || GetForegroundWindow() != dialog)
            throw new InvalidOperationException("The retained dialog does not own the foreground.");
        uint dialogProcess, filenameProcess;
        uint thread = GetWindowThreadProcessId(dialog, out dialogProcess);
        uint filenameThread = GetWindowThreadProcessId(filename, out filenameProcess);
        if (thread == 0 || filenameThread != thread || dialogProcess != expectedProcessId || filenameProcess != expectedProcessId)
            throw new InvalidOperationException("The foreground dialog or filename handle changed its process/thread identity.");
        GuiThreadInfo info = new GuiThreadInfo();
        info.size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo));
        if (!GetGUIThreadInfo(thread, ref info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not authenticate native keyboard focus.");
        if (info.active != dialog || info.focus != filename || GetForegroundWindow() != dialog)
            throw new InvalidOperationException("The retained filename no longer owns native keyboard focus.");
        return new Target { foregroundWindow = dialog.ToInt64(), focusedWindow = filename.ToInt64(), processId = expectedProcessId, threadId = thread };
    }

    public static Receipt Enter(IntPtr dialog, IntPtr filename, uint processId, string text) {
        AssertLayouts();
        Input[] inputs = BuildInputs(text);
        // Do not release pre-existing user modifiers or alter their state.
        foreach (int key in new int[] { 0x10, 0x11, 0x12, 0x5b, 0x5c, 0x41 }) {
            if (GetAsyncKeyState(key) < 0) throw new InvalidOperationException("A pre-existing keyboard key is pressed.");
        }
        Target before = AssertTarget(dialog, filename, processId);
        uint inserted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
        int nativeError = Marshal.GetLastWin32Error();
        if (inserted != inputs.Length) {
            // Never retry text or Save. Release only a key left down by the
            // accepted prefix, and only while the same target is authenticated.
            Input[] releases = PendingKeyUps(inputs, inserted);
            if (releases.Length != 0) {
                AssertTarget(dialog, filename, processId);
                if (SendInput((uint)releases.Length, releases, Marshal.SizeOf(typeof(Input))) != releases.Length)
                    throw new InvalidOperationException("Partial keyboard insertion could not release its owned keys.");
            }
            throw new Win32Exception(nativeError, "The keyboard batch was incomplete (" + inserted + "/" + inputs.Length + ").");
        }
        Target after = AssertTarget(dialog, filename, processId);
        return new Receipt { expectedEvents = inputs.Length, insertedEvents = (int)inserted, utf16CodeUnits = text.Length, before = before, after = after };
    }
}
'@
    [MotionDialogKeyboard]::AssertLayouts()
}

function Assert-FilenameKeyboardFocus {
    Assert-DialogIdentity
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ((Get-RuntimeKey $filename.element) -cne $proof.filenameFocus.runtimeId -or
        $filename.element.Current.NativeWindowHandle -ne $filenameHandle -or
        -not $filename.element.Current.HasKeyboardFocus -or -not $filename.element.Current.IsEnabled -or
        $filename.element.Current.IsOffscreen -or $null -eq $focused -or
        $focused.Current.ProcessId -ne $identity.processId -or
        (Get-RuntimeKey $focused) -cne $proof.filenameFocus.runtimeId) {
        throw 'The retained filename lost its authenticated UI Automation focus.'
    }
    return [MotionDialogKeyboard]::AssertTarget([IntPtr]$dialogHandle, [IntPtr]$filenameHandle, [uint32]$identity.processId)
}

try {
    if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or -not [Environment]::Is64BitProcess -or
        [Threading.Thread]::CurrentThread.ApartmentState -ne [Threading.ApartmentState]::MTA) {
        throw 'Native dialog acceptance requires a disposable Windows runner and a 64-bit MTA helper.'
    }
    $request = Read-Request
    if ($request.schemaVersion -ne 1 -or $request.operation -cnotin @('identify', 'save')) { throw 'Unsupported native dialog request.' }
    $proof.operation = $request.operation
    if ($request.operation -ceq 'identify') { Assert-Keys $request @('schemaVersion', 'operation', 'processId', 'executablePath') }
    else { Assert-Keys $request @('schemaVersion', 'operation', 'processId', 'executablePath', 'expectedIdentity', 'destination') }
    if (($request.processId -isnot [int] -and $request.processId -isnot [long]) -or
        $request.processId -le 0 -or $request.processId -gt [int]::MaxValue -or $request.processId -eq $PID) { throw 'Invalid target process.' }
    Assert-DrivePath $request.executablePath
    if ([IO.Path]::GetFileName($request.executablePath) -cne 'motion-desktop.exe') { throw 'Expected the installed Motion executable.' }

    $proof.phase = 'authenticate'
    $failureCode = 'PROCESS_IDENTITY_MISMATCH'
    $targetProcess = [Diagnostics.Process]::GetProcessById($request.processId)
    [void]$targetProcess.Handle # Retain the process object and kernel handle across all UI actions.
    $identity = Get-ProcessIdentity $targetProcess
    if (-not [string]::Equals($identity.executablePath, $request.executablePath, [StringComparison]::OrdinalIgnoreCase) -or
        $identity.sessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) {
        throw 'The selected process executable or interactive session did not match.'
    }
    if ($request.operation -ceq 'identify') {
        $proof['identity'] = $identity
        $proof.ok = $true
    } else {
        Assert-Keys $request.expectedIdentity @('processId', 'executablePath', 'startTimeFileTimeUtc', 'sessionId')
        if (($request.expectedIdentity.processId -isnot [int] -and $request.expectedIdentity.processId -isnot [long]) -or
            ($request.expectedIdentity.sessionId -isnot [int] -and $request.expectedIdentity.sessionId -isnot [long]) -or
            $request.expectedIdentity.executablePath -isnot [string] -or
            $request.expectedIdentity.processId -ne $identity.processId -or $request.expectedIdentity.sessionId -ne $identity.sessionId -or
            $request.expectedIdentity.startTimeFileTimeUtc -isnot [string] -or
            $request.expectedIdentity.startTimeFileTimeUtc -cne $identity.startTimeFileTimeUtc -or
            -not [string]::Equals($request.expectedIdentity.executablePath, $identity.executablePath, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The original process identity no longer matches the selected Motion process.'
        }
        $proof['identity'] = $identity
        $proof.phase = 'destination'
        $failureCode = 'INVALID_DESTINATION'
        Assert-DrivePath $request.destination
        Assert-DrivePath $env:RUNNER_TEMP
        $directory = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($request.destination)) -Force
        $fixture = $directory.Parent
        if ([IO.Path]::GetFileName($request.destination) -cne 'Saved notebook proof.json' -or
            $directory.Name -cne 'Private backups' -or $fixture.Name -notmatch '^Motion native Save As [A-Za-z0-9]{6}$' -or
            -not [string]::Equals($fixture.Parent.FullName, $env:RUNNER_TEMP.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or
            ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($fixture.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            (Test-Path -LiteralPath $request.destination)) {
            throw 'The backup destination is not the fresh owned acceptance fixture.'
        }

        $proof.phase = 'dialog'
        $failureCode = 'DIALOG_AUTOMATION_FAILED'
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        Initialize-DialogKeyboard
        $baselineWindows = @(Get-TargetWindows | ForEach-Object { Get-RuntimeKey $_ })
        if ($null -ne (Get-SaveDialog)) { throw 'A backup dialog was already open before the tested click.' }
        Write-Protocol ([ordered]@{ schemaVersion = 1; operation = 'save'; event = 'ready'; identity = $identity })
        $dialog = $null
        while ($null -eq $dialog) {
            $dialog = Get-SaveDialog
            if ($null -eq $dialog) { Start-Sleep -Milliseconds 150 }
        }
        $dialogRuntime = Get-RuntimeKey $dialog
        $dialogHandle = $dialog.Current.NativeWindowHandle
        if ($dialogHandle -eq 0 -or $dialogRuntime.Length -eq 0) { throw 'Backup dialog has no stable native identity.' }
        Assert-DialogIdentity
        $proof['dialog'] = [ordered]@{ title = $dialog.Current.Name; processId = $dialog.Current.ProcessId;
            nativeWindowHandle = $dialogHandle; runtimeId = $dialogRuntime; className = $dialog.Current.ClassName }
        Write-Protocol ([ordered]@{ schemaVersion = 1; operation = 'save'; event = 'dialog'; dialog = $proof.dialog })

        $proof.phase = 'controls'
        $filename = $null
        $saveButton = $null
        while ($null -eq $filename -or $null -eq $saveButton) {
            Assert-DialogIdentity
            $filenameMatches = [Collections.Generic.List[object]]::new()
            $saveMatches = [Collections.Generic.List[object]]::new()
            $filenamePatterns = [Collections.Generic.List[object]]::new()
            $savePatterns = [Collections.Generic.List[object]]::new()
            $summaries = [Collections.Generic.List[object]]::new()
            foreach ($element in @(Get-DialogElements $dialog)) {
                $current = $element.Current
                if ($summaries.Count -lt 48) { $summaries.Add((Get-ControlSummary $element)) }
                if ($current.ProcessId -ne $identity.processId -or -not $current.IsEnabled -or $current.IsOffscreen) { continue }
                $pattern = $null
                # These are the filename Edit's exact observed label and ID in
                # the retained Windows 503ae3d dialog evidence, not a guessed ID
                # or an assumption about how Explorer displays an extension.
                if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
                    $current.Name -ceq $filenameControlName -and $current.AutomationId -ceq $filenameControlId) {
                    $available = $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)
                    $detail = [ordered]@{ valuePatternAvailable = $available; control = Get-ControlSummary $element }
                    if ($available) {
                        $detail['isReadOnly'] = $pattern.Current.IsReadOnly
                        $value = [string]$pattern.Current.Value
                        $detail['originalValue'] = $value.Substring(0, [Math]::Min(256, $value.Length))
                        if (-not $pattern.Current.IsReadOnly) {
                            $filenameMatches.Add([pscustomobject]@{ element = $element; pattern = $pattern })
                        }
                    }
                    if ($filenamePatterns.Count -lt 4) { $filenamePatterns.Add($detail) }
                }
                $pattern = $null
                if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $current.Name -ceq 'Save') {
                    $available = $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)
                    if ($savePatterns.Count -lt 4) {
                        $savePatterns.Add([ordered]@{ invokePatternAvailable = $available; control = Get-ControlSummary $element })
                    }
                    if ($available) { $saveMatches.Add([pscustomobject]@{ element = $element; pattern = $pattern }) }
                }
            }
            $proof['controls'] = $summaries.ToArray()
            $proof['matchingControls'] = [ordered]@{ filename = $filenameMatches.Count; save = $saveMatches.Count }
            $proof['candidatePatterns'] = [ordered]@{ filename = $filenamePatterns.ToArray(); save = $savePatterns.ToArray() }
            if ($filenameMatches.Count -gt 1 -or $saveMatches.Count -gt 1) { throw 'Backup dialog controls are ambiguous.' }
            if ($filenameMatches.Count -eq 1 -and $saveMatches.Count -eq 1) {
                $filename = $filenameMatches[0]
                $saveButton = $saveMatches[0]
            } else { Start-Sleep -Milliseconds 150 }
        }
        Assert-DialogIdentity
        if (Test-Path -LiteralPath $request.destination) { throw 'The fresh backup destination appeared before selection.' }
        $proof.phase = 'filename'
        $originalValue = [string]$filename.pattern.Current.Value
        if ($originalValue.Length -gt 32768) { throw 'The observed filename value exceeded its bound.' }
        $proof['filenameBeforeWrite'] = [ordered]@{ originalValue = $originalValue.Substring(0, [Math]::Min(256, $originalValue.Length));
            control = Get-ControlSummary $filename.element }
        # Both SetValue trials changed the displayed edit value while GetResult
        # returned the default filename. Send real keyboard notifications to the
        # authenticated foreground edit; ValuePattern is read-only evidence.
        $proof['filenameFocus'] = Set-DialogControlFocus $filename.element
        $filenameHandle = $filename.element.Current.NativeWindowHandle
        if ($filenameHandle -eq 0) { throw 'The observed filename edit has no native keyboard target.' }
        [void](Assert-FilenameKeyboardFocus)
        $keyboard = [MotionDialogKeyboard]::Enter([IntPtr]$dialogHandle, [IntPtr]$filenameHandle, [uint32]$identity.processId, $request.destination)
        $proof['keyboard'] = [ordered]@{ method = 'SendInput'; selection = 'Ctrl+A'; encoding = 'UTF-16'; batches = 1;
            expectedEvents = $keyboard.expectedEvents; insertedEvents = $keyboard.insertedEvents; utf16CodeUnits = $keyboard.utf16CodeUnits;
            modifiersClearBefore = $true; foregroundBefore = $keyboard.before; foregroundAfter = $keyboard.after }
        $inputDeadline = $clock.ElapsedMilliseconds + 5000
        while ($true) {
            [void](Assert-FilenameKeyboardFocus)
            if ($filename.pattern.Current.IsReadOnly) { throw 'The filename edit became read-only.' }
            if ($filename.pattern.Current.Value -ceq $request.destination) { break }
            if ($clock.ElapsedMilliseconds -ge $inputDeadline) { throw 'The typed filename did not exactly retain the requested destination.' }
            Start-Sleep -Milliseconds 50
        }
        $proof['filename'] = [ordered]@{ observedControlMatched = $true;
            originalValue = $originalValue.Substring(0, [Math]::Min(256, $originalValue.Length)); exactDestinationReadBack = $true;
            valuePatternReadBack = $true; keyboardInput = $true; control = Get-ControlSummary $filename.element }
        Write-Protocol ([ordered]@{ schemaVersion = 1; operation = 'save'; event = 'filename'; exactDestinationReadBack = $true })
        $proof.phase = 'save'
        $proof['saveFocus'] = Set-DialogControlFocus $saveButton.element
        Assert-DialogIdentity
        if ($filename.pattern.Current.Value -cne $request.destination) {
            throw 'The selected destination changed when focus moved to Save.'
        }
        $proof.filename['exactDestinationAfterFocusChange'] = $true
        if (-not $saveButton.element.Current.IsEnabled -or $saveButton.element.Current.IsOffscreen -or
            -not $saveButton.element.Current.HasKeyboardFocus -or
            $saveButton.element.Current.ProcessId -ne $identity.processId -or $saveButton.element.Current.Name -cne 'Save' -or
            (Test-Path -LiteralPath $request.destination)) { throw 'The original fresh-file Save action is no longer valid.' }
        $proof['saveButton'] = Get-ControlSummary $saveButton.element
        $saveButton.pattern.Invoke()
        while ($null -ne (Get-SaveDialog)) { Start-Sleep -Milliseconds 150 }
        Assert-ProcessIdentity
        $newWindows = @(Get-TargetWindows | Where-Object { (Get-RuntimeKey $_) -cnotin $baselineWindows })
        if ($newWindows.Count -ne 0) { throw 'An unexpected native window remained after the Save action.' }
        $proof['dialogClosed'] = $true
        $proof['invokePattern'] = $true
        $proof['scope'] = 'Fresh-file native Save As only; cancellation and overwrite confirmations are not automated.'
        $proof.ok = $true
    }
    $proof.phase = 'complete'
    $exitCode = 0
} catch {
    $message = $_.Exception.Message
    $proof['error'] = [ordered]@{ code = $failureCode; message = $message.Substring(0, [Math]::Min(1000, $message.Length)) }
} finally {
    if ($null -ne $targetProcess) { $targetProcess.Dispose() }
}
Write-Protocol $proof
exit $exitCode
