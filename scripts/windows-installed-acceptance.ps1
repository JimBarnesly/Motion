$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true') {
    throw 'Installed acceptance runs only on a disposable Windows GitHub Actions runner.'
}

$repositoryRoot = Split-Path $PSScriptRoot -Parent
$evidenceRoot = Join-Path $repositoryRoot 'artifacts/windows-acceptance'
New-Item -ItemType Directory -Force $evidenceRoot | Out-Null
$installers = @(Get-ChildItem (Join-Path $repositoryRoot 'apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis') -Filter '*-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected exactly one Windows installer candidate.' }
$installer = $installers[0]
$installRoot = Join-Path $env:RUNNER_TEMP 'Motion installed acceptance'
if (Test-Path $installRoot) { throw 'Acceptance destination must start empty.' }

# Authenticate the actual embedded prerequisite before executing any installer.
# Verification failure is retained as evidence, but never uploads setup.exe.
$payloadEvidence = Join-Path $evidenceRoot 'installer-payload-verification.json'
node (Join-Path $PSScriptRoot 'windows-verify-installer-payload.mjs') --installer $installer.FullName --output $payloadEvidence
if ($LASTEXITCODE -ne 0) { throw 'The embedded Windows prerequisite failed verification; installer was not executed.' }
$payloadProof = Get-Content -LiteralPath $payloadEvidence -Raw | ConvertFrom-Json
$installerHash = (Get-FileHash $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($payloadProof.schemaVersion -ne 1 -or $payloadProof.status -cne 'passed' -or
    $payloadProof.commit -cne $env:GITHUB_SHA -or $payloadProof.installer.sha256 -cne $installerHash) {
    throw 'Installer identity no longer matches its current verification evidence.'
}
if (-not $env:GITHUB_OUTPUT) { throw 'GitHub step output is unavailable for verified-candidate publication.' }
Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value 'installer_payload_verified=true' -Encoding utf8

function Invoke-WindowsAcceptanceTool([string] $ScriptName, [string[]] $Arguments, [int] $TimeoutSeconds, [int] $ExpectedExitCode = 0) {
    $powershellRoot = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path $powershellRoot 'powershell.exe'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.Environment['PSModulePath'] = Join-Path $powershellRoot 'Modules'
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-Mta', '-File', (Join-Path $PSScriptRoot $ScriptName)) + $Arguments) {
        $start.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::Start($start)
    try {
        [void]$process.Handle
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            # The offline helper's independently running SYSTEM watchdog owns
            # firewall recovery. Never kill a shared Microsoft updater service.
            $process.Kill()
            [void]$process.WaitForExit(5000)
            throw "Windows acceptance helper exceeded its outer deadline: $ScriptName"
        }
        if ($process.ExitCode -ne $ExpectedExitCode) { throw "Windows acceptance helper returned an unexpected exit code: $ScriptName ($($process.ExitCode))" }
    } finally { $process.Dispose() }
}

& (Join-Path $PSScriptRoot 'windows-webview-inventory.ps1') -OutputPath (Join-Path $evidenceRoot 'webview-before-install.json') -Phase 'before-install'
"$installerHash  $($installer.Name)" | Set-Content -Encoding utf8 (Join-Path $evidenceRoot 'SHA256SUMS.txt')

