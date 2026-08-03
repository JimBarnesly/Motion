# Import and Export

The canonical full export is a versioned JSON manifest plus structured entities and attachment files. It preserves stable IDs, hierarchy, block trees, collections, records, typed values, views, relations, links/backlinks, requested comments, timestamps, tombstones where requested, unknown metadata, schema versions, and checksums.

Supported targets are single-page/subtree Markdown, collection CSV plus type manifest, full structured JSON and attachments, and later static HTML. CSV is convenient, not lossless. Markdown uses relative attachment references and stable-link metadata where needed.

Import runs into a transaction or new workspace, never executes imported scripts, sanitises paths and active content, caps resource sizes, hashes attachments, reports warnings/skips, avoids duplicate reruns, and offers rollback. Imported unknown blocks remain intact as placeholders. Link reconstruction uses stable IDs when available and records unresolved links.

Exports are written to a staging location, checksummed, then atomically published. Restore validates schema compatibility and every checksum before mutation.

Core and backup packages currently provide JSON/Markdown/CSV/export-manifest primitives and tested backup round trips. A complete archive UI, compatibility importer suite, static HTML, and large-file streaming remain unfinished.
