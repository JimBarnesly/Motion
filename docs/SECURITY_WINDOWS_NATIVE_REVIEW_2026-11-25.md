# Windows native storage boundary review — 25 November 2026

## Status and scope

This is a source review of the Windows implementation being added on top of
`09376b09b2ad8e0217d0466ef60608feb3c3c605`. It is not a Windows runtime pass or
release approval. At the final source checkpoint recorded below, all four
identified common-boundary defects have source corrections. The independent
review found no remaining known source defect within this bounded scope.
Actual Windows filesystem, process, installed-app, and recovery tests remain
required; source correction is not proof that an OS operation behaves as intended.

The reviewer of the common native boundary did not author its implementation.
The review covers `apps/desktop/src-tauri/src/windows_platform/filesystem.rs`,
`security.rs`, `process.rs`, `mod.rs`, the helper entry in `main.rs`/`lib.rs`, and
the root guardian integration in `root_guard.rs`,
`apps/desktop/windows-service-lock.mjs`, and `service-runner.mjs`. Attachment
transactions are being reviewed separately by the desktop/backup implementation
agent; the root agent is reviewing backup publication and the Node helper
client. Their findings will be attributed separately.

The existing security model trusts the unlocked account to access plaintext,
but treats the filesystem as a separate boundary. This review therefore checks
that a pre-existing link, changed pathname, foreign file, interrupted process,
or unexpected ACL cannot silently redirect or overwrite canonical data. It does
not claim protection from an administrator or from arbitrary malicious code
running with the user's full authority. See [SECURITY.md](SECURITY.md).

## Findings and source resolutions

| ID | Finding | Initial impact | State |
| --- | --- | --- | --- |
| WN-01 | Reapplying an inheritable DACL to an existing root can alter unreviewed descendants. | Unintended permission changes before a foreign child is rejected. | Corrected in source: existing private ACLs are preserved; the repair API was removed. Child preservation and inheritance positive-control regressions are written; Windows execution remains pending. |
| WN-02 | A drive-letter prefix does not establish that storage is local. | A mapped network drive could pass the advertised local-only path boundary. | Corrected in source: the opened volume must produce a local volume-GUID path, which anchors subsequent access. Windows mapped-drive fixture remains pending. |
| WN-03 | Denying directory deletion does not prevent an empty directory becoming a reparse point in place. | Path-based create/link can follow a newly installed junction after the directory check. | Corrected in source: component traversal/create and publication use directory/file handles. After-pin junction create/link regressions are written; Windows execution remains pending. |
| WN-04 | Guardian-only ownership can be released before the runner observes guardian death. | A blocked runner can still be active while a successor acquires its released writer lease. | Corrected in source: authenticated runner-lifetime duplicate handles retain authority. Blocked-runner regression is written; Windows execution remains pending. |

### WN-01 — inherited ACL propagation

The initial `pin_private_directory(path, true)` validated the existing directory,
then called `PrivateDescriptor::apply_to` even when the directory already
existed. The descriptor contains an owner-only ACE with object/container
inheritance. `SetSecurityInfo` can propagate such ACE changes to existing
descendants. This means authenticating a parent could change an unknown child
before a later SQLite or attachment check rejects it. The desktop/backup review
agent identified this independently. Microsoft's [SetSecurityInfo documentation](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)
and [inheritance rules](https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces)
describe the propagation behavior.

The requested correction is to leave an existing, already validated private
DACL unchanged. Newly created objects already receive an explicit protected
private descriptor at creation. An unacceptable existing owner/DACL must fail
without recursive repair or ownership changes. The Windows regression should
snapshot a rejected child's owner/DACL and bytes, attempt root acquisition, and
prove that all remain unchanged.

Final source check: `PrivateDescriptor::apply_to` and its `SetSecurityInfo` use
are absent. Both existing-directory paths validate without rewriting the DACL;
new objects receive the descriptor through native creation.

### WN-02 — local volume authentication

