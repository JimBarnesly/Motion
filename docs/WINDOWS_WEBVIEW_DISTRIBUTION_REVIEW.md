# Windows WebView2 distribution review

**Reviewed:** 25 November 2026. **Candidate:** `0d1dd27475525597c9d7fb6f02c75d0fbf01780d`.

This is a bounded engineering review, not dependency-policy approval. Keep the
current `offlineInstaller` package unchanged and complete its installed
acceptance. Fixed Runtime is a technically supported alternative, but its
binary licence scope, redistribution obligations and maintenance have not been
approved by this review. No production, workflow, dependency or policy change
is made here.

## Current package and remaining acceptance

`apps/desktop/src-tauri/tauri.windows.conf.json` selects a per-user NSIS installer
with Microsoft's Evergreen **Standalone Installer** embedded. The locked NSIS
template reads WebView2's `pv` value under the machine EdgeUpdate client key,
then the current-user key if empty. The client ID is
`{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`; x64 machine detection uses
`SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients`. An empty result, without
`/UPDATE`, executes the embedded installer with `/silent /install`. The template
does not treat the string `0.0.0.0` as empty.

`scripts/windows-installed-acceptance.ps1` installs before adding its application,
Node and WebView2 outbound firewall rules. The hosted Windows Server 2022 image
normally already contains WebView2. A successful run therefore does not prove
first-time installation without network access. **Installation with WebView2
initially absent remains untested.** Server 2022 evidence also does not establish
Windows 11 hardware acceptance. Registry deletion or runtime-folder overrides
would not establish genuine initial absence.

The current approach already redistributes a Microsoft binary. The actual
Evergreen payload is now identified by the static measurements appended below,
including its separate agreement and contained notices. Binary licence-policy
scope and distribution obligations remain unresolved. The proposed Fixed
Version agreement must not be substituted for the current payload's agreement.

## Supported Fixed Runtime behavior

The lock contains CLI **2.11.4**, `tauri` **2.11.5**, `tauri-build` **2.6.3**,
`tauri-utils` **2.9.3**, and Wry **0.55.1**. Source inspection established:

| Stage | Locked behavior |
| --- | --- |
| Configuration | `webviewInstallMode: { "type": "fixedRuntime", "path": "..." }` accepts an extracted runtime directory. |
| Resources | The CLI and `tauri-build` add that directory to bundled resources. Preparation must precede Windows Cargo builds. |
| NSIS | Fixed Runtime selects no bootstrapper/Standalone Installer branch; its binaries are installed as ordinary resources. |
| Startup | Before creating Wry, Tauri sets `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` to its executable directory joined with the configured path, replacing any inherited value. |
| Failure case | Tauri has an installed-runtime fallback if executable-directory resolution fails. A strict bundled-only contract needs a Motion preflight that rejects a missing or invalid bundle before constructing Tauri. |

A simple relative directory such as `webview2-runtime` below `src-tauri` avoids
build-path/resource-layout ambiguity. Keep `minimumWebview2Version` unset:
that separate NSIS path can invoke Edge Updater. The locked updater-package path
also overrides the chosen mode with `DownloadBootstrapper`; it must not silently
become part of a bundled-only offline contract.

An installed test could authenticate the actual WebView browser process's image
path under the installation, its pinned version and file hashes, while Evergreen
remains present. It should retain outbound blocks, test an inherited runtime-path
override, and require failure when the bundled runtime is unavailable. These
are proposed checks, **not observed Fixed Runtime Windows results**. Microsoft's
documented AppContainer read/execute permissions for Fixed Version on Windows 10
also need platform verification; any runtime-folder grants must remain separate
from Motion's private notebook ACLs.

## Measured Fixed Version candidate

Microsoft's official catalogue advertised this candidate during review. The CAB
was downloaded directly from its Microsoft CDN URL, hashed, and inspected as an
archive without executing its binaries.

| Field | Observed value |
| --- | --- |
| Version / architecture | `158.0.4370.33` / `x64` |
| File | `Microsoft.WebView2.FixedVersionRuntime.158.0.4370.33.x64.cab` |
| SHA-256 | `835da387df67797f710881f553bb6934d98f24d08e370456f48d38ed4e072b62` |
| CAB bytes | `437849994` (approximately 417.6 MiB) |
| Members | `258` files |
| Sum of member bytes | `990989742` (approximately 945.1 MiB) |
| CDN last-modified | `2026-11-19 21:11:21 GMT` |

Official catalogue: <https://developer.microsoft.com/microsoft-edge/api/webview2>.
Exact provenance URL:

```text
https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/ecc2761e-1380-46ee-9552-995b039e4e47/Microsoft.WebView2.FixedVersionRuntime.158.0.4370.33.x64.cab
```