# Inspect the actual interactive agreement, then cancel before installation.
# Automated inspection is not evidence that an external user accepted terms.
$licenceEvidence = Join-Path $evidenceRoot 'installer-license-dialog.json'
Invoke-WindowsAcceptanceTool 'windows-installer-license-dialog.ps1' @(
    '-InstallerPath', $installer.FullName, '-ExpectedSha256', $installerHash,
    '-LicensePath', (Join-Path $repositoryRoot 'apps/desktop/licenses/windows/INSTALLER-LICENSE.txt'),
    '-InstallDirectory', $installRoot, '-OutputPath', $licenceEvidence
) 100
$licenceProof = Get-Content -LiteralPath $licenceEvidence -Raw | ConvertFrom-Json
if ($licenceProof.schemaVersion -ne 1 -or $licenceProof.status -cne 'passed' -or $licenceProof.commit -cne $env:GITHUB_SHA) {
    throw 'The actual installer licence page was not verified.'
}
& (Join-Path $PSScriptRoot 'windows-webview-inventory.ps1') -OutputPath (Join-Path $evidenceRoot 'webview-after-license-inspection.json') -Phase 'diagnostic'
$beforeLicence = Get-Content -LiteralPath (Join-Path $evidenceRoot 'webview-before-install.json') -Raw | ConvertFrom-Json
$afterLicence = Get-Content -LiteralPath (Join-Path $evidenceRoot 'webview-after-license-inspection.json') -Raw | ConvertFrom-Json
foreach ($field in @('registrations', 'locations')) {
    if (($beforeLicence.$field | ConvertTo-Json -Depth 8 -Compress) -cne ($afterLicence.$field | ConvertTo-Json -Depth 8 -Compress)) {
        throw 'The runtime changed during licence-page inspection; the no-install control was not established.'
    }
}
if (Test-Path -LiteralPath $installRoot) { throw 'Licence-page cancellation must leave the installation absent.' }

$application = Join-Path $installRoot 'motion-desktop.exe'
$runtime = Join-Path $installRoot 'node-runtime.exe'
$service = Join-Path $installRoot 'service-bundle.mjs'
$env:MOTION_NATIVE_HELPER = $application
$env:MOTION_TEST_NODE_BINARY = $runtime
$env:MOTION_TEST_SERVICE_BUNDLE = $service
$env:MOTION_INSTALLED_APP = $application
$env:MOTION_ACCEPTANCE_OUTPUT = $evidenceRoot
$env:MOTION_ACCEPTANCE_PHASE = 'offline-prerequisite'
$offlineEvidence = Join-Path $evidenceRoot 'installer-offline-window.json'
try {
    # First exercise recovery after a real first rule, before starting setup.
    # Exit1 is eligible only with the exact requested fault and complete cleanup.
    $faultEvidence = Join-Path $evidenceRoot 'installer-offline-fault.json'
    Invoke-WindowsAcceptanceTool 'windows-installer-offline-window.ps1' @(
        '-InstallerPath', $installer.FullName, '-InstallRoot', $installRoot,
        '-PayloadEvidencePath', $payloadEvidence, '-OutputPath', $faultEvidence,
        '-PostInstallExecutable', (Get-Command node -CommandType Application).Source,
        '-PostInstallArguments', (Join-Path $PSScriptRoot 'windows-installed-ui.mjs'),
        '-TestFault', 'after-first-rule'
    ) 180 1
    $faultProof = Get-Content -LiteralPath $faultEvidence -Raw | ConvertFrom-Json
    if ($faultProof.schemaVersion -ne 1 -or $faultProof.commit -cne $env:GITHUB_SHA -or
        $faultProof.status -cne 'failed' -or $faultProof.phase -cne 'fence' -or
        $faultProof.testFault -cne 'after-first-rule' -or $faultProof.faultReached -ne $true -or
        $faultProof.cleanupPassed -ne $true -or $faultProof.callback.completed -ne $false -or
        $faultProof.watchdog.cleanupPassed -ne $true -or $faultProof.watchdog.reason -cne 'failed' -or
        $faultProof.windowCompleted -ne $null -or (Test-Path -LiteralPath $installRoot)) {
        throw 'The real first-rule fault did not prove exact cleanup before installation.'
    }
    & (Join-Path $PSScriptRoot 'windows-webview-inventory.ps1') -OutputPath (Join-Path $evidenceRoot 'webview-after-offline-fault.json') -Phase 'diagnostic'
    $afterFault = Get-Content -LiteralPath (Join-Path $evidenceRoot 'webview-after-offline-fault.json') -Raw | ConvertFrom-Json
    foreach ($field in @('registrations', 'locations')) {
        if (($beforeLicence.$field | ConvertTo-Json -Depth 8 -Compress) -cne ($afterFault.$field | ConvertTo-Json -Depth 8 -Compress)) {
            throw 'Runtime state changed during the pre-install firewall fault control.'
        }
    }
    Invoke-WindowsAcceptanceTool 'windows-installer-offline-window.ps1' @(
        '-InstallerPath', $installer.FullName, '-InstallRoot', $installRoot,
        '-PayloadEvidencePath', $payloadEvidence, '-OutputPath', $offlineEvidence,
        '-PostInstallExecutable', (Get-Command node -CommandType Application).Source,
        '-PostInstallArguments', (Join-Path $PSScriptRoot 'windows-installed-ui.mjs')
    ) 360
} finally { $env:MOTION_ACCEPTANCE_PHASE = 'installed' }
$offlineProof = Get-Content -LiteralPath $offlineEvidence -Raw | ConvertFrom-Json
if ($offlineProof.schemaVersion -ne 1 -or $offlineProof.status -cne 'passed' -or $offlineProof.commit -cne $env:GITHUB_SHA) {
    throw 'The bounded offline installer and active-engine proof did not pass.'
}
$offlineUi = Get-Content -LiteralPath (Join-Path $evidenceRoot 'offline-prerequisite-ui.json') -Raw | ConvertFrom-Json
if ($offlineUi.schemaVersion -ne 1 -or $offlineUi.commit -cne $env:GITHUB_SHA -or $offlineUi.phase -cne 'offline-prerequisite' -or
    $offlineUi.verdict -cne 'PASS' -or @($offlineUi.activeWebView).Count -ne 1 -or $offlineUi.activeWebView[0].status -cne 'passed') {
    throw 'The actual installed engine did not complete its observation inside the offline window.'
}
& (Join-Path $PSScriptRoot 'windows-webview-inventory.ps1') -OutputPath (Join-Path $evidenceRoot 'webview-after-install.json') -Phase 'after-install'

