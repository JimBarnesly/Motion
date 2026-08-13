# Motion product roadmap

Status: active product direction
Decision authority: Jake
Last reviewed: 2026-08-13

## Roadmap principles

- Each release is additive: later networked features must not make local-only editing, search, export, backup, or restore depend on a server.
- Canonical content remains versioned structured data behind validated domain commands.
- Remote content, imported content, connector output, and AI output are untrusted inputs.
- Security, privacy, accessibility, migration, recovery, and export requirements apply to every release rather than being postponed to a final hardening phase.
- Version labels describe product destinations. Engineering continues through bounded milestones with explicit acceptance evidence.

## V1.0 — broad local workspace parity

Deliver a dependable offline-first workspace before introducing integrations, a required server, or AI.

- Pages, nested navigation, a substantial block editor, stable links, mentions, backlinks, search, files, templates, and local history/recovery.
- Records as pages and typed databases.
- Saved table, list, board, calendar, gallery, timeline, chart, feed, map, and form views in dependency order.
- Relations, rollups, formulas, deterministic filters/sorts, and accessible pointer/keyboard workflows.
- Local JSON, Markdown, CSV, attachment, and full-workspace interchange.
- SQLite persistence, verified backups, recovery drills, diagnostics, and reproducible Linux packages.
- No account, server, telemetry, integration provider, or AI provider required.

The detailed destination is tracked in `NOTION_FEATURE_PARITY_CHECKLIST.md`; engineering milestones are defined in `MILESTONES.md`.

## V1.5 — third-party integrations and automation

Add an explicit, permissioned integration layer after the local product is dependable.

- Connector SDK/protocol with versioned manifests and narrowly scoped capabilities.
- User-controlled OAuth/API credential storage using OS-backed secret facilities where available.
- Per-connector workspace, object, field, direction, and action permissions.
- Imports, exports, polling, webhooks, and bounded automations through validated canonical commands.
- Preview, confirmation, dry-run, audit history, retry, revocation, rate-limit, and conflict behavior.
- Clear provenance for remotely sourced or remotely published data.
- Offline behavior that remains honest when a provider is unavailable.
- Initial connector selection will be planned separately; this roadmap does not promise a specific vendor.

V1.5 must not grant connectors general filesystem, shell, database, or workspace-wide access by default. Disabling or uninstalling an integration must leave canonical local content usable.

## V2.0 — self-hosted server/client model

Establish an optional client/server architecture with a server instance the user can run on hardware they control, including a local server or VPS.

- Published, versioned sync and collaboration protocol.
- Supported self-hosted server package, deployment guide, upgrade path, backup, restore, and diagnostics.
- Desktop clients continue to work offline and reconcile after reconnecting.
- Device enrolment, revocation, key rotation, conflict inspection, duplicate-delivery handling, and interrupted-transfer recovery.
- Workspace membership, roles, object permissions, sharing, comments, history, and presence.
- Secure transport and authentication with least-privilege sessions and auditable device identity.
- Client-side encrypted workspace mode where server plaintext access is not required.
- Local-LAN deployment and remote VPS deployment are both supported configurations.

### Secure remote access

Tailscale is a strong deployment option, but Motion must not require one proprietary network provider. The supported security model should include:

1. loopback/LAN-only binding by default;
2. TLS for any non-loopback exposure;
3. authenticated device enrolment and revocable credentials;
4. documented deployment behind a private overlay network such as Tailscale, Headscale, or another WireGuard-based network;
5. a hardened HTTPS reverse-proxy path for users who intentionally expose a VPS service;
6. no automatic public exposure, default port-forwarding, or silent relay dependency; and
7. explicit threat-model and recovery tests for both LAN and remote access.

The final transport and identity design requires a dedicated ADR and threat-model review before implementation. Tailscale may be documented as the easiest recommended remote-access profile rather than embedded as the sole trust boundary.

## V3.0 — optional AI features

Add AI only after the canonical command, permission, synchronization, and audit boundaries are mature.

- Choice of local or cloud model provider.
- Provider-neutral model interface with user-selected provider and model per action or policy.
- Local inference support for compatible user-operated runtimes.
- User-supplied cloud providers with explicit credential, endpoint, retention, and cost visibility.
- Visible, bounded context selection; no implicit whole-workspace transmission.
- Structured previews and affected-object lists before canonical mutations.
- Explicit approval, validated commands, attribution, undo, audit history, cancellation, and revocation.
- Read-only assistance, semantic retrieval, writing help, structured extraction, and optional agentic workflows delivered incrementally.
- Prompt-injection defenses treating workspace, connector, imported, and retrieved content as untrusted data.
- Object-scoped permissions; no general filesystem or shell capability.
- The complete non-AI product remains functional when AI is disabled or no provider is configured.

Cloud AI is opt-in per provider and action. Local AI must be a genuine supported provider path, not merely a future-facing interface.

## Release sequence summary

| Release | Product destination | Required dependency boundary |
| --- | --- | --- |
| V1.0 | Broad offline local workspace parity | No account, server, integration, or AI dependency |
| V1.5 | Third-party integrations and bounded automation | Explicit connector permissions over canonical commands |
| V2.0 | Optional self-hosted client/server, sync, and collaboration | User-controlled server; secure LAN/VPS access |
| V3.0 | Optional local/cloud AI features | Provider choice, consent, bounded context, preview, audit, and undo |

Each release must preserve complete local export and a documented path to recover user-owned data without continued access to an integration, server vendor, or AI provider.
