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

## Server controls

Use rate limiting, short-lived sessions, CSRF protection for browser sessions, strict origin checks, secure cookies, audit records for security events, and dependency/container hardening. Presence and comments follow workspace permissions. The server never reports a write as accepted before durable storage.

## Security maintenance

Maintain a threat model and vulnerability reporting process. CI runs dependency, secret, static, migration, import-fuzzing, and authorization-boundary tests. Logs redact document content, tokens, keys, raw queries, attachment bytes, and private filenames by default.