foreach ($file in @($application, $runtime, $service, (Join-Path $installRoot 'node-runtime-LICENSE'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'An installed application resource is missing.' }
}
$runtimeVersion = (& $runtime --version).Trim()
if ($LASTEXITCODE -ne 0 -or $runtimeVersion -ne 'v24.22.3') { throw 'The installed runtime is not the pinned version.' }

$vendorRecord = Get-Content -LiteralPath (Join-Path $repositoryRoot 'docs/WINDOWS_VENDOR_RUNTIME.json') -Raw | ConvertFrom-Json
$installedNotices = @()
foreach ($notice in $vendorRecord.includedOfflineResources) {
    if ($notice.relativePath -cnotmatch '^apps/desktop/licenses/windows/[A-Za-z0-9./_-]+$' -or $notice.relativePath.Contains('..')) {
        throw 'The reviewed vendor-resource path is invalid.'
    }
    $relative = $notice.relativePath.Substring('apps/desktop/'.Length)
    $path = Join-Path $installRoot $relative
    $file = Get-Item -LiteralPath $path -Force
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $file.Length -ne $notice.bytes -or $hash -cne $notice.sha256) { throw 'An installed vendor notice differs from the reviewed original bytes.' }
    $installedNotices += [ordered]@{ path = $relative; bytes = $file.Length; sha256 = $hash }
}
if ($installedNotices.Count -ne 8) { throw 'The complete reviewed Windows notice set was not installed.' }
[ordered]@{ schemaVersion = 1; commit = $env:GITHUB_SHA; status = 'passed'; resources = $installedNotices } |
    ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $evidenceRoot 'installed-vendor-notices.json')

