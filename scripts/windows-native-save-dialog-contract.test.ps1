#requires -Version 5.1
# Parse/compile the exact driver and test its pure encoding/ABI and identity helpers.
# No UI Automation, user32 call, window action or keyboard event is executed.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$file = Join-Path $PSScriptRoot 'windows-native-save-dialog.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
if (@($errors).Count -ne 0) { throw ($errors | Out-String) }
[void][scriptblock]::Create($ast.Extent.Text)
$definitions = @($ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
    $node.Value.Contains('public static class MotionDialogKeyboard')
}, $true))
if ($definitions.Count -ne 1) { throw 'Expected the one source-bound keyboard implementation.' }
if ($PSVersionTable.PSVersion.Major -ge 7) { Add-Type -TypeDefinition $definitions[0].Value -CompilerOptions '/langversion:5' }
else { Add-Type -TypeDefinition $definitions[0].Value }
[MotionDialogKeyboard]::AssertLayouts()
$checks = [Collections.Generic.List[string]]::new()
$checks.Add('PowerShell parse and scriptblock creation without executing the driver')
$checks.Add('Source-bound C# compiles with C# 5-compatible syntax')
$checks.Add('x64 INPUT, union offset, KEYBDINPUT, MOUSEINPUT, HARDWAREINPUT and GUITHREADINFO ABI sizes')
function Assert-Equal($Actual, $Expected, [string]$Label) {
    if ($Actual -cne $Expected) { throw "$Label mismatch: $Actual != $Expected" }
}
function Check-Inputs([string]$Text) {
    $inputs = [MotionDialogKeyboard]::BuildInputs($Text)
    Assert-Equal $inputs.Length (4 + $Text.Length * 2) 'Input count'
    $keys = @(0x11, 0x41, 0x41, 0x11)
    $flags = @(0, 0, 2, 2)
    for ($index = 0; $index -lt 4; $index++) {
        Assert-Equal $inputs[$index].data.keyboard.virtualKey $keys[$index] 'Control+A ordering'
        Assert-Equal $inputs[$index].data.keyboard.flags $flags[$index] 'Control+A releases'
        Assert-Equal $inputs[$index].data.keyboard.scan 0 'Control+A scan'
    }
    for ($index = 0; $index -lt $inputs.Length; $index++) {
        Assert-Equal $inputs[$index].type 1 'Keyboard event type'
        Assert-Equal $inputs[$index].data.keyboard.time 0 'Timestamp'
        Assert-Equal $inputs[$index].data.keyboard.extra ([UIntPtr]::Zero) 'Extra pointer'
    }
    for ($index = 0; $index -lt $Text.Length; $index++) {
        foreach ($up in @(0, 1)) {
            $event = $inputs[4 + $index * 2 + $up].data.keyboard
            Assert-Equal $event.virtualKey 0 'Unicode virtual key'
            Assert-Equal $event.scan ([System.UInt16][char]$Text[$index]) 'Exact UTF-16 code unit'
            Assert-Equal $event.flags (4 + $up * 2) 'Unicode down/up ordering'
        }
    }
    return ,$inputs
}
[void](Check-Inputs 'C:\Private backups\Saved notebook proof.json')
$checks.Add('Fresh filename with spaces emits one ordered Ctrl+A and exact Unicode batch')
[void](Check-Inputs ('C:\' + [char]0x65e5 + [char]0x672c + [char]0x8a9e + '\' +
    [char]0xd83c + [char]0xdf0a + ' r' + [char]0xe9 + 'sum' + [char]0xe9 + '.json'))
