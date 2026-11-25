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

& (Join-Path $PSScriptRoot 'windows-webview-inventory.ps1') -OutputPath (Join-Path $evidenceRoot 'webview-before-install.json') -Phase 'before-install'
"$installerHash  $($installer.Name)" | Set-Content -Encoding utf8 (Join-Path $evidenceRoot 'SHA256SUMS.txt')
$setup = Start-Process -FilePath $installer.FullName -ArgumentList "/S /D=$installRoot" -PassThru -Wait
if ($setup.ExitCode -ne 0) { throw "Installer exited with $($setup.ExitCode)." }
& (Join-Path $PSScriptRoot 'windows-webview-inventory.ps1') -OutputPath (Join-Path $evidenceRoot 'webview-after-install.json') -Phase 'after-install'

$application = Join-Path $installRoot 'motion-desktop.exe'
$runtime = Join-Path $installRoot 'node-runtime.exe'
$service = Join-Path $installRoot 'service-bundle.mjs'
foreach ($file in @($application, $runtime, $service, (Join-Path $installRoot 'node-runtime-LICENSE'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'An installed application resource is missing.' }
}
$runtimeVersion = (& $runtime --version).Trim()
if ($LASTEXITCODE -ne 0 -or $runtimeVersion -ne 'v24.22.3') { throw 'The installed runtime is not the pinned version.' }

$env:MOTION_NATIVE_HELPER = $application
$env:MOTION_TEST_NODE_BINARY = $runtime
$env:MOTION_TEST_SERVICE_BUNDLE = $service
$env:MOTION_INSTALLED_APP = $application
$env:MOTION_ACCEPTANCE_OUTPUT = $evidenceRoot

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
    Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\EdgeWebView\Application\*\msedgewebview2.exe" -ErrorAction SilentlyContinue
) | Select-Object -ExpandProperty FullName -Unique
if (@($webviewPrograms).Count -eq 0) { throw 'The installed WebView2 executable could not be located for offline acceptance.' }
$rules = @()
try {
    $programs = @($application, $runtime) + @($webviewPrograms)
    for ($index = 0; $index -lt $programs.Count; $index++) {
        $rule = "Motion installed acceptance $index"
        New-NetFirewallRule -DisplayName $rule -Direction Outbound -Program $programs[$index] -Action Block | Out-Null
        $rules += $rule
    }
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
        applicationServiceAndWebViewOutboundFirewall = 'blocked'
        platform = [System.Environment]::OSVersion.VersionString
    } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $evidenceRoot 'acceptance.json')
} finally {
    foreach ($rule in $rules) { Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue }
}