# Exercise a reachable SMB mapping before the outbound firewall rules. This is
# separate mapped-volume rejection evidence, not an offline-network assertion.
$mappedEvidencePath = Join-Path $evidenceRoot 'mapped-share-acceptance.json'
if (Test-Path -LiteralPath $mappedEvidencePath) { throw 'Mapped SMB acceptance evidence must start absent.' }
$mappedOutcome = & {
    # Isolate the wrapper's variables/functions while retaining its phase marker.
    # It initializes $evidence after read-only preflight, before fixture creation.
    $evidence = $null
    $mappedFailure = $null
    try { . (Join-Path $PSScriptRoot 'windows-mapped-share-acceptance.ps1') }
    catch { $mappedFailure = $_ }
    $detail = if ($null -ne $mappedFailure) { $mappedFailure.Exception.Message } else { '' }
    [pscustomobject]@{
        failed = $null -ne $mappedFailure
        beforeFixture = $null -eq $evidence
        detail = $detail.Substring(0, [Math]::Min($detail.Length, 1000))
    }
}
if ($mappedOutcome.beforeFixture) {
    if (-not $mappedOutcome.failed) { throw 'Mapped SMB acceptance returned without a fixture outcome.' }
    # A failed preflight created no fixture. Persist that distinct failure so UI
    # diagnosis can proceed without claiming an SMB test or cleanup was exercised.
    [ordered]@{
        schemaVersion = 1; commit = $env:GITHUB_SHA; status = 'failed'; phase = 'preflight'
        fixtureStarted = $false; cleanupPassed = $true; cleanupFailures = @()
    } | ConvertTo-Json | Set-Content -Encoding utf8 $mappedEvidencePath
}
$mappedShare = Get-Content -LiteralPath $mappedEvidencePath -Raw | ConvertFrom-Json
if ($mappedShare.schemaVersion -ne 1 -or $mappedShare.commit -cne $env:GITHUB_SHA -or
    $mappedShare.cleanupPassed -isnot [bool] -or -not $mappedShare.cleanupPassed -or
    $mappedShare.cleanupFailures.Count -ne 0) {
    throw 'Mapped SMB acceptance has invalid evidence or failed cleanup; installed checks cannot continue.'
}
if ($mappedOutcome.failed) {
    if ($mappedShare.status -cne 'failed') { throw 'Mapped SMB failure contradicts its recorded outcome.' }
    Write-Warning "Mapped SMB acceptance failed in $($mappedShare.phase): $($mappedOutcome.detail). Installed checks will continue; overall acceptance remains failed."
} elseif ($mappedShare.status -cne 'passed' -or $mappedShare.phase -cne 'complete') {
    throw 'Installed mapped SMB acceptance did not produce a completed successful outcome.'
}
$mappedSharePassed = -not $mappedOutcome.failed

