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

$installerHash = (Get-FileHash $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
"$installerHash  $($installer.Name)" | Set-Content -Encoding utf8 (Join-Path $evidenceRoot 'SHA256SUMS.txt')
$setup = Start-Process -FilePath $installer.FullName -ArgumentList "/S /D=$installRoot" -PassThru -Wait
if ($setup.ExitCode -ne 0) { throw "Installer exited with $($setup.ExitCode)." }

$application = Join-Path $installRoot 'motion-desktop.exe'
$runtime = Join-Path $installRoot 'node-runtime.exe'
$service = Join-Path $installRoot 'service-bundle.mjs'
foreach ($file in @($application, $runtime, $service, (Join-Path $installRoot 'node-runtime-LICENSE'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'An installed application resource is missing.' }
}
$runtimeVersion = (& $runtime --version).Trim()
if ($LASTEXITCODE -ne 0 -or $runtimeVersion -ne 'v24.18.0') { throw 'The installed runtime is not the pinned version.' }

$env:MOTION_NATIVE_HELPER = $application
$env:MOTION_TEST_NODE_BINARY = $runtime
$env:MOTION_TEST_SERVICE_BUNDLE = $service
$env:MOTION_INSTALLED_APP = $application
$env:MOTION_ACCEPTANCE_OUTPUT = $evidenceRoot

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
    [ordered]@{
        schemaVersion = 1
        commit = $env:GITHUB_SHA
        installer = $installer.Name
        sha256 = $installerHash
        node = $runtimeVersion
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
