# Contributing to Motion

Motion is built local-first. A change must preserve a fully functional offline
mode and must not add mandatory accounts, telemetry, hosted services, remote
fonts, or silent network requests.

## Development

1. Install the current Node.js LTS release.
2. Run `npm install`.
3. Run `npm test` and `npm run build` before submitting a change.

Keep persisted structures versioned. Schema changes require a migration and an
Architecture Decision Record when they alter a public contract. Export formats
must remain documented and reconstructable.

## Pull requests

- Keep changes focused and include tests for domain or migration behaviour.
- State any network access introduced by the change.
- Never commit credentials, private documents, generated workspace data, or
  attachment contents.
- Use original language, interaction design, icons, and assets.