# Block both Motion and its WebView runtime; a parent executable's firewall rule
# does not cover a child browser process. The CI controller remains available.
$webviewPrograms = @(
    Get-ChildItem -Path "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application\*\msedgewebview2.exe" -ErrorAction SilentlyContinue
    Get-ChildItem -Path "$env:ProgramFiles\Microsoft\EdgeWebView\Application\*\msedgewebview2.exe" -ErrorAction SilentlyContinue
    Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\EdgeWebView\Application\*\msedgewebview2.exe" -ErrorAction SilentlyContinue
) | Select-Object -ExpandProperty FullName -Unique
if (@($webviewPrograms).Count -eq 0 -or @($webviewPrograms).Count -gt 64) { throw 'The installed WebView2 executable set is unavailable or unexpectedly large.' }
$rules = @()
$firewallPrograms = @()
try {
    $programs = @($application, $runtime) + @($webviewPrograms)
    for ($index = 0; $index -lt $programs.Count; $index++) {
        $rule = 'MotionInstalled-' + [Guid]::NewGuid().ToString('N')
        New-NetFirewallRule -Name $rule -DisplayName "Motion installed acceptance $index" -Direction Outbound -Program $programs[$index] -Action Block | Out-Null
        $rules += $rule
        $effective = @(Get-NetFirewallRule -Name $rule -PolicyStore ActiveStore -ErrorAction Stop)
        if ($effective.Count -ne 1 -or "$($effective[0].Enabled)" -cne 'True' -or
            "$($effective[0].Direction)" -cne 'Outbound' -or "$($effective[0].Action)" -cne 'Block' -or
            "$($effective[0].Profile)" -cne 'Any' -or "$($effective[0].PrimaryStatus)" -cne 'OK' -or
            "$($effective[0].EnforcementStatus)" -cne 'Full') { throw 'An installed application firewall rule is not fully enforced for all profiles.' }
        $filter = @($effective[0] | Get-NetFirewallApplicationFilter -ErrorAction Stop)
        if ($filter.Count -ne 1 -or -not [string]::Equals($filter[0].Program, $programs[$index], [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The effective outbound rule is not bound to the selected executable.'
        }
        $firewallPrograms += [ordered]@{ name = $rule; program = $programs[$index]; direction = 'Outbound'; action = 'Block'; profile = 'Any'; primaryStatus = 'OK'; enforcementStatus = 'Full' }
    }
    $env:MOTION_ACCEPTANCE_BLOCKED_WEBVIEW_PATHS = ConvertTo-Json -InputObject @($webviewPrograms) -Compress
    [ordered]@{ schemaVersion = 1; commit = $env:GITHUB_SHA; status = 'passed'; programs = $firewallPrograms } |
        ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $evidenceRoot 'installed-outbound-firewall.json')
    node --test apps/desktop/test/windows/*.test.mjs packages/storage/dist/test/windows/*.test.js *> (Join-Path $evidenceRoot 'installed-native-tests.log')
    if ($LASTEXITCODE -ne 0) {
        Get-Content (Join-Path $evidenceRoot 'installed-native-tests.log') -Tail 100
        throw 'Installed native acceptance failed.'
    }
    node scripts/windows-installed-ui.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Installed Windows UI acceptance failed.' }
    $configuration = Get-Content (Join-Path $repositoryRoot 'apps/desktop/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
    $dataRoot = Join-Path $env:LOCALAPPDATA $configuration.identifier
    if (-not (Test-Path (Join-Path $dataRoot 'motion.sqlite3'))) { throw 'Installed application data was not found.' }
    $beforeUninstall = @{}
    foreach ($file in (Get-ChildItem -LiteralPath $dataRoot -File -Recurse)) {
        $relative = [IO.Path]::GetRelativePath($dataRoot, $file.FullName)
        $beforeUninstall[$relative] = (Get-FileHash $file.FullName -Algorithm SHA256).Hash
    }
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'The installed uninstaller is missing.' }
    # NSIS _?= prevents the detached temporary-uninstaller handoff, making the
    # exit status waitable. Application data deletion is deliberately not selected.
    $removed = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$installRoot" -PassThru -Wait
    if ($removed.ExitCode -ne 0 -or (Test-Path -LiteralPath $application)) { throw 'The installed application was not uninstalled.' }
    foreach ($relative in $beforeUninstall.Keys) {
        $preserved = Join-Path $dataRoot $relative
        if (-not (Test-Path -LiteralPath $preserved -PathType Leaf) -or
            (Get-FileHash $preserved -Algorithm SHA256).Hash -ne $beforeUninstall[$relative]) {
            throw 'Uninstall changed or removed existing notebook data.'
        }
    }
    $reinstalled = Start-Process -FilePath $installer.FullName -ArgumentList "/S /D=$installRoot" -PassThru -Wait
    if ($reinstalled.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $application)) { throw 'Reinstallation failed.' }
    $env:MOTION_ACCEPTANCE_PHASE = 'reinstalled'
    node scripts/windows-installed-ui.mjs
    if ($LASTEXITCODE -ne 0) { throw 'The reinstalled application did not retain the notebook.' }
    if (-not $mappedSharePassed) {
        throw 'Installed checks completed, but mapped SMB acceptance failed; see mapped-share-acceptance.json and the workflow warning.'
    }
    [ordered]@{
        schemaVersion = 1
        commit = $env:GITHUB_SHA
        installer = $installer.Name
        sha256 = $installerHash
        node = $runtimeVersion
        installedMappedShareRejection = 'passed'
        installedNativeTests = 'passed'
        installedUiTests = 'passed'
        uninstallPreservesData = 'passed'
        reinstalledUiTests = 'passed'
        interactiveLicencePageInspectedThenCancelled = 'passed'
        exactInstalledVendorNotices = 'passed'
        boundedOfflinePrerequisiteUpgrade = 'passed'
        realFirstRuleFaultCleanup = 'passed'
        authenticatedActiveWebViewAcrossLaunches = 'passed'
        applicationServiceAndWebViewOutboundFirewall = 'blocked'
        platform = [System.Environment]::OSVersion.VersionString
    } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $evidenceRoot 'acceptance.json')
} finally {
    foreach ($rule in $rules) { Remove-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue }
    Remove-Item Env:MOTION_ACCEPTANCE_BLOCKED_WEBVIEW_PATHS -ErrorAction SilentlyContinue
}
