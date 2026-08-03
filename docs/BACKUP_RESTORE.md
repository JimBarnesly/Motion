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
