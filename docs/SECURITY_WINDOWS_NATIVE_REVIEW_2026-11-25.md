# Windows native storage boundary review — 25 November 2026

## Status and scope

This is a source review of the Windows implementation being added on top of
`09376b09b2ad8e0217d0466ef60608feb3c3c605`. It is not a complete Windows acceptance
pass or release approval. At the latest source checkpoint recorded below, all
six identified boundary/integration findings have source corrections. The
independent review found no remaining known source defect within this bounded
scope and the explicitly stated trusted-session, non-CAS replacement contract.
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
| WN-01 | Reapplying an inheritable DACL to an existing root can alter unreviewed descendants. | Unintended permission changes before a foreign child is rejected. | Corrected in source. Both child preservation and inheritance positive-control regressions passed on real Windows in candidate `57db2c8`. |
| WN-02 | A drive-letter prefix does not establish that storage is local. | A mapped network drive could pass the advertised local-only path boundary. | Corrected in source: the opened volume must produce a local volume-GUID path, which anchors subsequent access. Windows mapped-drive fixture remains pending. |
| WN-03 | Denying directory deletion does not prevent an empty directory becoming a reparse point in place. | Path-based create/link can follow a newly installed junction after the directory check. | Corrected in source. Both after-pin junction create/link regressions passed on real Windows in candidate `57db2c8`. |
| WN-04 | Guardian-only ownership can be released before the runner observes guardian death. | A blocked runner can still be active while a successor acquires its released writer lease. | Corrected in source: authenticated runner-lifetime duplicate handles retain authority. Blocked-runner regression is written; Windows execution remains pending. |
| WN-05 | Tauri creates its default Windows WebView data directory before the first service request. | Elevated first launch can create the Motion root with the token's default Administrators owner, then fail current-user ownership validation. | Corrected in source: create/validate and retain the native private root after Builder.build and before App.run creates configured windows. Installed Windows execution remains pending. |
| WN-06 | The real native backup dialog discarded its initial inspection identity. | A changed valid backup during the dialog could be inspected again and treated as newly approved by the later save call. | Corrected in the Windows path: the original opaque identity crosses the internal dialog/service handoff and cannot be replaced by a fresh snapshot. Windows two-request regressions are written; execution remains pending. |

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
| Native allocations | `LocalAllocation` has a single `LocalFree` owner; token handles use `OwnedHandle`; SID/ACE parsing checks length/type before use. | This source review does not substitute for actual OS behavior tests. |
| Ownership and ACL | Current process SID is compared with the opened object's owner; null/empty DACLs and unsupported ACE types fail closed; grants are restricted to the current user, SYSTEM, or Administrators. | Real Windows owner/DACL fixtures must verify behavior for ordinary and elevated accounts. |
| File identity | The facade obtains volume identity plus a 128-bit file ID and tracks link count. Public receipts use an opaque digest of identity; normal attachment opens require one link. | Identity equality does not by itself freeze a directory's reparse metadata. |
| Publication | New targets use no-replace semantics; the source is flushed and the resulting identity/link count is checked; cleanup targets the opened staging object. | Actual native hard-link, removal, and crash tests remain required. |
| Replacement | A dedicated backup/UI-state reader permits delete sharing, denies writes, and retains authenticated identity; the native lease and final parent-relative lookup coordinate publication. Temporary cleanup is disarmed before post-publication checks. | This is not atomic compare-and-swap against arbitrary same-user namespace changes; actual supported-sharing replacement execution remains pending. |
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
| `filesystem.rs:451` | `replace_private_file` | Generated FILE_RENAME_INFORMATION layout; checked byte length/alignment; retained same-volume source/target and identical parent identity; final parent-relative target identity check; null-root bare-leaf same-directory rename; no fallible post-rename work in the primitive. Backup-specific delete sharing is explicitly non-CAS. |
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
7dd3dc5f4b3e547db3ed5a2ee01594fcc58c445f4284dde49b2d005af12cbf78  apps/desktop/src-tauri/src/windows_platform/filesystem.rs
7c82a8712b8dcd9972ecb3ade2b73581bd65033c7d2d0815732d6ccdaa7cba78  apps/desktop/src-tauri/src/windows_platform/security.rs
1466e055d8a910a9deb57c4274ab17197039aa4ae9ffe9307b32bf2bada22322  apps/desktop/src-tauri/src/windows_platform/process.rs
a9a1b1968216158b9d1f9200e9511fb54b6fe0c9a6c59b98d5d0b893dabdbc4e  apps/desktop/src-tauri/src/windows_platform/root_guard.rs
4176437315a7d4fe6eb2d23149d470f7bcecc02fe554e2ba549165bef781a8e3  apps/desktop/src-tauri/src/windows_platform/mod.rs
253e251f042114f502483e22a7fdce8bd1a256c9760474d36be7dcfcaf9a51b4  apps/desktop/src-tauri/src/lib.rs
0fce34529a6e6642a2cbaa7abb3bf32c2a1b5acc418a72f7ef9e8726ce4cd47f  apps/desktop/src-tauri/src/main.rs
ad0c777bb2dd37d76647a06d578984f2d5d8d622bb544833308480f8857f8c52  apps/desktop/windows-service-lock.mjs
5f58d96a885cc113203a2a511aba67d52ac8979ce05ca852b51a398e0d37ae04  apps/desktop/service-runner.mjs
6836a78813de26b03c27242f7b0fbefc402959b09d79587ff7b91182de5451eb  apps/desktop/windows-ui-state.mjs
f8503fdfd8114bd81085f21c887625328236d7010ef765886d44cc723a944095  apps/desktop/windows-backup-file.mjs
58b7b97004641330007c027ce7f542d2c1134e685516bbf012c1bb49f0c5ac5c  apps/desktop/src-tauri/src/windows_platform/backup.rs
dead86ef764480f11afc9248b89ddc0cb176a29faa0afb332f9dfae1f1c78118  apps/desktop/src-tauri/src/windows_platform/attachments.rs
98f8487e4b828e07692b8e3fd16094cf5f65d5133a2fddb3e1989648acbc816c  packages/storage/src/windows-native-helper.ts
782cc56aebc22a835a5d1b978704910f0912db0d0b664089039c248ae8f2e174  packages/storage/src/windows-attachments.ts
ecb1979f8a5a4df947f1aa85427783b427a02a69728c1737f13c195ee6b0156e  scripts/windows-installed-acceptance.ps1
99d3d3593a03229a0d934f0eab24864174903987ea9e8b6e51d772966b71ce2e  scripts/windows-installed-ui.mjs
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

