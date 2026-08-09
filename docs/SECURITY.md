# Motion Security Model

## Trust boundaries

The local device and unlocked user session are trusted to access plaintext. The filesystem, attachment store, sync transport, optional server, other workspace members, plugins, AI providers, and imported content are separate boundaries. Local-only is the default and makes no network request during normal use.

## Defaults

- No account, telemetry, advertising, crash upload, remote fonts, update check, link preview, embed fetch, or AI request without explicit enablement.
- Bind optional servers to loopback unless configured otherwise; require TLS and authentication beyond loopback.
- Store tokens and keys in the OS credential store where available, never in export bundles or logs.
- Render rich text as data; sanitize HTML, SVG, Markdown, and filenames. Attachments are downloads unless a sandboxed previewer supports the type.
- Parameterize SQL and validate identifiers, MIME claims, archive paths, file sizes, and decompression ratios.
- Apply least privilege and explicit workspace authorization on every server request.

## Encryption

Local database-at-rest encryption is optional because an unlocked application must hold the key; prefer OS full-disk encryption and offer application passphrase protection with a memory-hard KDF. Attachment encryption uses independently authenticated chunks. Client-side encrypted sync uses per-workspace content keys wrapped to authorized device keys. Nonces must never repeat, keys are versioned, and rotation retains wrapped historical keys needed for old content.

Encryption does not hide all metadata: timing, ciphertext sizes, server account membership, and IP addresses may remain visible. The UI and documentation must state this precisely. Lost unrecovered keys mean lost data; recovery material is user-controlled and never silently escrowed.

## Network and privacy controls

All outbound features are listed in a network activity screen and can be disabled independently. External links open only after user action. Link previews and remote images use an explicit fetch command and must not send page text or referrer data. AI requests show provider, selected content scope, and retention warning before sending. Providers receive nothing merely because a page is open.

## Backups and exports

Exports are plaintext unless the user explicitly selects an encrypted bundle. Warn before writing plaintext from an encrypted workspace. Backups use authenticated manifests and checksums; restore verifies integrity in staging before replacing or merging data. Keep recovery copies during migration and never overwrite the only known-good backup.

## Runtime filesystem permissions

On Unix, Motion creates and tightens its application data directory, attachment
store, bucket directories, and restore staging to owner-only `0700`. The SQLite
database, WAL/SHM sidecars, attachments, and UI state are owner-readable and
owner-writable `0600`, independent of the launching process umask. Existing
private paths are tightened when opened. Symbolic links and unexpected path
types are rejected before permission changes so Motion does not `chmod` a link
target.

Verified native backups use a dedicated native-owned save dialog and atomic
writer. The WebView cannot supply or receive a filesystem path. New and
replacement backups are private `0600` single-link regular files; replacement
requires validation and explicit confirmation before a fully flushed and
verified atomic swap. Verification and restore safely tighten an existing
owner-controlled single-link backup to `0600`; links, foreign-owned files, and
unexpected path types are rejected without changing their targets. Runtime logs and support diagnostics are
in-memory structured data; Motion does not currently persist them automatically.
Any future private diagnostic writer must use the same `0700`/`0600` boundary.

Windows does not implement Unix owner/group/other mode bits. Motion does not
pretend that `0600` or `0700` has been enforced there; access depends on the
user profile directory and Windows ACL inheritance. A Windows release requires
a separate ACL audit and tests before claiming equivalent protection.

## Server controls

Use rate limiting, short-lived sessions, CSRF protection for browser sessions, strict origin checks, secure cookies, audit records for security events, and dependency/container hardening. Presence and comments follow workspace permissions. The server never reports a write as accepted before durable storage.

## Security maintenance

Maintain a threat model and vulnerability reporting process. CI runs dependency,
secret, unsafe-default, static, diagnostic-leakage, runtime-confinement,
backup-integrity, release-manifest, migration, import-fuzzing, and
authorization-boundary gates. Release signing is isolated in a privileged job
that can start only after the read-only local preflight passes. Logs redact
document content, tokens, keys, raw queries, attachment bytes, and private
filenames by default.

Mandatory secret scanning uses only Gitleaks 8.28.0 from `.tools`. The cache is
not trusted by location: `secret-scanner-tool.json` pins approved Linux
architecture archives and hashes, and preflight verifies the executable before
launch. Missing, substituted, wrong-version, wrong-platform, and mismatched
tools fail closed without printing scanner output or finding values.