$checks.Add('Non-ASCII and surrogate-pair code units are preserved without normalization')
[void](Check-Inputs ('a' * 8192))
$checks.Add('Maximum bounded input is accepted')
foreach ($bad in @('', $null, ('a' * 8193), "a`nb", "a`tb", ('a' + [char]0 + 'b'))) {
    $rejected = $false
    try { [void][MotionDialogKeyboard]::BuildInputs($bad) } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid text was not rejected.' }
}
$checks.Add('Empty, null, oversized and control-character text is rejected before native input')
$inputs = [MotionDialogKeyboard]::BuildInputs('ab')
foreach ($case in @(
    @{ count = 0; keys = @(); scans = @(); flags = @() },
    @{ count = 1; keys = @(0x11); scans = @(0); flags = @(2) },
    @{ count = 2; keys = @(0x41, 0x11); scans = @(0, 0); flags = @(2, 2) },
    @{ count = 3; keys = @(0x11); scans = @(0); flags = @(2) },
    @{ count = 4; keys = @(); scans = @(); flags = @() },
    @{ count = 5; keys = @(0); scans = @(97); flags = @(6) },
    @{ count = 6; keys = @(); scans = @(); flags = @() },
    @{ count = 7; keys = @(0); scans = @(98); flags = @(6) },
    @{ count = 8; keys = @(); scans = @(); flags = @() }
)) {
    $release = [MotionDialogKeyboard]::PendingKeyUps($inputs, $case.count)
    Assert-Equal $release.Length $case.keys.Count 'Pending release count'
    for ($index = 0; $index -lt $release.Length; $index++) {
        Assert-Equal $release[$index].data.keyboard.virtualKey $case.keys[$index] 'Pending release key'
        Assert-Equal $release[$index].data.keyboard.scan $case.scans[$index] 'Pending release scan'
        Assert-Equal $release[$index].data.keyboard.flags $case.flags[$index] 'Pending release flags'
    }
}
$checks.Add('Every partial-prefix case releases only a pending key; completed batch emits no cleanup')
$rejected = $false
try { [void][MotionDialogKeyboard]::PendingKeyUps($inputs, 9) } catch { $rejected = $true }
if (-not $rejected) { throw 'Impossible insertion count was not rejected.' }
$checks.Add('Out-of-bounds insertion count is rejected')
foreach ($name in @('Get-IdentityDifferences', 'Get-DialogDecision')) {
    $functions = @($ast.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true))
    if ($functions.Count -ne 1) { throw "Expected the one source-bound $name helper." }
    . ([scriptblock]::Create($functions[0].Extent.Text))
}
$checks.Add('Identity and readiness contracts execute the exact pure driver functions without UI Automation')
function New-DialogState {
    return [ordered]@{ processId = 2904; nativeWindowHandle = 66180; runtimeId = '42,66180';
        title = 'Save verified Motion backup'; enabled = $true; offscreen = $false }
}
$expected = New-DialogState
$retained = New-DialogState
$found = New-DialogState
$decision = Get-DialogDecision $expected $retained @($found) 0
Assert-Equal $decision.action 'ready' 'Exact retained and found dialog'
Assert-Equal $decision.rejectedFields.Count 0 'No rejected exact identity fields'
Assert-Equal $decision.pendingReadiness.Count 0 'No pending exact readiness fields'
$checks.Add('An exact ready retained dialog and independently found match are accepted')
$decision = Get-DialogDecision $expected $retained @() 0
Assert-Equal $decision.action 'reject-identity' 'Missing found dialog'
Assert-Equal $decision.rejectedFields[0].source 'found' 'Missing match source'
Assert-Equal $decision.rejectedFields[0].field 'count' 'Missing match field'
Assert-Equal $decision.rejectedFields[0].actual 0 'Missing match observation'
$checks.Add('A missing independently found dialog is rejected immediately')
$decision = Get-DialogDecision $expected $retained @($found, $found) 0
Assert-Equal $decision.action 'reject-identity' 'Ambiguous found dialog'
Assert-Equal $decision.rejectedFields[0].actual 2 'Ambiguous match observation'
$checks.Add('Ambiguous independently found dialogs are rejected immediately')
$changedValues = [ordered]@{ processId = 2905; nativeWindowHandle = 66181; runtimeId = '42,66181'; title = 'Save verified Motion backup ' }
foreach ($field in $changedValues.Keys) {
    $changed = New-DialogState
    $changed[$field] = $changedValues[$field]
    $changed.enabled = $false
    $decision = Get-DialogDecision $expected $changed @($found) 0
    Assert-Equal $decision.action 'reject-identity' ('Changed retained ' + $field)
    Assert-Equal $decision.rejectedFields.Count 1 'One retained identity change'
    Assert-Equal $decision.rejectedFields[0].source 'retained' 'Retained rejection source'
    Assert-Equal $decision.rejectedFields[0].field $field 'Retained rejection field'
    Assert-Equal $decision.rejectedFields[0].expected $expected[$field] 'Retained expected identity'
    Assert-Equal $decision.rejectedFields[0].actual $changedValues[$field] 'Retained actual identity'
    Assert-Equal $decision.pendingReadiness[0].field 'enabled' 'Readiness cannot hide identity change'
}
$checks.Add('Every retained PID, HWND, runtime ID and exact title change rejects even while disabled')
foreach ($field in $changedValues.Keys) {
    $changed = New-DialogState
    $changed[$field] = $changedValues[$field]
    $changed.offscreen = $true
    $decision = Get-DialogDecision $expected $retained @($changed) 0
    Assert-Equal $decision.action 'reject-identity' ('Changed found ' + $field)
    Assert-Equal $decision.rejectedFields.Count 1 'One found identity change'
    Assert-Equal $decision.rejectedFields[0].source 'found[0]' 'Found rejection source'
    Assert-Equal $decision.rejectedFields[0].field $field 'Found rejection field'
    Assert-Equal $decision.rejectedFields[0].actual $changedValues[$field] 'Found actual identity'
}
$checks.Add('Every found PID, HWND, runtime ID and exact title change rejects without reselection')
$allChanged = New-DialogState
foreach ($field in $changedValues.Keys) { $allChanged[$field] = $changedValues[$field] }
$decision = Get-DialogDecision $expected $allChanged @($allChanged) 0
Assert-Equal $decision.rejectedFields.Count 8 'All retained and found identity changes retained'
Assert-Equal (@($decision.rejectedFields | Where-Object { $_.source -ceq 'retained' }).Count) 4 'All retained differences'
Assert-Equal (@($decision.rejectedFields | Where-Object { $_.source -ceq 'found[0]' }).Count) 4 'All found differences'
$checks.Add('Diagnostics retain every rejected field separately for retained and found observations')
foreach ($source in @('retained', 'found[0]')) {
    foreach ($field in @('enabled', 'offscreen')) {
        $pendingRetained = New-DialogState
        $pendingFound = New-DialogState
        if ($source -ceq 'retained') { $pendingRetained[$field] = -not $expected[$field] }
        else { $pendingFound[$field] = -not $expected[$field] }
        $decision = Get-DialogDecision $expected $pendingRetained @($pendingFound) 2999
        Assert-Equal $decision.action 'wait-readiness' 'Authenticated transient readiness'
        Assert-Equal $decision.rejectedFields.Count 0 'No identity waiver is needed'
        Assert-Equal $decision.pendingReadiness.Count 1 'One pending readiness field'
        Assert-Equal $decision.pendingReadiness[0].source $source 'Pending observation source'
        Assert-Equal $decision.pendingReadiness[0].field $field 'Pending observation field'
    }
}
$checks.Add('Only boolean enabled/offscreen state of exact retained and found identities may wait')
Assert-Equal (Get-DialogDecision $expected $retained @($found) 2999).action 'ready' 'Ready before deadline'
foreach ($elapsed in @(3000, 3001, 60000)) {
    Assert-Equal (Get-DialogDecision $expected $retained @($found) $elapsed).action 'readiness-timeout' 'Late ready state'
    $pending = New-DialogState; $pending.enabled = $false
    Assert-Equal (Get-DialogDecision $expected $pending @($found) $elapsed).action 'readiness-timeout' 'Late pending state'
}
$checks.Add('The 3000ms readiness deadline rejects pending and newly ready observations at or after expiry')
foreach ($source in @('retained', 'found[0]')) {
    foreach ($field in @('enabled', 'offscreen')) {
        $invalidRetained = New-DialogState
        $invalidFound = New-DialogState
        if ($source -ceq 'retained') { $invalidRetained[$field] = 'false' }
        else { $invalidFound[$field] = 0 }
        $decision = Get-DialogDecision $expected $invalidRetained @($invalidFound) 0
        Assert-Equal $decision.action 'reject-state' 'Non-boolean readiness'
        Assert-Equal $decision.invalidReadiness[0].source $source 'Invalid readiness source'
        Assert-Equal $decision.invalidReadiness[0].field $field 'Invalid readiness field'
    }
}
$checks.Add('Non-boolean readiness fails immediately with its exact field and observation source')
$rejected = $false
try { [void](Get-DialogDecision $expected $retained @($found) -1) } catch { $rejected = $true }
if (-not $rejected) { throw 'Negative readiness elapsed time was accepted.' }
$checks.Add('Invalid negative readiness time is rejected')
$processExpected = [ordered]@{ processId = 2904; sessionId = 2; startTimeFileTimeUtc = '134400991300235289'; executablePath = 'D:\Motion installed\motion-desktop.exe' }
$processActual = [ordered]@{ processId = 2905; sessionId = 3; startTimeFileTimeUtc = '134400991300235290'; executablePath = 'D:\Other\motion-desktop.exe' }
$changes = @(Get-IdentityDifferences $processExpected $processActual @('processId', 'sessionId', 'startTimeFileTimeUtc', 'executablePath') 'process')
Assert-Equal $changes.Count 4 'All process identity changes'
foreach ($change in $changes) {
    Assert-Equal $change.source 'process' 'Process observation source'
    Assert-Equal $change.expected $processExpected[$change.field] 'Expected process field'
    Assert-Equal $change.actual $processActual[$change.field] 'Actual process field'
}
$checks.Add('Process PID, session, creation generation and executable differences all remain visible')
$processActual = [ordered]@{ processId = 2904; sessionId = 2; startTimeFileTimeUtc = '134400991300235289'; executablePath = 'd:\MOTION INSTALLED\MOTION-DESKTOP.EXE' }
Assert-Equal (@(Get-IdentityDifferences $processExpected $processActual @('processId', 'sessionId', 'startTimeFileTimeUtc', 'executablePath') 'process').Count) 0 'Existing case-insensitive executable identity'
$titleCase = New-DialogState; $titleCase.title = $titleCase.title.ToUpperInvariant()
Assert-Equal (Get-DialogDecision $expected $titleCase @($found) 0).action 'reject-identity' 'Exact title casing retained'
$checks.Add('Only executable path casing is normalized; dialog title casing and whitespace stay exact')
if ($ast.Extent.Text -match '\.SetValue\s*\(') { throw 'ValuePattern mutation remains in driver.' }
if ([regex]::Matches($ast.Extent.Text, '\$saveButton\.pattern\.Invoke\(\)').Count -ne 1) { throw 'Expected exactly one Save Invoke.' }
if ([regex]::Matches($ast.Extent.Text, '\[MotionDialogKeyboard\]::Enter\(').Count -ne 1) { throw 'Expected exactly one keyboard batch invocation.' }
$checks.Add('No ValuePattern.SetValue remains and exactly one Save Invoke remains')
[ordered]@{ schemaVersion = 1; status = 'passed'; source = $file; sourceSha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();
    checks = $checks.ToArray(); count = $checks.Count; nativeInputExecuted = $false;
    powerShellMajor = $PSVersionTable.PSVersion.Major; powerShellMinor = $PSVersionTable.PSVersion.Minor; powerShellEdition = $PSVersionTable.PSEdition;
    limitation = 'Portable source/ABI/builder/decision validation only. UI Automation readiness, foreground focus, SendInput and saved-file success are not exercised by this contract; installed GUI acceptance must prove them.' } | ConvertTo-Json -Depth 5
