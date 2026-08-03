# Encryption

Encryption is optional and must not impede local-only use or export. Remote collaboration must not begin until key management and the threat model are reviewed.

## Model

- Local vault encryption should use an OS-backed secret or user passphrase to wrap a random workspace key.
- Client-side encrypted sync uses per-workspace data keys and authenticated encryption; servers store ciphertext and minimal routing metadata.
- Each envelope records algorithm, version, key ID, nonce, authenticated context, recipient/device, and rotation state.
- Attachments are encrypted before upload using unique nonces; integrity is checked before exposure.
- Recovery material is user-controlled, exportable, and never silently escrowed.

Keys must be separable from ordinary exports, held only as long as needed, rotatable after device/member removal, and excluded from logs/support bundles. Metadata leakage, rollback, replay, lost-device revocation, malicious-server substitution, and backup recovery require explicit tests.

No encryption implementation currently ships. “Encrypted” must not appear in UI status until authenticated encryption, recovery, and restore tests pass. See `THREAT_MODEL.md` and future encryption ADRs.
