#requires -Version 5.1
# Source-bound pure identity/readiness decisions only. No installer, UIA or
# window action is executed by this contract.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$source = Join-Path $PSScriptRoot 'windows-installer-license-dialog.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if (@($errors).Count -ne 0) { throw ($errors | Out-String) }
[void][scriptblock]::Create($ast.Extent.Text)
foreach ($name in @('Identity-Differences', 'Dialog-Decision')) {
    $definitions = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw 'Expected one source-bound pure decision function.' }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
$checks = [Collections.Generic.List[string]]::new()
function Check([bool] $Condition, [string] $Name) { if (-not $Condition) { throw "Failed: $Name" }; $checks.Add($Name) }
function Reject([scriptblock] $Action, [string] $Name) {
    $rejected = $false
    try { [void](& $Action) } catch { $rejected = $true }
    Check $rejected $Name
}
function Copy-Record($Value) { $copy = [ordered]@{}; foreach ($key in $Value.Keys) { $copy[$key] = $Value[$key] }; return $copy }
$welcome = [ordered]@{ processId = 101; nativeWindowHandle = 202; runtimeId = '42,202'; name = 'Motion Setup'; enabled = $true; offscreen = $false }
$license = Copy-Record $welcome; $license.name = 'Motion Setup '
Check ((Dialog-Decision $welcome $welcome 0).action -ceq 'ready') 'Exact Welcome identity is ready'
Check ((Dialog-Decision $license $license 0).action -ceq 'ready') 'Exact NSIS licence title includes one trailing ASCII space'
$decision = Dialog-Decision $license $welcome 0 'Motion Setup'
Check ($decision.action -ceq 'wait' -and $decision.rejectedFields.Count -eq 0 -and
    $decision.pendingReadiness.Count -eq 1 -and $decision.pendingReadiness[0].field -ceq 'name' -and
    $decision.pendingReadiness[0].actual -ceq 'Motion Setup' -and $decision.pendingReadiness[0].expected -ceq 'Motion Setup ') 'Old title is wait-only during the explicit Next transition'
Check ((Dialog-Decision $license $welcome 0).action -ceq 'reject-identity') 'Old title is rejected after the transition'
foreach ($name in @(' Motion Setup', 'Motion Setup  ', 'motion setup ', 'Motion Setup: Other', "Motion Setup`t")) {
    $actual = Copy-Record $license; $actual.name = $name
    $decision = Dialog-Decision $license $actual 0 'Motion Setup'
    Check ($decision.action -ceq 'reject-identity' -and $decision.rejectedFields[0].field -ceq 'name') ('No title trimming or broad matching: ' + ($name | ConvertTo-Json -Compress))
}
Reject { Dialog-Decision $license $welcome 0 'Unrelated installer' } 'An arbitrary previous title is rejected'
Reject { Dialog-Decision $welcome $welcome 0 'Motion Setup' } 'The caption exception cannot apply to Welcome'
foreach ($field in @('processId', 'nativeWindowHandle', 'runtimeId')) {
    $actual = Copy-Record $license; $actual[$field] = if ($field -ceq 'runtimeId') { '42,999' } else { 999 }
    $actual.enabled = $false
    $decision = Dialog-Decision $license $actual 0 'Motion Setup'
    Check ($decision.action -ceq 'reject-identity' -and $decision.rejectedFields.Count -eq 1 -and
        $decision.rejectedFields[0].field -ceq $field) ('Changed ' + $field + ' rejects immediately even when readiness is pending')
}
$actual = Copy-Record $license
$actual.processId = 999; $actual.nativeWindowHandle = 998; $actual.runtimeId = '42,998'; $actual.name = 'Other Setup'
$decision = Dialog-Decision $license $actual 0
Check ($decision.action -ceq 'reject-identity' -and ($decision.rejectedFields.field -join ',') -ceq 'processId,nativeWindowHandle,runtimeId,name' -and
    $decision.rejectedFields[1].expected -eq 202 -and $decision.rejectedFields[1].actual -eq 998) 'All rejected identity fields retain their expected and actual values'
foreach ($field in @('enabled', 'offscreen')) {
    $actual = Copy-Record $license; $actual[$field] = -not $license[$field]
    $decision = Dialog-Decision $license $actual 0
    Check ($decision.action -ceq 'wait' -and $decision.rejectedFields.Count -eq 0 -and
        $decision.pendingReadiness.Count -eq 1 -and $decision.pendingReadiness[0].field -ceq $field) ('Only authenticated ' + $field + ' readiness may wait')
}
$actual = Copy-Record $license; $actual.enabled = $false; $actual.offscreen = $true
$decision = Dialog-Decision $license $actual 2999
Check ($decision.action -ceq 'wait' -and ($decision.pendingReadiness.field -join ',') -ceq 'enabled,offscreen') 'Both transient readiness fields are retained before the deadline'
Check ((Dialog-Decision $license $license 2999).action -ceq 'ready') 'Ready just before the deadline is accepted'
Check ((Dialog-Decision $license $license 3000).action -ceq 'readiness-timeout') 'A ready observation at the exact deadline cannot pass'
Check ((Dialog-Decision $license $actual 3001).action -ceq 'readiness-timeout') 'Readiness after the deadline is rejected'
Check ((Dialog-Decision $license $welcome 3000 'Motion Setup').action -ceq 'readiness-timeout') 'The old transition title cannot wait beyond the deadline'
Reject { Dialog-Decision $license $license -1 } 'Negative elapsed time is rejected'
$actual = Copy-Record $license; $actual.enabled = 'true'
Reject { Dialog-Decision $license $actual 0 } 'An unavailable or mistyped readiness observation cannot wait'
$process = [ordered]@{ processId = 101; sessionId = 2; startTimeFileTimeUtc = '134400973281209115'; executablePath = 'D:\Motion\setup.exe' }
$fields = @('processId', 'sessionId', 'startTimeFileTimeUtc', 'executablePath')
$actualProcess = Copy-Record $process; $actualProcess.executablePath = 'd:\motion\SETUP.exe'
Check (@(Identity-Differences $process $actualProcess $fields).Count -eq 0) 'Executable spelling preserves the existing Windows case-insensitive rule'
foreach ($field in $fields) {
    $actualProcess = Copy-Record $process
    $actualProcess[$field] = switch ($field) { 'executablePath' { 'D:\Other\setup.exe' }; 'startTimeFileTimeUtc' { '134400973281209116' }; default { 999 } }
    $changes = @(Identity-Differences $process $actualProcess $fields)
    Check ($changes.Count -eq 1 -and $changes[0].field -ceq $field -and $changes[0].expected -ceq $process[$field]) ('Changed process ' + $field + ' remains an identity rejection')
}
[ordered]@{ schemaVersion = 1; status = 'passed'; source = $source;
    sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant();
    checks = $checks.ToArray(); count = $checks.Count; nativeUiExecuted = $false; installerStarted = $false;
    powerShellMajor = $PSVersionTable.PSVersion.Major; powerShellMinor = $PSVersionTable.PSVersion.Minor; powerShellEdition = $PSVersionTable.PSEdition;
    limitation = 'Pure source-bound decisions only. Actual retained-window transitions, displayed licence and cancellation remain installed Windows acceptance requirements.'
} | ConvertTo-Json -Depth 5 -Compress
