#requires -Version 5.1
# Parse/compile the exact driver and test only its pure encoding/ABI helpers.
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
if ($ast.Extent.Text -match '\.SetValue\s*\(') { throw 'ValuePattern mutation remains in driver.' }
if ([regex]::Matches($ast.Extent.Text, '\$saveButton\.pattern\.Invoke\(\)').Count -ne 1) { throw 'Expected exactly one Save Invoke.' }
$checks.Add('No ValuePattern.SetValue remains and exactly one Save Invoke remains')
[ordered]@{ schemaVersion = 1; status = 'passed'; source = $file; sourceSha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();
    checks = $checks.ToArray(); count = $checks.Count; nativeInputExecuted = $false;
    powerShellMajor = $PSVersionTable.PSVersion.Major; powerShellMinor = $PSVersionTable.PSVersion.Minor; powerShellEdition = $PSVersionTable.PSEdition;
    limitation = 'Portable source/ABI/builder validation only. Foreground focus, SendInput and saved-file success are not exercised by this contract; installed GUI acceptance must prove them.' } | ConvertTo-Json -Depth 5