The original source checkpoint did not assert Windows execution. Subsequent
Windows evidence is recorded below with its candidate and run identifiers.
Installer success, release signing, and a full release security-chain pass are
not asserted by this review.

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

At that diagnostic checkpoint, the only moved production unsafe scope was
`filesystem.rs:450`, occurrence 0,
with scanner fingerprint
`sha256:b1f910df8d9f0d13472bbea085970b9257ca4f69f9d076c362c774326a146a29`.
The other 18 reviewed production scopes retained their locations and call bodies.
That fingerprint is historical; the current source digests and replacement
scope are bound to the supported-sharing checkpoint below.

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
ACL propagation, replacement, or any other Windows behavior. Subsequent actual
Windows results are recorded below. The test-directory README documents
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

### Actual Windows diagnostic result for `57db2c8`

The root agent retrieved Windows run **45597659367**, job **139147906481**:
the native Rust step completed with **23 passed, 1 failed, 0 ignored**. The
four deterministic junction/ACL regressions above all passed. The different-parent
replacement rejection also passed. These are actual Windows filesystem results,
not outcomes inferred from compilation or denied attack setup.

The only failure was same-directory replacement while retaining the original
no-delete target guard; Windows returned sharing violation **32**. Therefore
the null-root diagnostic did not fix the replacement operation. No installer
or complete Windows acceptance pass is inferred from this partial run. Mapped
SMB drive rejection remains untested by this fixture set.

## Supported-sharing and launcher checkpoint after `57db2c8`

The common-boundary reviewer independently reread the frozen replacement
primitives, native backup transaction, Windows writer adapter, service request
validation, native dialog handoff, pre-window startup and associated regressions.
No additional known source defect was identified in the final diff. The scope
below supersedes the failed no-delete replacement assumption; the failure
remains recorded above rather than being reclassified as success.

### Backup/UI-state replacement contract and limit

Only `open_replacement_target` grants `FILE_SHARE_READ | FILE_SHARE_DELETE`.
It denies concurrent data writes and retains the opened file, authenticated
private parent ancestry, current-user ownership, acceptable DACL and single-link
identity. Ordinary attachment openers and database/sidecar pins retain their
existing deletion restrictions. The private per-destination Motion writer lease
remains exclusive for the complete backup transaction.

After flushing and reading back the complete temporary payload, `backup.rs`
rehashes the retained target against the original confirmed identity.
`confirm_replacement_target` then resolves the current leaf relative to the
retained parent and checks private ACLs, file identity and one-link state.
Replacement uses the verified same-parent, null-root native rename. Following
success, temporary cleanup is immediately disarmed before the published name is
checked against the retained source, its bytes are read back, and a final flush
is requested. A post-publication failure cannot delete the new destination.
The Windows error message acknowledges unconfirmed completion instead of
promising that the old file must have survived every failure.

This contract coordinates Motion writers within the trusted unlocked user
session. **It is not kernel compare-and-swap against arbitrary same-user
namespace mutation.** Another process with that user's authority can change the
leaf between the final identity check and rename; in that interval an object
other than the confirmed one could be replaced. A successful source-identity
postcondition does not eliminate that race. This is an explicit limitation of
the lease-plus-final-check design, consistent with the existing Linux contract;
it is not claimed as protection from malicious code holding the user's full
authority. No relaxation was made to attachment publication, SQLite pins,
root ownership or reparse rejection.

