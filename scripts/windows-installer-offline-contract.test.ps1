#requires -Version 5.1
# Semantic helper tests only. No firewall/task mutation or network canary runs.
param([switch] $Portable)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($env:OS -ceq 'Windows_NT'){$env:PSModulePath=[IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\v1.0\Modules')}
$checks=[Collections.Generic.List[string]]::new()
function Check([bool]$Condition,[string]$Name){if(-not $Condition){throw "Failed: $Name"};$checks.Add($Name)}
function Reject([scriptblock]$Action,[string]$Name){$rejected=$false;try{& $Action}catch{$rejected=$true};Check $rejected $Name}
$windowPath=Join-Path $PSScriptRoot 'windows-installer-offline-window.ps1'
$guardPath=Join-Path $PSScriptRoot 'windows-installer-offline-watchdog.ps1'
$windowAst=$null
foreach($source in @($windowPath,$guardPath)){
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
    Check (@($errors).Count -eq 0) ('parse '+[IO.Path]::GetFileName($source))
    if($source -ceq $windowPath){$windowAst=$ast}
}
. $guardPath -FunctionsOnly
Check (Test-OfflineDeadline 0) 'new window is within deadline'
Check (Test-OfflineDeadline 239.999) 'pre-deadline completion is eligible'
Check (-not (Test-OfflineDeadline 240)) 'exact deadline rejects completion'
Check (-not (Test-OfflineDeadline 241)) 'late completion is rejected'
Reject { Test-OfflineDeadline ([double]::NaN) } 'non-finite deadline is rejected'
Reject { Test-OfflineDeadline -1 } 'negative deadline is rejected'
$declarations=@($windowAst.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Add-Type'},$true))
Check ($declarations.Count -eq 1) 'one bounded-process declaration'
$sourceText=$declarations[0].CommandElements[2].Value
if($PSVersionTable.PSVersion.Major -ge 7){Add-Type -TypeDefinition $sourceText -CompilerOptions '/langversion:5'}
else{Add-Type -TypeDefinition $sourceText}
Check ([MotionOfflineJob]::LayoutsCorrect()) 'SDK job layouts match the supported x64 ABI'
Check ([MotionOfflineCanary]::ClassifyRetainedFailure([TimeoutException]::new(),0) -ceq 'no-response-before-deadline') 'zero-response transport timeout is distinguished'
Reject { [MotionOfflineCanary]::ClassifyRetainedFailure([TimeoutException]::new(),1) } 'partial reply followed by timeout cannot prove blocked traffic'
Reject { [MotionOfflineCanary]::ClassifyRetainedFailure([IO.InvalidDataException]::new('HTTP error response'),12) } 'received HTTP error cannot prove blocked traffic'
Reject { [MotionOfflineCanary]::ClassifyRetainedFailure([IO.InvalidDataException]::new(),0) } 'protocol failure is never classified as blocked'
Reject { [MotionOfflineCanary]::ClassifyRetainedFailure([IO.IOException]::new(),1) } 'partial reply followed by termination cannot prove blocked traffic'
$node=(Get-Command node -CommandType Application -ErrorAction Stop).Source
$child=$null;$retained=$null
try{
    $child=[MotionOfflineProcess]::new($node,'-e "process.stdout.write(''ok'');process.stderr.write(''err'')"',$PSScriptRoot)
    Check ($child.Process.WaitForExit(5000)) 'controlled child exits'
    $capture=$child.Finish()
    Check ($capture.ExitCode -eq 0 -and $capture.Stdout -ceq 'ok' -and $capture.Stderr -ceq 'err') 'bounded capture preserves actual output'
    $child.Dispose();$child=$null
    $child=[MotionOfflineProcess]::new($node,'-e "process.stdout.write(''x''.repeat(70000));setInterval(()=>{},1000)"',$PSScriptRoot)
    Check ($child.Process.WaitForExit(5000)) 'excess-output child is terminated'
    Check $child.OutputExceeded 'combined output bound is enforced'
    Reject { $child.Finish() } 'truncated child cannot produce success'
    $child.Dispose();$child=$null
    $child=[MotionOfflineProcess]::new($node,'-e "setInterval(()=>{},1000)"',$PSScriptRoot)
    $retained=[Diagnostics.Process]::GetProcessById($child.Process.Id);[void]$retained.Handle
    $clock=[Diagnostics.Stopwatch]::StartNew();$child.Dispose();$child=$null
    Check ($retained.WaitForExit(1000) -and $clock.Elapsed.TotalSeconds -lt 7) 'disposal terminates the exact owned child within its bound'
}finally{if($null -ne $child){$child.Dispose()};if($null -ne $retained){$retained.Dispose()}}
$bootstrapNodes=@($windowAst.FindAll({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.StartsWith("import { pathToFileURL } from 'node:url';",[StringComparison]::Ordinal)},$true))
Check ($bootstrapNodes.Count -eq 1) 'the exact production bootstrap is available for gate tests'
$gateDirectory=[IO.Path]::Combine([IO.Path]::GetTempPath(),('motion-offline-gate-test-'+[Guid]::NewGuid().ToString('N')))
if(Test-Path -LiteralPath $gateDirectory){throw 'Gate test path collision.'}
[void][IO.Directory]::CreateDirectory($gateDirectory)
$bootstrap=[IO.Path]::Combine($gateDirectory,'bootstrap.mjs')
$module=[IO.Path]::Combine($gateDirectory,'controller.mjs')
$marker=[IO.Path]::Combine($gateDirectory,'marker.json')
$jobOwnerScript=[IO.Path]::Combine($gateDirectory,'job-owner.ps1')
$jobChecks='not-run-portable'
$parentHandle=$null;$descendantHandle=$null;$jobOwner=$null
try{
    [IO.File]::WriteAllText($bootstrap,$bootstrapNodes[0].Value,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($module,"import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./marker.json', import.meta.url), 'unexpected import');",[Text.UTF8Encoding]::new($false))
    $child=[MotionOfflineProcess]::new($node,('"'+$bootstrap+'" "'+$module+'"'),$gateDirectory)
    Check ($child.Process.WaitForExit(5000)) 'unreleased bootstrap exits on parent stdin EOF'
    $result=$child.Finish()
    Check ($result.ExitCode -ne 0 -and -not [IO.File]::Exists($marker)) 'EOF never imports the callback controller'
    $child.Dispose();$child=$null
    if(-not $Portable){
        Assert-OfflineHost
        $payload=@'
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
writeFileSync(new URL('./marker.json', import.meta.url), JSON.stringify({parent:process.pid,child:child.pid}));
setInterval(()=>{},1000);
'@
        [IO.File]::WriteAllText($module,$payload,[Text.UTF8Encoding]::new($false))
        $child=[MotionOfflineProcess]::new($node,('"'+$bootstrap+'" "'+$module+'"'),$gateDirectory,$true)
        $clock=[Diagnostics.Stopwatch]::StartNew()
        while(-not [IO.File]::Exists($marker) -and -not $child.Process.HasExited -and $clock.Elapsed.TotalSeconds -lt 5){Start-Sleep -Milliseconds 25}
        Check ([IO.File]::Exists($marker)) 'assigned callback crosses its gate and starts a descendant'
        $ids=ConvertFrom-Json ([IO.File]::ReadAllText($marker))
        Check ($ids.parent -eq $child.Process.Id -and $ids.child -gt 0 -and $ids.child -ne $ids.parent) 'observed descendant is from the gated callback'
        $parentHandle=[Diagnostics.Process]::GetProcessById($ids.parent);[void]$parentHandle.Handle
        $descendantHandle=[Diagnostics.Process]::GetProcessById($ids.child);[void]$descendantHandle.Handle
        Check ($descendantHandle.StartTime -ge $parentHandle.StartTime) 'descendant generation follows its parent'
        $child.Dispose()
        Check ($child.GroupCleanupConfirmed -and $parentHandle.WaitForExit(1000) -and $descendantHandle.WaitForExit(1000)) 'callback Job termination confirms both parent and descendant exit'
        $child=$null
        $parentHandle.Dispose();$parentHandle=$null;$descendantHandle.Dispose();$descendantHandle=$null
        [IO.File]::Delete($marker)
        $ownerSource=@'
param([string]$Source,[string]$Node,[string]$Bootstrap,[string]$Controller)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$env:PSModulePath=[IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\v1.0\Modules')
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'Source parsing failed'}
$declarations=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Add-Type'},$true))
if($declarations.Count -ne 1){throw 'Unexpected helper declaration'}
Add-Type -TypeDefinition $declarations[0].CommandElements[2].Value
$owned=$null
try{
  $owned=[MotionOfflineProcess]::new($Node,('"'+$Bootstrap+'" "'+$Controller+'"'),[IO.Path]::GetDirectoryName($Bootstrap),$true)
  Start-Sleep -Seconds 20
}finally{if($null -ne $owned){$owned.Dispose()}}
'@
        [IO.File]::WriteAllText($jobOwnerScript,$ownerSource,[Text.UTF8Encoding]::new($false))
        $jobOwner=[Diagnostics.Process]::new()
        $shell=[IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\v1.0\powershell.exe')
        $jobOwner.StartInfo=[Diagnostics.ProcessStartInfo]::new($shell,('-NoLogo -NoProfile -NonInteractive -File "'+$jobOwnerScript+'" -Source "'+$windowPath+'" -Node "'+$node+'" -Bootstrap "'+$bootstrap+'" -Controller "'+$module+'"'))
        $jobOwner.StartInfo.UseShellExecute=$false;$jobOwner.StartInfo.CreateNoWindow=$true
        Check ($jobOwner.Start()) 'independent callback Job owner starts'
        $clock=[Diagnostics.Stopwatch]::StartNew()
        while(-not [IO.File]::Exists($marker) -and -not $jobOwner.HasExited -and $clock.Elapsed.TotalSeconds -lt 10){Start-Sleep -Milliseconds 25}
        Check ([IO.File]::Exists($marker)) 'independent owner assigns and releases its callback'
        $ids=ConvertFrom-Json ([IO.File]::ReadAllText($marker))
        $parentHandle=[Diagnostics.Process]::GetProcessById($ids.parent);[void]$parentHandle.Handle
        $descendantHandle=[Diagnostics.Process]::GetProcessById($ids.child);[void]$descendantHandle.Handle
        $jobOwner.Kill()
        Check ($jobOwner.WaitForExit(5000) -and $parentHandle.WaitForExit(5000) -and $descendantHandle.WaitForExit(5000)) 'abrupt coordinator death closes Job and terminates callback descendants'
        $jobChecks='passed'
    }
}finally{
    if($null -ne $child){$child.Dispose();$child=$null}
    if($null -ne $jobOwner){try{if(-not $jobOwner.HasExited){$jobOwner.Kill();[void]$jobOwner.WaitForExit(5000)}}finally{$jobOwner.Dispose()}}
    foreach($handle in @($parentHandle,$descendantHandle)){if($null -ne $handle){$handle.Dispose()}}
    foreach($file in @($bootstrap,$module,$marker,$jobOwnerScript)){if([IO.File]::Exists($file)){[IO.File]::Delete($file)}}
    [IO.Directory]::Delete($gateDirectory,$false)
}
$manifestChecks='not-run-portable'
if(-not $Portable){
    Assert-OfflineHost
    $id=[Guid]::NewGuid().ToString('N');$name="MotionInstallerOffline-$id"
    $directory=[IO.Path]::Combine($env:RUNNER_TEMP,$name)
    if(Test-Path -LiteralPath $directory){throw 'Manifest test path already exists.'}
    [void][IO.Directory]::CreateDirectory($directory)
    $path=[IO.Path]::Combine($directory,'manifest.json')
    $valid=[ordered]@{schemaVersion=1;fixtureId=$id;commit=$env:GITHUB_SHA;runId=$env:GITHUB_RUN_ID;root=$directory;taskName=$name;outRule="$name-Out";inRule="$name-In";selfTestRule="$name-SelfTest";
        coordinator=(Get-OfflineIdentity ([Diagnostics.Process]::GetCurrentProcess()));installerPath=[IO.Path]::Combine($directory,'fixture-setup.exe');callbackPath=$node;watchdogSha256=('0'*64);maxSeconds=240}
    try{
        Write-OfflineJson $path $valid
        $read=Read-OfflineManifest $path
        Check ($read.fixtureId -ceq $id -and $read.outRule -ceq "$name-Out") 'valid manifest retains exact owned identities'
        $hashBefore=Get-OfflineHash $path
        Reject { Write-OfflineJson $path $valid } 'evidence publication refuses overwrite'
        Check ((Get-OfflineHash $path) -ceq $hashBefore) 'refused overwrite preserves original bytes'
        foreach($case in @('foreign-rule','foreign-task','foreign-root','extra-field','deadline-extension','foreign-coordinator')){
            $value=ConvertFrom-Json (ConvertTo-Json $valid -Depth 6)
            switch($case){
                'foreign-rule'{$value.outRule='An unrelated existing rule'}
                'foreign-task'{$value.taskName='An unrelated existing task'}
                'foreign-root'{$value.root=$env:RUNNER_TEMP}
                'extra-field'{$value|Add-Member -NotePropertyName command -NotePropertyValue 'untrusted'}
                'deadline-extension'{$value.maxSeconds=86400}
                'foreign-coordinator'{$value.coordinator.path=$node}
            }
            [IO.File]::WriteAllText($path,(ConvertTo-Json $value -Depth 6),[Text.UTF8Encoding]::new($false))
            Reject { Read-OfflineManifest $path } ("reject $case before cleanup")
        }
        [IO.File]::WriteAllText($path,('x'*131073),[Text.UTF8Encoding]::new($false))
        Reject { Read-OfflineJson $path } 'oversized manifest is rejected before parsing'
        $manifestChecks='passed'
    }finally{
        foreach($owned in @($path,"$path.pending")){if([IO.File]::Exists($owned)){[IO.File]::Delete($owned)}}
        [IO.Directory]::Delete($directory,$false)
    }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject ([ordered]@{schemaVersion=1;status='passed';checks=$checks.ToArray();manifestChecks=$manifestChecks;jobChecks=$jobChecks;networkPolicyOrCanaryExecuted=$false}) -Depth 4 -Compress))
