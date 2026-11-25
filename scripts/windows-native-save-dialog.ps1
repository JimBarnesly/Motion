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
    # process/title match. No desktop-wide keys, coordinates, or descendant scan.
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
        enabled = $current.IsEnabled
        offscreen = $current.IsOffscreen
        keyboardFocusable = $current.IsKeyboardFocusable
        hasKeyboardFocus = $current.HasKeyboardFocus
    }
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
        # The 9444028 fixture read back its new edit text, but GetResult still
        # returned the original default filename. Follow the documented UIA
        # focus-before-SetValue sequence, then move focus explicitly to Save.
        # The actual destination's saved bytes remain the acceptance authority.
        $proof['filenameFocus'] = Set-DialogControlFocus $filename.element
        $filename.pattern.SetValue($request.destination)
        Assert-DialogIdentity
        if ($filename.pattern.Current.Value -cne $request.destination -or $filename.pattern.Current.IsReadOnly -or
            -not $filename.element.Current.IsEnabled -or $filename.element.Current.ProcessId -ne $identity.processId) {
            throw 'The selected filename did not exactly retain the requested destination.'
        }
        $proof['filename'] = [ordered]@{ observedControlMatched = $true;
            originalValue = $originalValue.Substring(0, [Math]::Min(256, $originalValue.Length)); exactDestinationReadBack = $true;
            valuePattern = $true; control = Get-ControlSummary $filename.element }
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