Native regressions now cover successful replacement with the dedicated reader,
retained old-reader contents, denied content writes, the published source pin,
substitution after authentication, additional hard links and parent mismatch.
Windows service tests cover repeated UI-state saves, two real competing backup
writers, complete payloads observed by readers and stale identity rejection.
Their source and compilation are reviewed; execution of this revised Windows
candidate remains pending.

### WN-05 — establish ownership before the WebView

The locked `tauri` **2.11.5** source was inspected directly. In
`src/manager/webview.rs`, the Windows default WebView directory is
`LocalData/<identifier>` and absent directories are created with
`std::fs::create_dir_all`. In `src/app.rs::setup`, configured windows are built
before the user `Builder.setup` callback. Motion's prior first-service-request
pin therefore occurred too late to establish an explicit owner for a fresh
elevated launch. The test's `WEBVIEW2_USER_DATA_FOLDER` override does not prevent
Tauri's earlier directory creation.

The reviewed correction uses `Builder.build`, obtains the application's local
data path, creates or validates it with the native private-directory primitive,
and stores its pin in managed application state before `App.run`. Configured
windows are created later during the Ready/setup event. Existing unacceptable
owners or ACLs still fail without repair; accepted existing ACLs are preserved.
The directory and ancestry remain pinned for the application lifetime. The Unix
path preserves the previous `Builder.run` build-then-run sequence. This is a
source correction; actual installed first-launch evidence is still required.

### WN-06 — preserve the identity shown to native confirmation

Previously, the native host inspected a backup, displayed its real confirmation
dialog, then passed only the destination and a confirmation boolean to the
service. The later writer inspected again and used an always-true callback,
allowing a different valid object to acquire the original approval. Direct
writer callback tests did not cover this two-request native-dialog interval.

The Windows inspection now returns an opaque `replacementIdentity`. The native
host validates the closed result shape and exact lowercase hex64 value before
displaying the dialog, retains that value across the await, and sends it only
through the internal confirmed-save envelope. The renderer-facing request still
accepts only schema version and bundle; a test rejects injected identity data.
The service requires the original token for confirmed Windows replacement and
rejects tokens on a new-file save. The writer compares fresh validation to the
original token and forwards that same token to the helper; it cannot rebaseline
approval on a new snapshot.

The actual Windows service regression exercises separate inspection/save
requests with changed contents, identical contents in a different file, missing
approval tokens and a late new-file collision. All must preserve the intervening
data. The Linux legacy native-dialog handoff is unchanged and remains outside
this Windows patch; no Linux correction is asserted here.

### Current source binding and validation

The final frozen diff adds no production unsafe block. The existing rename
scope is now `filesystem.rs:451`, column 5, occurrence 0, with independently
recomputed scanner fingerprint
`sha256:3723f61d01061ed4418e377e435dc11bc622cdb3d884a1d83809d32449b423e8`.
The other 18 production scopes retain their locations and call bodies. The
SHA-256 table above binds this complete reviewed source, including the startup
and original-confirmation-token corrections.

The implementation owners report a successful integrated MSVC modules/tests
compile, desktop build, and **12/12** focused portable runner/startup/UI delegate
tests. These checks do not execute the revised Windows replacement or real
installed dialog. The previously reported `57db2c8` four attack passes remain
actual evidence only for that recorded candidate. Full Windows acceptance,
mapped-share behavior, installer success and release signing remain separate.


## Actual installed candidate result for `0d1dd27`