The initial `components` function accepted `Disk` and `VerbatimDisk` prefixes,
but did not authenticate the backing volume. Windows drive letters may denote
network mappings; rejecting UNC syntax alone is insufficient. This is a
boundary mismatch even if the normal application data directory is on `C:`.
[GetDriveTypeW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypew)
explicitly distinguishes network drives from fixed/removable local drives.

The requested correction is to authenticate the opened initial drive object as
a local volume and retain that authenticated object while descending the path.
A separate pathname-only preflight would leave device-map substitution between
the check and open unresolved. Unsupported or ambiguous volume identity must
fail closed. Tests must cover UNC/device syntax and, when a mapped share is
available in the Windows test environment, rejection through a drive-letter
alias. An unavailable mapped-share fixture must be recorded as untested rather
than counted as a passed attack test.

### WN-03 — mutable reparse metadata

The initial design opened each directory with `FILE_LIST_DIRECTORY`, omitted
`FILE_SHARE_DELETE`, checked that it was not a reparse point, and later used a
full pathname in `CreateFileW`/`CreateHardLinkW`. This prevents ordinary rename
and delete substitution, but does not freeze all directory metadata.
[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
states that attribute access is not controlled by sharing flags. The Microsoft
[FSCTL_SET_REPARSE_POINT protocol specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4aeefef8-92c3-4abc-af7a-a610caf8a165)
permits the operation through `FILE_WRITE_ATTRIBUTES`; an empty directory can
become a junction without changing its file ID or renaming it. A new empty
attachment bucket provides a concrete point where the old proof was
insufficient.

The implementation owner is replacing the vulnerable path operations with
single-component handle-relative traversal, creation, and publication through
the generated Windows API bindings. Each returned handle must be checked for
directory/file shape, reparse status, owner/DACL, link count, and identity before
use. No path-based fallback is acceptable after a native operation rejects the
request.

The [NtCreateFile reference](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)
documents directory-relative names. [OBJECT_ATTRIBUTES](https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes)
documents `OBJ_DONT_REPARSE`. The two pages differ in the attributes they list;
the exact flag combination and target Windows version therefore require actual
runtime evidence. `FILE_OPEN_REPARSE_POINT` alone opens the final reparse object
for inspection; it must not be described as protection against all intermediate
reparse traversal.

Required regression: retain a handle to an empty destination directory, install
an in-place mount-point reparse buffer through a second attribute handle, then
attempt publication/create. No bytes or new link may appear in the redirected
tree. Also exercise a pre-existing final junction, an intermediate junction,
ordinary root rename attempts, and a device-map change if the runner supports
that fixture. Unsupported test setup is not evidence that the attack is blocked.

### WN-04 — runner and guardian lifetime

The initial `root_guard::run` owned the exclusive writer handle and the
database/WAL/SHM pins. `windows-service-lock.mjs` exited the Node runner when its
event loop received guardian exit/error. A Node thread blocked in synchronous
SQLite or helper work cannot process that callback immediately. If the guardian
dies, its handles close first and a contender can acquire the root while the
old runner has not yet stopped. This differs from the existing Linux design,
where the runner retains the relevant open-file description.

The requested correction couples the writer lease and security pins to the
actual runner process lifetime, not only an event callback. A proposed native
handle transfer must authenticate the intended parent process and must not
accept an arbitrary target PID from untrusted request data. [DuplicateHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle)
documents that duplicates refer to the same object and require process-handle
authority; it does not make an unverified PID an authenticated identity.

Required regression: block the owning Node thread deliberately, terminate its
guardian, and attempt acquisition from a second process before the first thread
can resume. The contender must remain excluded until the old runner exits or
performs a deliberate safe release. The initial test only waited for the old
runner to exit before starting a successor, which did not cover this interval.

## Positive source evidence and limits

| Boundary | Reviewed evidence | Remaining practical limit |
| --- | --- | --- |
| Native allocations | `LocalAllocation` has a single `LocalFree` owner; token handles use `OwnedHandle`; SID/ACE parsing checks length/type before use. | New native calls added to resolve the findings need another bounded review. |
| Ownership and ACL | Current process SID is compared with the opened object's owner; null/empty DACLs and unsupported ACE types fail closed; grants are restricted to the current user, SYSTEM, or Administrators. | Real Windows owner/DACL fixtures must verify behavior for ordinary and elevated accounts. |
| File identity | The facade obtains volume identity plus a 128-bit file ID and tracks link count. Public receipts use an opaque digest of identity; normal attachment opens require one link. | Identity equality does not by itself freeze a directory's reparse metadata. |
| Publication | New targets use no-replace semantics; the source is flushed and the resulting identity/link count is checked; cleanup targets the opened staging object. | Actual native hard-link, removal, and crash tests remain required. |
| Replacement | The temporary file is verified before replacement; backup cleanup is disarmed immediately after successful rename, before later fallible work. | Replacement while a no-delete target handle is retained must be demonstrated on supported Windows versions. |
| Helper dispatch | Native helper modes are handled before Tauri/WebView startup; operation names are allowlisted; the versioned request/response is bounded at 64 MiB; errors omit paths and hostile request text. | This bounds transport, not a proof against every memory-exhaustion pattern in JSON parsing. |
| Service containment | A non-inheritable unnamed job has `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; Node is assigned before its startup gate is released. | A guardian dying alone is different from the Tauri-owned job closing; WN-04 remains separate. |

The allocation ownership assessment follows the documented ownership model of
[GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo).
The process containment assessment follows Microsoft's [Job Objects reference](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): child
membership and kill-on-last-job-handle-close are kernel behavior, while the
application's startup gate and graceful cleanup are separate code paths.

## Independent backup and helper-client review

The root agent independently reviewed `backup.rs`, `root_guard.rs`,
`windows-backup-file.mjs`, `windows-native-helper.ts`, and
`windows-service-lock.mjs`. The source review found no additional defect beyond
the common findings above.

Backup publication validates the protocol, UTF-8 and 16 MiB content bound,
identity plus SHA-256 before a confirmed replacement, a private native writer
lease, and exact-handle temporary cleanup. Bytes are flushed and read back before
publication. New destinations use no-replace semantics. A replacement disarms
temporary cleanup immediately after a successful rename, before a later flush
can fail.

The Node helper client uses an exact operation allowlist, a 64 MiB transport
bound, a 30-second timeout, an absolute local executable path and argument-vector
process creation without a shell. It validates success/error envelope shapes
and replaces native-supplied error messages with safe messages. These are source
properties; they do not establish that every native operation succeeds on
Windows.

The independent reviewer explicitly retained runtime checks for replacement
with an open target, publication with an open source, helper protocol parity,
SQLite WAL/SHM behavior with no-delete pins, and abrupt guardian/runner exit.

## Independent attachment review

The desktop/backup implementation agent independently read
`windows-attachments.ts`, the Windows delegates in `packages/storage/src/index.ts`,
native `attachments.rs`, and the protocol/Windows tests. The review found no
additional attachment-specific authorization, path, or integrity defect beyond
the common-boundary findings.

The reviewer checked frozen, store-bound, single-use capabilities in a WeakMap;
native revalidation of hash and length; expected root, staging-directory and file
identities; restricted generated staging/blob names; bounded native reads before
allocation; verification before deduplication; and authenticated two-link crash
recovery before removal of the staging name. Corrupt and unreferenced final
blobs are retained.

Two contract inconsistencies raised in review were corrected: the native module
now uses the crate's generated attachment-size constant, and JavaScript identity
validation plus test fixtures now require the native protocol's exact lowercase
64-character hex digest. Malformed and obsolete identity forms have a focused
rejection test. Actual Windows publication, ACL and restart behavior remains
pending native execution.

## Windows packaging and gate review

The common-boundary reviewer also reviewed the root agent's Windows workflow,
runtime preparation, installed acceptance scripts, platform Tauri configuration,
and dependency release-gate changes.

The new workflow pins action revisions, Node `24.18.0` and Rust `1.97.1`; uses
`npm ci --ignore-scripts`; retains Cargo `--locked` across build/test/package;
tests both the built helper and the installed executable; and uploads an
explicitly named candidate with its acceptance evidence. The Windows platform
configuration preserves the base application CSP, packages the local Node
runtime and service, selects a current-user NSIS installer, and includes the
offline WebView2 installer. Existing Linux runtime resources remain in the
Linux platform configuration.

Runtime preparation verifies an exact official archive SHA-256 before extracting
only the named executable and licence, rejects redirects, and checks the Windows
executable header. The dependency release gate now examines every workflow and
requires four distinct Linux/Windows runtime pins with consistent versions.
The policy-change gate adds the Windows workflow to its control-plane paths.
This is expanded coverage, not removal of the existing release gates.

One acceptance defect was found and corrected in source: initial outbound
firewall rules named only Motion and Node, although WebView2 is a different
executable. The current PowerShell acceptance locates global and per-user
WebView2 executables, requires at least one, blocks those executables plus Motion
and Node before launching the application, and removes the rules in `finally`.
The late CDP request hooks observe only requests made after connection; their
results must not be described as proof that no startup request was attempted.
The OS firewall provides the intended offline execution boundary.

An independent focused run passed all **25** runtime-preparation, Windows-package,
dependency-release, and workflow-contract tests. These tests inspect build
contracts and rejection behavior; they do not install or execute the application
on Windows. Final first-party unsafe review exceptions must remain bound to the
final reviewed source rather than a prior revision of the common facade.

## Final source checkpoint and unsafe-call scope

The common-boundary reviewer reread the corrected facade, security/process
modules, guardian and UI-state integration. No additional known source defect
was identified at this checkpoint. This is a bounded code review; the remaining
runtime requirements above still apply.

For WN-02/WN-03, the initial opened drive must yield a local volume-GUID path.
Stored directory/file paths are anchored in that namespace. `child` descends
directly from the retained directory handle and clones ancestry handles. Each
`NtCreateFile` operation resolves one checked component; publication and
replacement use retained source/destination handles and aligned, bounded native
information buffers. The guardian returns the anchored path as `mutableRoot`,
so SQLite does not revert to the original mutable DOS drive alias.

For WN-04, `ParentPins` obtains the actual parent PID from a Toolhelp snapshot,
opens and retains that process handle, rejects a process created after the
guardian, and requires the same user SID. The guardian duplicates the exclusive
writer, root ancestry and SQLite sidecar pins into that process before sending
ready. Remote handle numbers never enter JSON. Normal EOF releases the remote
copies through the retained process handle; abnormal guardian exit leaves them
alive until the runner exits. The blocked-runner acceptance now checks both
continued writer exclusion and failed root/database rename during that interval.

The Windows UI-state path now uses native private-file inspection and atomic
publication. The runner derives the destination from its anchored root;
replacement carries the inspected identity, while absence uses no-replace.
The temporary receives an explicit current-user owner/DACL, avoiding the elevated
token's default-owner dependency. The three focused UI-state protocol tests
passed in an independent run; installed Windows UI execution remains pending.

The following **19 production unsafe blocks/expressions** are the complete
reviewed scope in `apps/desktop/src-tauri/src/windows_platform`. Locations apply
only to the file digests below. None of these is blanket permission for new
unsafe code, a different call signature, or a changed implementation.

| File and line | Scope | Bounded rationale |
| --- | --- | --- |
| `filesystem.rs:67` | `inspect` | Live `File` owns the handle; initialized SDK output structs and exact ABI sizes; returned attributes/identity are checked. |
| `filesystem.rs:86` | `nt_error` | Pure SDK conversion of a scalar NTSTATUS to a Win32 error; no borrowed buffer or handle transfer. |
| `filesystem.rs:150` | `open_volume_root` | Retained handle; bounded writable UTF-16 array; zero/oversized return lengths rejected before reading output. |
| `filesystem.rs:179` | `relative_open` | One validated component, bounded UTF-16 length, live parent/security descriptor, synchronous mode plus SYNCHRONIZE, checked status/handle, immediate File ownership and shape check. |
| `filesystem.rs:307` | `PinnedFile::remove` | DELETE-capable exact file handle; fixed SDK disposition struct; consumes the wrapper and closes that handle after marking deletion. |
| `filesystem.rs:418` | `publish_no_replace` | Generated FILE_LINK_INFORMATION layout; usize-aligned allocation covers header and name; no-replace flag and live source/destination handles; native status checked. |
| `filesystem.rs:450` | `replace_private_file` | Generated FILE_RENAME_INFORMATION layout; checked byte length/alignment; retained same-volume source/target and identical parent identity; null-root bare-leaf same-directory rename; no fallible post-rename work in the primitive. |
| `security.rs:43` | `LocalAllocation::drop` | One non-cloned owner frees the documented LocalAlloc-compatible result exactly once. |
| `security.rs:51` | `sid_text` | SID is validated; converted string allocation remains owned; bounded scan and UTF-16 decode precede release. |
| `security.rs:68` | `current_user_sid` | Current-process pseudo-handle is borrowed only for a synchronous token query, never closed as owned. |
| `security.rs:76` | `process_user_sid` | Token handle immediately owned; bounded size query; usize-aligned TOKEN_USER buffer lives through SID conversion. |
| `security.rs:106` | `PrivateDescriptor::new` | OS-derived SID forms a NUL-terminated descriptor string; conversion result has one RAII allocation owner. |
| `security.rs:129` | `validate_private` | Security descriptor owns all returned pointers; ACL validity and ACE/SID sizes/type checked before reads; no pointer escapes. |
| `process.rs:24` | `ServiceJob::new` | Unnamed non-inheritable job; null failure checked before one OwnedHandle owner is constructed. |
| `process.rs:33` | `ServiceJob::new` limits | Live job and exact initialized SDK limits struct; call is synchronous and does not retain the pointer. |
| `process.rs:46` | `ServiceJob::attach` | Job and child process handles remain owned; failure kills/waits for the startup-gated child. |
| `process.rs:69` | `ParentPins::for_current_parent` | Snapshot/process handles become RAII-owned; initialized entry/time buffers; OS parent ID plus creation-time/SID checks; retained process object prevents PID reuse. |
| `process.rs:110` | `ParentPins::duplicate` | Live source/target process and file handles; non-inheritable duplicate tracked only within the native protocol. |
| `process.rs:131` | `ParentPins::release` | Retained parent object and exact private remote IDs; CLOSE_SOURCE is never retried; recovered local handles immediately owned and closed. |

Reviewed SHA-256 snapshots:

```text
752f41f1be66aa55ea8e39991f193a92d968dbae9b4a2e6595b36446258c6fc6  apps/desktop/src-tauri/src/windows_platform/filesystem.rs
7c82a8712b8dcd9972ecb3ade2b73581bd65033c7d2d0815732d6ccdaa7cba78  apps/desktop/src-tauri/src/windows_platform/security.rs
1466e055d8a910a9deb57c4274ab17197039aa4ae9ffe9307b32bf2bada22322  apps/desktop/src-tauri/src/windows_platform/process.rs
a9a1b1968216158b9d1f9200e9511fb54b6fe0c9a6c59b98d5d0b893dabdbc4e  apps/desktop/src-tauri/src/windows_platform/root_guard.rs
bb08920017bcb4619c5bd2c1b91a92194afa8cc0b034f758991b274eb9d4c7b2  apps/desktop/src-tauri/src/windows_platform/mod.rs
0b014778d42898e8ad38ddfbfd3e91cbccb69e9ad2e536667b5fea9f720c3dec  apps/desktop/src-tauri/src/lib.rs
0fce34529a6e6642a2cbaa7abb3bf32c2a1b5acc418a72f7ef9e8726ce4cd47f  apps/desktop/src-tauri/src/main.rs
ad0c777bb2dd37d76647a06d578984f2d5d8d622bb544833308480f8857f8c52  apps/desktop/windows-service-lock.mjs
255ea34c4e9bdd4a4412ec61c6e6b97c8cbdd22ea84c72e43b7b6de7c964f77c  apps/desktop/service-runner.mjs
6836a78813de26b03c27242f7b0fbefc402959b09d79587ff7b91182de5451eb  apps/desktop/windows-ui-state.mjs
38fa8447d55c46540d80a7280fd3cba0e89f17858e165fc2d5c6a59b6d8da990  apps/desktop/windows-backup-file.mjs
7e811b46fb4bae8697f0ff52bcecacf64318733e540af7415fd5686b72b62644  apps/desktop/src-tauri/src/windows_platform/backup.rs
dead86ef764480f11afc9248b89ddc0cb176a29faa0afb332f9dfae1f1c78118  apps/desktop/src-tauri/src/windows_platform/attachments.rs
98f8487e4b828e07692b8e3fd16094cf5f65d5133a2fddb3e1989648acbc816c  packages/storage/src/windows-native-helper.ts
782cc56aebc22a835a5d1b978704910f0912db0d0b664089039c248ae8f2e174  packages/storage/src/windows-attachments.ts
858a04571aef058ea3fe9136722dd2526fa114ec60c220186fa71585cbdcba95  scripts/windows-installed-acceptance.ps1
1aa7215bbeafd41fca11545a25e2c1a93ee005c22a49b5995df65483f81c1533  scripts/windows-installed-ui.mjs
21dafe879d39246b959ac93772fe1db52bf784a078de714426393bd2f9682019  .github/workflows/windows.yml
```

These hashes identify reviewed source, not compiled binary provenance. A change
to a listed unsafe implementation invalidates the corresponding review binding
until the changed scope is reread. No human approval is represented here.

## Validation evidence

The storage author's Linux run passed all 34 storage tests after adding the
Windows protocol adapter; storage TypeScript build and typecheck also passed.
Those tests preserve existing Linux descriptor-publication protections and
exercise helper-envelope/capability validation. They do not execute Win32 APIs.

The implementation owner reports a Windows-target native harness compile. That
checks Rust types, generated bindings and target compilation, not linking or
Windows behavior. The full application target and the installed executable
still need their own evidence.

Actual Windows acceptance is explicitly separate:

```text
node --test packages/storage/dist/test/windows/*.test.js
node --test apps/desktop/test/windows/*.test.mjs
```

The tests require Windows and `MOTION_NATIVE_HELPER` pointing at the built or
installed Motion executable; they fail rather than skip when those prerequisites
are absent. They cover native attachment publication/deduplication, size and
hash validation, staging identity substitution, external hard links, junctions,
interrupted publication recovery, root ownership, guardian/owner termination,
backup publication, and SQLite service restart. The blocked-runner and in-place
reparse regressions above are additional required coverage, not implied by
those existing test names.

No Windows execution, installer success, release signing, or full release
security-chain pass is asserted by this review.

## Independent final integration cross-check

The common-native implementation agent separately reread the desktop/backup
agent's final root guardian, backup and UI-state code. That review confirmed the
parent-process handle lifetime, GUID path continuity, post-confirmation backup
identity check, exact-handle temporary cleanup and native UI-state publication.
No additional source defect was identified. The actual-module MSVC compile was
repeated with the final root integration and passed. The reviewer independently
confirmed that after-pin reparse mutation, drive remapping and unchanged rejected
child ACLs still need explicit runtime evidence.

The root agent also reviewed the ARM64 inventory diagnostic change. It replaces
a shell pipeline with an argument-vector call to the same confined image's
fixed dpkg executable, observes its real exit status, bounds and validates
package/version output, and uses equivalent bytewise sorting for the unchanged
inventory hash. Failure evidence distinguishes command failure from a real hash
mismatch without echoing arbitrary process output. CI now retains that separate
failure artifact; a diagnostic file is never treated as a passing validation.
The expected package inventory remains pinned and no observed mismatch is
accepted without review. The six focused diagnostic/input tests pass locally;
actual ARM64 Docker evidence remains pending the next CI run.

## Follow-up diagnostic checkpoint after `0f91da4`

The reviewer independently checked the narrow launcher change that passes
`pinned_root.path()` to Node on Windows. This maintains the authenticated local
volume-GUID namespace from the first native root pin through service startup.
The Unix argument is unchanged. Making that accessor `pub(crate)` exposes no
new native operation and adds no unsafe call.

The first Windows candidate exposed an `EBUSY` replacement failure. The next
diagnostic change requires identical authenticated source/target parent IDs and
uses a null `RootDirectory` with a bare leaf. Microsoft documents this as the
[same-directory rename form](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information).
Both file guards and parent pins remain retained; no path fallback or release
of the target guard was added. The bounded independent source review found no
additional authorization or unsafe-contract defect in this change. A new
positive replacement test deliberately requires the real operation to succeed
and the old held reader to retain its bytes; a negative test requires rejection
across different parents. This is a diagnostic candidate, not evidence that the
observed Windows failure has been fixed.

The only moved production unsafe scope is `filesystem.rs:450`, occurrence 0,
with scanner fingerprint
`sha256:b1f910df8d9f0d13472bbea085970b9257ca4f69f9d076c362c774326a146a29`.
The other 18 reviewed production scopes retain their locations and call bodies.
The file digests above bind this diagnostic source checkpoint, including both
appended test-module declarations.

### Deterministic Windows attack regressions

The four tests in `windows_platform/tests` are compiled only through the
appended `cfg(test)` module. They do not change production filesystem functions.

| Test | Required observable behavior |
| --- | --- |
| After-pin junction creation | Installing the actual mount-point buffer must succeed while the pin remains open; volume/file ID stays the same, reparse metadata appears, and an ordinary path read reaches the controlled outside sentinel. Relative creation may fail or remain in the original directory, but cannot create anything in the redirected target. |
| After-pin junction publication | The same verified mutation precedes native hard-link publication. No outside link may appear; any inside link must authenticate to the original staging handle and retain the exact attachment bytes. |
| Rejected child preservation | Root reopening and child rejection leave the original owner, exact DACL bytes, descriptor control flags and contents unchanged. The unprotected child deliberately grants Builtin Users read access and must be rejected. |
| ACL propagation positive control | A separate disposable fixture applies the removed inheritable-parent behavior and must observe an actual child DACL change while owner and bytes remain intact. This proves the preservation fixture can detect propagation. |

The SDK-only attack helpers use checked, aligned reparse buffers, retained
attribute handles and owned security-descriptor allocations. Their unsafe calls
are test-only fixture code; they are not included in the 19 production review
exceptions. An independent desktop/backup-agent review found no concrete fixture
defect and confirmed that setup denial cannot count as successful protection.
All junction targets remain inside the disposable test tree; the junction guard
clears through its original handle before directory cleanup.

The common-boundary reviewer compiled these actual modules and tests with
`cargo check --locked --offline --target x86_64-pc-windows-msvc --tests` in a
temporary harness. Compilation passed. It does not execute `FSCTL_SET_REPARSE_POINT`,
ACL propagation, replacement, or any other Windows behavior. Those test results
remain pending the next real Windows run. The test-directory README documents
the real SMB/share/logon-session prerequisites for mapped-drive coverage; a
missing share, local `SUBST` alias, or UNC syntax rejection is not counted as
that regression.

### PowerShell acceptance environment

The reviewer also checked the Windows acceptance changes that launch the
absolute OS Windows PowerShell 5.1 executable and replace inherited
`PSModulePath` aliases with its matching OS module directory in the child
environment. This addresses the observed module-autoload failure inherited
through Node from PowerShell 7, a scenario documented in
[about_PSModulePath](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath).
ACL ownership assertions are unchanged. The UI-close command still interpolates
only a validated positive integer PID. This changes test-process environment
construction, not application permissions or the native storage boundary.
