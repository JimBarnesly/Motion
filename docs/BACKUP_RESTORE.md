# Backup and Restore

A backup is complete only when Motion can verify it and restore an equivalent workspace.

## Backup flow

1. Establish a consistent local snapshot.
2. Write the versioned canonical export and attachments to staging.
3. Record sizes, SHA-256 checksums, schema/app versions, and creation metadata.
4. Verify all entries, then atomically publish the bundle.
5. Never overwrite the last known-good backup before verification.

## Restore flow

Preview workspace identity, versions, counts, size, encryption requirements, conflicts, and warnings. Restore into a new workspace by default. Validate paths, checksums, schema support, IDs, references, and attachment hashes before commit. Reindex search and run integrity checks after commit; preserve the failed staging area for diagnosis without exposing secrets.

Automated tests must compare restored canonical data, hierarchy, links, collections, values, and attachment hashes. Later scheduled backups require configurable destination/retention, interruption recovery, and encrypted-backup support.

The backup package currently has checksummed backup/preview/restore foundations and tests. Scheduling, UI, encryption, large-workspace streaming, and disaster-recovery drills on packaged desktop builds remain open.

## Recovery integrity evidence (2026-08-05)

The application-service recovery tests exercise the clean-profile boundary:

- a valid checksummed workspace and attachment round-trip survives restart;
- corrupted bytes, truncated JSON with a matching checksum, absolute paths,
  encoded traversal, and backslash traversal fail before a new workspace is
  committed and leave the existing workspace byte-for-byte equivalent;
- an injected database-write interruption leaves no restored workspace and
  discards staged attachments;
- an injected attachment-promotion interruption leaves the original workspace
  unchanged and is completed from the committed new-workspace metadata on the
  next operation; and
- attachment roots and hash buckets are enforced as `0700`, with immutable
  attachment blobs retained as `0600`.

Reproduce with:

```sh
npm run test --workspace @motion/backup
npm run test --workspace @motion/app-service
npm run test --workspace @motion/storage
```

The desktop backup-file boundary writes a private `0600` temporary file, flushes
and re-reads the complete canonical payload, verifies all checksums, and then
publishes it atomically with a parent-directory `fsync`. Existing backups are
never replaced by default. Replacement requires a valid, private, authenticated
existing backup and an explicit confirmation callback; cancellation and every
pre-publication failure leave the last valid backup untouched. Restore is
deliberately into a new workspace and verifies the imported data before any new
workspace metadata is activated.

Large-workspace streaming, free-space preflight, retention policy, encrypted
backups, and packaged-host restore drills remain release risks.