[Windows run 45599716432](https://github.com/JimBarnesly/Motion/actions/runs/45599716432),
job **139155092002**, executed the corrected candidate on Windows Server 2022.
All **27 native Rust tests**, **23 Windows filesystem/service tests**, and
**three startup-gate tests** passed with no ignored/skipped cases. The native
replacement, before-dialog identity continuity, blocked-owner guardian-lifetime,
and in-place junction/ACL regressions are now actual passing Windows evidence.

The NSIS installer built and installed into a path containing spaces. All
**23 installed native/service tests passed**. The executable SHA-256 is
`e74d9293cb8bc0430bf4c20de9a59c967cfec63586fb0c0afdd8a90858fab130`.
The downloaded candidate/evidence ZIP was independently verified against GitHub's
reported digest
`909ab9c6ff49a17c52f799baff093c610fb681336cedba173d5c257f3636192b`.
These hashes identify a development candidate; they are not a release signature.

The graphical test failed: WebView2/CDP exposed the actual static application
document, but `#content` remained empty for 30 seconds. A legitimate empty native
workspace renders a welcome screen, so this is not a reason to weaken the test.
The test did not reach normal restart or uninstall/reinstall. WN-05's early
private-root creation got as far as WebView creation, but successful application
startup is not established.

The three jobs in [general CI run45599716573](https://github.com/JimBarnesly/Motion/actions/runs/45599716573)
all passed, including complete ARM64 isolated/native/package/offline acceptance.
That is separate evidence from Windows graphical acceptance.

### Reviewed diagnostic and recovery delta

The root reviewer independently read the startup-recovery implementation.
The page now starts with an accessible opening state. A rejected native/browser
load or invalid canonical document presents fixed text and a one-shot retry;
initial editor handlers remain behind the successful awaited load. It does not
reset storage, substitute empty data, disclose the underlying private error, or
race a retry against a still-pending load. Existing reviewed HTML-sink locations
are unchanged, and the new UI uses only DOM creation and text setters. Two
browser regressions passed for native failure/invalid-data/retry and preservation
of an existing IndexedDB document. These do not claim a Windows launcher fix.

The native-boundary author independently reviewed the installed UI diagnostics.
The success assertion now requires `Connected to Motion` as well as content, so
a loading or error panel cannot pass. Failure retains bounded console/process/
CDP log evidence, resource failures and a screenshot. A read-only native-load
probe has a five-second in-page and eight-second controller bound and records
only status/metadata or bounded error details, never the returned workspace.
It does not reload past the failed first launch. Process output is refreshed
after the probe so its own launcher errors are retained. CSP, plugin capability
permissions, canonical requests and native storage code remain unchanged.

The real mapped-SMB fixture was independently reviewed by the root and
desktop/backup reviewers. It uses a unique temporary share restricted to the
current CI identity and a nonpersistent real per-logon mapping. Local native/
service controls and a mapped read/write control must succeed before refusal
counts as evidence. It compares physical file IDs, links, bytes, tree contents,
and owner/DACL descriptors across the attempted operations, then verifies exact
owned mapping/share/tree cleanup. It changes no credentials, SMB service policy,
or persistent mapping. The test runs before firewall restrictions and is not
part of the offline-network claim. Setup denial and cleanup failure cannot
produce a passing result. Actual SMB execution remains pending.

The installed acceptance coordinator records independent SMB and graphical
outcomes. A mapped-volume failure is deferred only when preflight provably
created no fixture, or fresh evidence proves exact cleanup succeeded. Missing
post-setup evidence or failed cleanup stops immediately. A safely deferred
failure still prevents final `acceptance.json` and fails overall acceptance
after independent UI checks; this retains diagnosis without reducing the gate.

The complete local Chromium suite subsequently passed **75/75 tests**, including
the two new startup-recovery cases and all existing editor, property, search,
accessibility, import and persistence cases. The unchanged eight-rule source
scanner passed for 120 first-party files with no new exception.

## Bundled runtime correction for the GUI launcher

Two independent source traces identified a concrete difference between the
passing service tests and the GUI launcher. Locked `tauri-utils2.9.3` obtains its
resource directory from `starting_binary.rs` using Rust's filesystem
canonicalization. On Windows this produces a namespaced drive path. Motion
passes that unchanged as Node's entrypoint. In pinned Node24.18.0,
`lib/internal/modules/run_main.js` resolves the entrypoint with `toRealPath`
before loading the module, while `lib/fs.js` passes the namespaced drive root
directly to its `lstat` binding.

The official [Node issue62446](https://github.com/nodejs/node/issues/62446)
and [upstream fix65378](https://github.com/nodejs/node/pull/65378) document the
resulting `EISDIR` before script execution. The fix preserves namespaced paths
and corrects only the drive-root probe. It entered the
[24.21.0 release](https://nodejs.org/en/blog/release/v24.21.0). The independent
reviewer confirmed the corrected root-probe helper in the exact24.22.3 source.
This is a source-established launcher incompatibility; the prior UI artifact
did not capture its process error, so the final installed outcome must still
be observed before declaring the GUI failure resolved.

The continuation upgrades the **bundled runtime** to official
[Node24.22.3](https://nodejs.org/en/blog/release/v24.22.3), the 11 November
security release, while leaving all production launcher path handling and
authenticated GUID data-root authority unchanged. No string stripping, new
MAX_PATH restriction, new dependency package, unsafe block, shell evaluation,
CSP relaxation or capability grant is introduced. The separately pinned
Node24.18.0 build tools and isolated image remain unchanged; they are not the
runtime embedded in the new package. The existing cache key follows the new
archive version.

Both reviewers independently retrieved the official
[checksum manifest](https://nodejs.org/dist/v24.22.3/SHASUMS256.txt), SHA-256
`06d17307d84ec057dd2783863f12cb228c9273f9424b330532e4e3699f5d47c9`.
Its four exact archive pins are:

| Archive | SHA-256 |
| --- | --- |
| `node-v24.22.3-linux-x64.tar.xz` | `4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb` |
| `node-v24.22.3-linux-arm64.tar.xz` | `6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c` |
| `node-v24.22.3-win-x64.zip` | `e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f` |
| `node-v24.22.3-win-arm64.zip` | `b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14` |

Preparation still rejects redirects, authenticates the entire archive before
extracting only the executable and its licence, and permits these four network
URLs only in build preparation. Installed runtime downloads remain absent.
The exact dependency-control record is refreshed only for the changed existing
cache key; policy, trust anchor, five-file governed scope and required review
role remain unchanged. Focused runtime/offline/release/workflow tests passed
**26/26**. The new Windows entrypoint regression and complete installed suite
remain required native evidence.

The root and desktop/backup reviewers independently checked the new Windows-only
Rust regression. It requires both ordinary and filesystem-canonicalized Node
and `.mjs` resource paths, authenticates the actual `VerbatimDisk` spelling,
and passes the original native-pinned volume-GUID root into the real prepared
bundle. The actual Motion helper, service job and stdin startup gate are used;
the exact empty `ui-load` reply and released fixture are required. A bounded
wait closes the job to terminate a stalled process tree. The test deliberately
does not claim to call `start_service`, whose `current_exe` would otherwise point
to the test harness. Installed graphical acceptance covers that final integration.
Only test inclusion changes `lib.rs`; production launch code remains unchanged.

The root additionally downloaded and SHA-256 verified the24.22.3 Linux x64
archive (32,064,292 bytes) and Windows x64 ZIP (37,762,649 bytes) against the
official manifest. Local offline extraction of the Linux runtime returned
`v24.22.3`, and all three actual bundled-service startup-gate tests passed.
Ten dependency-governance regressions also passed.

The implementing reviewer cross-compiled the actual new startup test source and
Windows platform modules for `x86_64-pc-windows-msvc --tests` with zero errors in
the existing source harness. Full local Tauri compilation lacks the Windows
resource compiler, so actual Windows execution remains required. After adding
the regression, the unchanged source gate passed for **121 first-party files**.


## Observed GUI startup and mapped-volume result at `fbdbbd8`

[Windows run 45608035891](https://github.com/JimBarnesly/Motion/actions/runs/45608035891)
completed all **28 native Rust tests**, **23 Windows filesystem/service tests**,
**three startup-gate tests**, and **23 installed native tests** without skips or
ignored cases. The new original-format canonicalized entrypoint regression
passed. The installed GUI then opened, created a page and saved its title;
a bounded native diagnostic returned revision 3 and one page. This establishes
the bundled runtime correction in the actual desktop launch path.

The next GUI action failed because the acceptance fixture expected a starter
paragraph that only the browser-development mutation creates. Native
`page.create` correctly starts with an empty block list; the screenshot shows the
real **+ Add block** control. The revised fixture clicks that control and requires
one editable block before typing. No assertion is removed or replaced by a stub.
Restart and uninstall/reinstall were not reached in this run.

The real mapped-SMB fixture also passed: local native/service controls, reachable
mapped read/write control, all five native refusals and the queued-service refusal,
physical and security snapshot preservation, and exact owned fixture cleanup.
The raw result and independently verified artifact/installer hashes are retained
in `WINDOWS_INSTALLED_EVIDENCE_fbdbbd8.json`. The test ran the PR merge commit
`b62797a0002802c9ce54fc6fbefbe6c38e16c064` for head `fbdbbd8`; head and tested
merge identity are recorded separately.

### Reviewed backup transport and installed-lifecycle increment

A real transport defect was reproduced between the web adapter and service.
Tauri serializes nested `Uint8Array` values as ordinary arrays, while Motion's
service revives the existing exact `$motionBytes` envelope. The adapter now
recursively encodes typed bytes before `app_dispatch` and native backup save,
and strictly validates byte envelopes on decode. It changes neither the wire
protocol nor permissions, dependency packages, native file publication or schema.

The root independently read the codec and the actual-service regression, and ran
that regression successfully. It uses nonempty canonical data and bytes including
0 and 255; checks verification/preview, actual file publication/readback,
corruption rejection without creating a workspace, new-identity restoration,
unchanged original revision and exact restored attachment bytes. Native Save As
interaction is explicitly outside this portable test. The web adapter's 54 tests
and typecheck also pass locally.

The desktop/backup reviewer independently reviewed the native-boundary author's
installed GUI increment, and the root reviewed the final diff. It uses the actual
installed adapter, exact encoded backup file, observed matching confirmation and
real UI restore. Canonical snapshots establish original-workspace preservation,
exactly one new workspace, exact bytes and persistent restored selection across
restart/reinstall. A separate WebView profile and debug port ensure the second-GUI
case tests native ownership, not a browser-profile collision. Its valid mutation
canary must fail without changing the open owner; the same contender must recover
through its Retry control after the owner closes. All instances have bounded
cleanup, and cleanup failures prevent the PASS artifact. Actual Windows execution
remains required; native Save As dialog automation is not claimed. Normal window
close terminates the service process, so restart verifies durability/recovery,
not graceful SQLite shutdown.

Both Linux architecture jobs passed in general CI run45608036035. Its verify job
failed on one public EULA-document digest field named `api_response_sha256`.
Independent recomputation of the retained 24,565-byte public API response gives
`821657eb0994850b0ea86b53242c52a22016e45859fee74bcd456dd77c0ba18e`, exactly the
reported value. Renaming the metadata key to `response_document_sha256` removes
the lexical false positive without changing the digest, scanner, policy or
allowlist. All **11 unchanged secret-scan regressions** pass locally, including
seeded-secret rejection. Complete CI remains mandatory for the next candidate.


## Installed attachment finding and prerequisite verification continuation

[Windows run45612288185](https://github.com/JimBarnesly/Motion/actions/runs/45612288185)
for head `a64ceb0` passed all 28 Rust, 23 native/service, three startup and
23 installed native tests again. Mapped-SMB controls, rejection, preservation
and cleanup passed. The actual GUI created and saved its page/title/body; the
attachment picker then failed with `No file selected`. The frozen evidence
record `WINDOWS_INSTALLED_EVIDENCE_a64ceb0.json` binds the exact tested merge,
verified ZIP/installer and small evidence files. The real FileList defect and
renderer correction are reviewed separately in the renderer review. Backup
restore, concurrent GUI, normal close/restart and uninstall/reinstall were not
reached. All three general CI jobs in
[run45612288566](https://github.com/JimBarnesly/Motion/actions/runs/45612288566)
passed, including the unchanged secret scanner and actual-service backup test.

Before the next candidate executes NSIS, a bounded verifier measures the final
installer and its complete member listing, requires the sole exact embedded
Evergreen wrapper, extracts only that literal member, and checks the reviewed
byte length and SHA-256. The 7-Zip executable and DLL are themselves measured
against the independently inspected official release and copied into an empty
owned tool directory without optional plugin directories. Child tools receive
argument vectors, bounded output/time, a controlled working directory and a
System32-only PATH. The verifier measures an installed Microsoft-signed SDK
SignTool before using Windows trust verification on every payload signature;
the payload also requires its exact Microsoft signing certificate, timestamp
certificate and wrapper version. The outer installer and extracted payload are
remeasured, and owned temporary-file cleanup must succeed before PASS.

The root independently reviewed the final verifier, PowerShell trust probe,
exact pin, acceptance coordinator and workflow ordering. The editor/backup
reviewer independently reviewed the author implementation and wiring with no
blocking finding. Eight portable tests cover listing ambiguity/path/type/size,
exact measurements, signature rejection, bounded tool failures/output/timeout
and eight negative source-contract mutations that prevent execution/upload
before successful verification. The root also parsed the actual prior final
NSIS listing and independently confirmed the embedded payload's exact reviewed
bytes. None of this portable evidence is a Windows trust execution claim; the
next native CI run must produce that verdict.

The acceptance coordinator requires the verifier's exact current commit and
installer SHA before writing its success output or executing setup. Candidate
upload requires that output; diagnostics are retained separately on failure.
Passing prerequisite verification can retain a development installer after a
later GUI failure, but does not make it a release. No packaging mode, runtime
fetch policy, CSP, dependency trust anchor or licence classification changes.

The read-only before/after WebView inventory reports separate registry, file
and optional bounded RDS observations. It emits no uninstall command text,
executes no removal, changes no registry/policy/service, and always records
`genuineAbsenceProven: false` because it has no native default-engine absence
probe. Hosted-runner presence cannot substitute for clean-image offline
installation. Its source was independently reviewed by the root and native
boundary reviewer; actual PowerShell execution is still required.

Reviewed candidate file SHA-256 bindings:

| Source | SHA-256 |
| --- | --- |
| `scripts/windows-installer-payload-pin.json` | `fc151f26878fab1d76acf8fc67356ff36a9f8003200931dc537ef0386d9082e9` |
| `scripts/windows-verify-installer-payload.mjs` | `08a811f2541fa9e458c0fde0f8d6f34e70f07c8db19c4d3a72871fb718466a7e` |
| `scripts/windows-authenticode-probe.ps1` | `013dbdbab49757f2182da6a56d454a924ed4b263b3625ece1c3485c046710e28` |
| `scripts/windows-installer-payload.test.mjs` | `a4e70dd520143bcf3fcecb7213849860f57cfc1e63a2680cee514d0a62820605` |
| `scripts/windows-webview-inventory.ps1` | `c80edbab982f12168105908abcd9e355262a36ec06f60bd51949aec5030f1785` |
| `scripts/windows-installed-acceptance.ps1` | `48fded6b189398164fa86ee61fa8ced9a479115400df8f4c6fe0ff8bb5b9df54` |
| `.github/workflows/windows.yml` | `ab68efabe92214bb718778169abffa262c5d58fbeddd322dad782748bc069073` |


Static import inspection of the actual `a64ceb0` installer also found no direct
or delay import of a VC++/STL/debug CRT or developer-tool DLL in Motion or bundled
Node. The executable hashes, exact DLL lists, empty delay-import directories and
byte-identical official Node comparison are retained in the installed-evidence
JSON. The locked MSVC WebView binding links its loader statically. This is a
bounded static finding, not recursive resolution against a Windows 11 system or
proof of fresh-machine launch; no packaging change is inferred from it.


## Exact Microsoft signature selection after `28a4180`

[Windows run45619140961](https://github.com/JimBarnesly/Motion/actions/runs/45619140961)
passed full native compilation, 28 Rust tests, 23 native/service tests, startup
checks and NSIS creation. The new prerequisite gate then stopped before any
installer execution. Extraction-tool pins, the complete 11-member NSIS inventory,
exact 294,099,168-byte wrapper SHA-256, and SDK SignTool authentication passed.
`verify /pa /all /tw /v` returned exit1: index0 was the timestamped Microsoft
primary signature, while index1 was an untimestamped self-issued EdgeBuild
signature. The installer upload was correctly withheld; only four diagnostic
files were retained. The downloaded diagnostic ZIP's exact hash and unmodified
failed trust output are in `WINDOWS_PREREQUISITE_EVIDENCE_28a4180.json`. This is
not an installed acceptance result, and the payload PowerShell probe was not
reached.

Independent static analysis of the same exact wrapper found one WIN_CERTIFICATE
entry containing Microsoft's PKCS7 signature and one nested EdgeBuild signature
in the primary SignerInfo's unauthenticated attribute
`1.3.6.1.4.1.311.2.4.1`. Both cover identical signed content and PE image digest.
The independent reviewer verified the signature math and extracted the actual
signer certificates; the root separately measured the complete PE, certificate
table, exact DER boundaries/padding and nested signature bytes. The complete
bounded inventory is `WINDOWS_EVERGREEN_SIGNATURES_28a4180.json`. EdgeBuild is
explicitly not trusted. The distinction between the aligned certificate payload
and exact DER corrects a label in an older temporary report; the complete-file
and Microsoft signer-certificate pins are unchanged.

The corrected policy authenticates the exact reviewed **Microsoft primary
publisher signature**, rather than requiring every nested signature to chain to
a trusted root. Microsoft documents `/ds Index` as deliberate signature
selection, separately from `/all`, and its own sample selects primary index0
with WSS_VERIFY_SPECIFIC before inspecting secondaries:

- https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool
- https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_signature_settings
- https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/Security/CodeSigning/cpp/codesigning.cpp

The verifier therefore requires numeric index0 and a fresh
`verify /pa /ds 0 /tw /v` execution with **exit0 only**. It records the actual
argument array. There is no fallback to a different signer, acceptance of a
failed `/all`, certificate import, trust-store change, signing, signature removal
or payload rewrite. Exact full-file size/hash before and after, pinned Microsoft
certificate DER hash, embedded Windows `Valid` status, Microsoft publisher,
timestamp certificate and wrapper version all remain mandatory. The full-file
hash also binds the certificate table that the Authenticode image digest excludes.

The independent editor reviewer inspected the final three-file delta and found
no blocking defect. All eight verifier regressions pass, including missing,
negative and secondary-index rejection, actual process exit1 and exit2 rejection,
byte tampering, wrong certificate, absent timestamp, catalog evidence, and
install/upload ordering. Actual selected-primary SignTool success together with
the existing payload probe still requires the next Windows run. This correction
changes the signature-selection contract; it does not reclassify the failed
all-signatures run as success or approve redistribution.

| Corrected source | SHA-256 |
| --- | --- |
| `scripts/windows-verify-installer-payload.mjs` | `4d34d814877cb19091171e7e816bcc1036f9443704d296110c905cbcaae1a0ca` |
| `scripts/windows-installer-payload-pin.json` | `60f7f9715f60e003357a59f2ed1df39c7c671d8c298942f9b2fedf170eb11433` |
| `scripts/windows-installer-payload.test.mjs` | `d0b367e98446b04d4b5038b4db6910c0124f51ec7ae352e426dd089a52384e53` |


## Native Save As acceptance candidate after `8209982`

The next acceptance increment replaces the test controller's constructed backup
file with the exact file saved by Motion's real **Verified backup** button and
native **Save verified Motion backup** dialog. It changes acceptance code only;
no native production command, capability, workflow, dependency or policy is
changed. This section records source review, not Windows execution.

The PowerShell 5.1 MTA helper authenticates the actual spawned Motion PID, full
executable path, creation FILETIME and interactive session, retains the process
handle and rechecks identity throughout automation. The controller first runs a
real stale-creation-identity negative control, requiring failure before any ready
event, UI action or destination creation. The positive path searches only
top-level windows in that process and the exact backup-dialog title, retains its
runtime ID and HWND, and confines further control traversal to that dialog.

The helper selects one enabled writable filename control by its observed default
value, uses ValuePattern to set and read back a fresh full path with spaces, and
invokes the unique observed Save button through InvokePattern. It uses no
desktop-wide keys, coordinate targeting, guessed AutomationIds or destination
IPC shortcut. Control traversal, process duration, protocol output and cleanup
are bounded and fail closed. An unexpected remaining native window fails the
test rather than being dismissed.

The destination is a fresh private directory created through the installed
Motion helper. After the real UI reports its saved status, that same installed
helper authenticates the resulting regular private single-link file and reads
its bounded bytes. The controller checks exact file equality, canonical JSON,
manifest hashes, all attachment bytes, source workspace/revision equality, an
unrelated neighbouring file and temporary-file cleanup. The identical disk bytes
then go through installed verification/preview and the real confirmation/restore
flow. Later single-writer, Retry, restart and uninstall/reinstall checks remain
mandatory. Native cancellation and overwrite confirmations remain separate
unexecuted acceptance cases.

Independent editor review found no blocking source defect. Node syntax, scoped
diff checking and the actual JavaScript source scanner with an empty suppression
policy pass. Root also inspected the process identity protocol, exact-file
authentication and restore integration. Actual PowerShell 5.1/UIAutomation
execution, including the Windows common dialog's filename/Save control exposure,
requires the next Windows candidate. The current `8209982` run uses the previous
installed test and cannot establish this new native-dialog coverage.

| Source-reviewed candidate | SHA-256 |
| --- | --- |
| `scripts/windows-installed-ui.mjs` | `84e180f3e37763b49d9848393d881f5498450b6a7d7b85a4a3600088e0d29151` |
| `scripts/windows-native-save-dialog.ps1` | `b0777895060b100a2639750d5cc872d1787502195ca768bd8f2fc450195df095` |


## Executed full installed baseline at `8209982`

Windows run45624078077/job139239558205 completed successfully against PR merge
`f1f0e6b180fa50269c955bc64203819b4699c74e`. The exact primary0 command returned
exit0 and the independent payload probe reported embedded Microsoft Authenticode
Valid with the pinned signer, timestamp and wrapper version. Byte/tool pins,
outer-installer remeasurement and owned temporary cleanup all passed. The failed
older all-signatures attempt is retained as failed evidence.

The final installer actually installed and passed all 23 installed native cases,
including real cancellation/replacement/identity checks at the native boundary.
The two GUI phases passed actual attachment ingestion, native backup verification
and UI confirmed restore, exact original/new workspace and attachment preservation,
concurrent-GUI exclusion, same-GUI Retry, normal close/restart/search and
uninstall/reinstall preservation. Firewall blocking covered Motion, its local
service and the enumerated WebView programs before GUI launch. Native Save As UI
coverage described above is a later candidate and is not inferred from this run.

The downloaded artifact ZIP hash and every member were independently measured;
all reports bind the tested merge and installer SHA. Full bounded evidence is
`WINDOWS_INSTALLED_EVIDENCE_8209982.json`. The before/after inventory really ran:
it observed existing machine WebView2 131.0.2903.86 unchanged and set
`genuineAbsenceProven=false`. It does not identify the running engine or establish
first-time installation offline. General verification and both Linux jobs also
passed at the same head; all 86 browser regressions passed under the unchanged
network-denial fixture. No outer-installer signing or 1.0 acceptance is inferred.


## Observed Save As control correction after `503ae3d`

Windows run45628198328/job139253956163 passed compilation, all native/storage
checks, prerequisite trust, installation and mapped-SMB acceptance. The new
native Save As test actually authenticated Motion, rejected the stale creation
identity before any UI action and opened the exact titled dialog. It then timed
out in control selection. The independently downloaded 15-file diagnostic ZIP
and complete bounded control evidence are retained in
`WINDOWS_SAVE_DIALOG_EVIDENCE_503ae3d.json`. This is a failed run; later backup
restore and GUI restart/reinstall were not reached.

Windows actually exposed one visible/enabled filename Edit named `File name:`
with AutomationId `1001`. The previous selector also required an unobserved
assumed default Value. Its record did not capture ValuePattern or InvokePattern
availability, so neither an extension-display cause nor a specific unsupported
pattern is asserted. The corrected selector uses that exact observed label/ID,
Edit type, matching process, visibility/enabled state and writable ValuePattern,
inside the same retained authenticated dialog. Uniqueness, process creation/path/
session, HWND/runtime ID, fresh destination, exact written-path readback, Save
InvokePattern, native file authentication and exact byte checks remain mandatory.

Diagnostics now record candidate pattern availability, readonly state and a
bounded original value before mutation, plus the original control/value before
SetValue. Lists are capped at four candidates and values at 256 characters.
Unsupported or ambiguous controls still fail; no keyboard/coordinate fallback
or arbitrary dialog is accepted. Independent editor review found no remaining
source blocker. Node syntax and scoped whitespace checks pass; actual corrected
Windows execution is pending. General verification at 503ae3d is green with all 89
browser cases, and both Linux platform jobs passed.

| Corrected acceptance source | SHA-256 |
| --- | --- |
| `scripts/windows-native-save-dialog.ps1` | `4840cfbc767da7e74080362451ab15226841286d7e70f95082b031893aace90d` |
| `scripts/windows-installed-ui.mjs` | `47b95d14f3f6991dbff966f8eab9ce5372cdee42596336b138cbf5db24f325b9` |
