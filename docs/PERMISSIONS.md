# Permissions

Local-only workspaces have one implicit owner and require no account. Collaborative permissions are deferred but their boundary is explicit: every remote read or mutation is authorised by workspace, actor, resource, action, and current membership.

## Planned model

Roles are owner, administrator, editor, commenter, and viewer, with explicit capabilities rather than role-name checks scattered through code. Page inheritance may narrow access only through documented rules. Collection records, comments, exports, attachments, automation, and MCP operations use the same evaluator.

The server enforces permissions for transport and storage; clients also hide unavailable actions but are never trusted as enforcement. Permission changes are durable auditable operations. Revocation invalidates sessions and future key access. Conflicts involving permissions require conservative denial and a visible record.

MCP read and write scopes are separate, revocable, workspace-limited, and never grant filesystem access. AI/agent mutations run through ordinary domain commands, identify the actor, honour permissions, and remain undoable.

No multi-user permission engine is implemented. Current functionality is single-user local mode only.