These are measurements of the CAB and member sizes, not the final NSIS size or
allocated disk space. Windows Authenticode verification, installed-file
verification and engine execution have not been performed for this proposal.

## Licence findings and unresolved policy scope

The current **Microsoft Edge WebView2 Runtime (Fixed Version)** agreement was
retrieved from the official download page's
[licence API](https://developer.microsoft.com/microsoft-edge/api/eula/webview2?locale=en-us&fixed=true).
The returned `fixedHtml` UTF-8 content has SHA-256
`13abe52770be9206cd86a6f4564c2923813d4fbaef8913d6a8704e4ec5c51b03`.

Its distribution section permits object-code redistribution with applications
that add substantial primary functionality. It also requires direct Microsoft
sourcing, protective end-user/distributor terms, preserved notices and other
distribution obligations. It is distinct from the BSD licence of the WebView2
loader crate. The actual CAB contains:

| Member, relative to the runtime root | Observed notice |
| --- | --- |
| `Trust Protection Lists/Mu/LICENSE` | GPL version 3 text; 35,147 bytes |
| `Trust Protection Lists/Sigma/LICENSE` | Separate Disconnect commercial-licence notice; 66 bytes |
| `WidevineCdm/LICENSE` | Google proprietary notice referring to separate licensing; 473 bytes |
| `show_third_party_software_licenses.bat` | Opens the runtime's third-party credits; inspected, not executed |

`dependency-policy.json` explicitly prohibits GPL identifiers and rejects unknown
licences. The current inventory enumerates npm/Cargo packages; the release gate
also checks Node-runtime pins. Neither automatically classifies this Microsoft
redistributable or establishes that its bundled components are approved. There
is no inferred exception for these binaries, and no notice or component should
be deleted to manufacture an acceptable inventory.

Before any adoption, the unresolved questions are:

- How does the existing prohibited-licence policy apply to this redistributable
  and its contained works, and what authorized policy decision is required?
- What recorded review covers Microsoft's agreement, separate component terms,
  preserved notices and the end-user distribution terms? The MIT licence for
  Motion does not replace these terms.
- What equivalent binary provenance/licence coverage is required for the
  already-embedded Evergreen installer?
- Who maintains the Fixed Runtime security pin and ships patched installers?
  Fixed Version does not update automatically; an Evergreen update does not
  patch Motion's private copy. The roughly 945 MiB installed footprint also
  remains a packaging decision.

Fixed packaging removes the Evergreen installation prerequisite, but does not
itself disable browser diagnostics or replace offline network verification.

## Primary references

- Locked CLI tag commit
  [`8909f221d1515955fc843808032bdc5d62209c96`](https://github.com/tauri-apps/tauri/tree/8909f221d1515955fc843808032bdc5d62209c96):
  `crates/tauri-cli/src/interface/rust.rs` and
  `crates/tauri-bundler/src/bundle/windows/nsis/{mod.rs,installer.nsi}`.
- Locked crate sources: `tauri-2.11.5/src/app.rs`,
  `tauri-build-2.6.3/src/lib.rs`, `tauri-utils-2.9.3/src/config.rs`, and
  `wry-0.55.1/src/webview2/mod.rs`.
- [Tauri Windows installation options](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options).
- [Microsoft runtime distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution),
  [Evergreen versus Fixed Version](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version),
  and [data/privacy behavior](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/data-privacy).

## Actual Evergreen payload in candidate `0d1dd27`

**Static inspection: 25 November 2026.** These measurements identify the
Microsoft binary already embedded in this candidate. They are a release-review
checkpoint, not policy or legal approval, and do not change the packaging
decision or stop installer development. The compact, machine-readable record is
[WINDOWS_EVERGREEN_PAYLOAD_0d1dd27.json](WINDOWS_EVERGREEN_PAYLOAD_0d1dd27.json).

The supplied artifact ZIP contains `Motion_0.1.0_x64-setup.exe`; its extracted
bytes match the artifact's `SHA256SUMS.txt`. No Windows executable, installer or
credits launcher was run during this inspection.

| Layer | Observed version / architecture | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Motion NSIS installer | Motion `0.1.0`, x64 target | 323,288,414 | `e74d9293cb8bc0430bf4c20de9a59c967cfec63586fb0c0afdd8a90858fab130` |
| Embedded `MicrosoftEdgeWebView2RuntimeInstaller.exe` | Microsoft Edge Update Setup `1.3.315.17`, x86 wrapper | 294,099,168 | `47bc51387aff95c1275ce38cfbbb5fbab99b43b33214049877bbcdbcc7a970d5` |
| Nested Microsoft runtime installer | `158.0.4370.33`, x64 | 286,474,064 | `dc14ea63014de44430298e0883b75addc97a6297c13f1e4e95ce579fa7723309` |
| Nested `msedgewebview2.exe` | Microsoft Edge WebView2 `158.0.4370.33`, x64 | 4,775,752 | `b9845539affbb9c8346bf56fcc28f57fcc5a9e8f7ddc67b20fad6ebcc663418e` |

`OfflineManifest.gup` explicitly associates the WebView2 client ID
`{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` with that runtime-installer hash and
version. Its WebView2 action uses
`--msedgewebview --verbose-logging --do-not-launch-msedge`. The updater wrapper
version is distinct from the browser-engine version.

The nested `MSEDGE.7z` archive has 493 regular files and 27 directories, with
1,018,635,388 total member bytes. This is the complete payload archive, not an
installed footprint or proof that WebView2 installation selects every entry.
The engine actually selected on the hosted Windows machine is also not
established by inspecting this archive.

### Static signature evidence

For the Microsoft wrapper, nested runtime installer and browser executable,
OpenSSL verified the PKCS7 signature mathematics using `smime -verify
-noverify`. Separately recomputed SHA-256 PE image digests matched their signed
digests, excluding the PE checksum, security-directory entry and certificate
table as described by Microsoft's
[PE format documentation](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format).
The JSON records the image digests and embedded certificate identities.

The wrapper's signer certificate identifies Microsoft Corporation, issued by
Microsoft Code Signing PCA 2024, with a validity interval from 30 July 2026 to
28 July 2027. **Windows trust-chain, timestamp and revocation verification were
not performed.** Signature mathematics with `-noverify` must not be described as
a Windows Authenticode trust verdict. The outer Motion installer has no
embedded Authenticode certificate table.

Extraction used the official 7-Zip 26.06 Linux release and its BCJ2 source
decoder. Both downloaded tool/source archives matched their official GitHub
release-asset SHA-256 digests; tool provenance is included in the JSON. The
Microsoft payload was extracted from the existing candidate, not redownloaded.

### Applicable Evergreen agreement and observed notices

The official download page's
[Evergreen agreement API](https://developer.microsoft.com/microsoft-edge/api/eula/webview2?locale=en-us)
returns `evergreenHtml`, titled **Microsoft Edge WebView2 Runtime**. Its 21,639
UTF-8 bytes have SHA-256
`ce6fa83e57c338256e5cabe9e1eea83076c271b0fdb253408213eeb08859d7b6`.
This is separate from the Fixed Version agreement above.

Section 2 provides object-code redistribution rights subject to requirements
including substantial application functionality, direct Microsoft sourcing,
protective distributor/end-user terms and other stated obligations. Sections 1,
3, 4 and 9 address separate component terms, data/privacy, preserved notices and
conditional end-user notices. These requirements need explicit release review;
Motion's MIT licence does not classify the Microsoft binary or its components.
Microsoft's [distribution documentation](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
describes including the Evergreen Standalone Installer for offline deployment.

The following files are present in the **current Evergreen candidate**, under
`Chrome-bin/158.0.4370.33/`:

| Member | Observed content | Bytes |
| --- | --- | ---: |
| `Trust Protection Lists/Mu/LICENSE` | GPL version 3 licence text | 35,147 |
| `Trust Protection Lists/Sigma/LICENSE` | Disconnect separate commercial-licence notice | 66 |
| `WidevineCdm/LICENSE` | Google proprietary notice referring to a separate licence agreement | 473 |
| `show_third_party_software_licenses.bat` | Launches WebView2's credits display; read as text only | 270 |

The updater also contains a 4,172-byte `NOTICE.TXT` with Omaha Apache-2.0 and
Boost notices, Microsoft's source-information notice and an LGPL debugging
qualification. The JSON records individual notice hashes. The complete browser
credits have not been reviewed, and no claim is made that all components share
one permissive licence.

**The binary/third-party licence-policy scope is unresolved for the current
Evergreen package as well as the proposed Fixed package.** These observations
do not determine the obligations for every contained work, whether all entries
are installed, or a policy exception. Preserve the notices and obtain the
required classification/decision before any distribution approval.

## Hosted-runner inventory and genuine initial absence

**Source review: 25 November 2026. Actual host inventory remains pending.**
The reviewed `fbdbbd8` Windows run reported Windows Server 2022 Datacenter
`10.0.20348`, image `20261116.370.1`. This identifies the test host; it does not
identify the WebView2 engine that Motion selected. Neither the embedded
`158.0.4370.33` payload nor the installed Edge browser version establishes that
engine version.

The matching runner source is tag `win22/20261116.370`, Git tree
`b47f3f6dc25e42d39230fef67b53c60044baa7f3`:

- The [image readme](https://github.com/actions/runner-images/blob/win22/20261116.370/images/windows/Windows2022-Readme.md)
  identifies the image and included browser/SDK tooling.
- Its [Windows feature configuration](https://github.com/actions/runner-images/blob/win22/20261116.370/images/windows/toolsets/toolset-2022.json)
  does not explicitly enable the RDS session-host role. That does not establish
  the complete base-image or live-machine feature state.
- Its [Edge provisioning script](https://github.com/actions/runner-images/blob/win22/20261116.370/images/windows/scripts/build/Install-EdgeDriver.ps1)
  stops Edge Update and renames `MicrosoftEdgeUpdate.exe` to
  `Disabled_MicrosoftEdgeUpdate.exe`. This is a customized hosted Server image,
  not a fresh Windows 11 machine.

### Read-only inventory design

[`windows-webview-inventory.ps1`](../scripts/windows-webview-inventory.ps1)
accepts an absolute, new JSON `-OutputPath` and `-Phase` of `before-install`,
`after-install`, or `diagnostic`. It records machine/current-user WebView2 `pv`
values in both registry views; uninstall registration flags and command
presence; and known-location `msedgewebview2.exe` versions, byte lengths and
SHA-256 hashes. Uninstall command text is neither emitted nor executed.

File inspection is limited to 16 version directories per known Program Files
or Local AppData location and 64 MiB per executable. Reparse entries are not
inspected. The optional `RDS-RD-Server` query has a 20-second job timeout;
unsupported queries and errors remain explicit observations. Errors record
type, HRESULT and category rather than raw diagnostic messages. The only write
is the requested fresh evidence file, limited to 128 KiB.

The script does not load a native DLL, change registry/services/policies, or
attempt removal. Its native API probe is explicitly `untested`, and
`genuineAbsenceProven` remains `false`, including when every registry/file probe
finds nothing. The design received two independent source reviews; no local
PowerShell execution or Windows inventory result is asserted by this entry.

### Supported-removal finding

Microsoft's [current Windows Server support guidance](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/webview2-unexpected-install-windows-server)
states that WebView2 force-installed for multi-session support cannot be
uninstalled. It identifies the installed roles and Edge Update log markers
needed to diagnose that case. Its installation-block policy prevents future
installs and does not remove an existing runtime. Separately, the
[Edge 131 announcement](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnote-archive-stable-channel#version-1310290348-november-14-2024)
describes WebView2 as a persistent component that no longer appears in Installed
Apps. Older command-line uninstall examples do not establish a supported
removal route for this particular 2026 hosted image.

Consequently, a supported genuine-removal procedure is **not established** by
this review. A registered command's existence alone would not override a
non-removable component state. No forced uninstall, `NoRemove`/`AllowUninstall`
change, registry deletion, runtime-folder deletion, or synthetic runtime-path
override was attempted or adopted as test setup.

### Requirements for a future initially-absent test

A valid test must independently establish all of the following:

1. **Genuine absence before setup.** Observe both registry scopes and runtime
   files, and use a verified native loader's
   [`GetAvailableCoreWebView2BrowserVersionString`](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl#getavailablecorewebview2browserversionstring)
   with unchanged/default engine selection. Its missing-runtime result must not
   be manufactured by environment or policy overrides; preview-channel
   fallback must also be accounted for. The existing locked
   `webview2-com-sys` package includes a loader DLL, but a checksum-verified
   test-only probe has not been implemented or executed.
2. **The real missing-runtime installer branch.** Microsoft's
   [detection contract](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#detect-if-a-webview2-runtime-is-already-installed)
   recognizes `0.0.0.0` as absent, whereas the
   [locked NSIS template](https://github.com/tauri-apps/tauri/blob/8909f221d1515955fc843808032bdc5d62209c96/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
   only enters installation when `pv` is empty and update mode is inactive.
   A legitimate removal leaving `0.0.0.0` would therefore block or fail this
   acceptance scenario; editing the value away would invalidate the evidence.
3. **Outbound denial before installation.** Stage the authenticated candidate
   first, then establish effective denial covering the Microsoft wrapper,
   extracted setup/updater processes, any brokered updater service, and browser
   throughout installation and application checks. The current rules added
   after installation do not demonstrate this condition. Runtime selection and
   the selected executable's version/path must be observed after installation.
4. **Existing functional acceptance still passes.** Exercise the installed
   notebook under outbound blocks and retain failure evidence. An eventual
   successful result could establish Server 2022 behavior after genuine runtime
   removal; it would not establish clean Windows 11 hardware acceptance.

This append records engineering scope and unresolved test evidence. It changes
no packaging choice, licence classification, policy decision, or approval.
