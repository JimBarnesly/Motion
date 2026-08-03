# Optional AI and MCP Specification

Status: future extension contract. AI and MCP are not dependencies of the local product and are not claimed as implemented.

## Provider and consent model

- Providers may be local, user-supplied remote APIs, or self-hosted inference endpoints.
- Configuration is per workspace. Credentials live in the OS credential store and are never stored in workspace content, logs, exports, or MCP responses.
- Every remote provider declares its destination domains, data retention warning, model, estimated/actual usage where available, and whether tool use is supported.
- No content leaves the device merely because a page is open. Each action shows the provider and exact selected pages, blocks, records, properties, and attachments before transmission.
- A workspace-wide action requires explicit workspace-wide consent. Selection does not silently expand through backlinks, relations, embeds, hidden properties, or attachments.
- Network-domain allow-lists are enforced at the integration boundary. Provider deletion revokes credentials and removes retained local configuration/history according to a visible policy.

## AI actions

Initial candidates are summarising or rewriting selected blocks, extracting tasks, suggesting tags, proposing a collection schema, searching a selected workspace scope, answering with source links, converting notes to records, and proposing a page.

Model output is untrusted proposal data. A mutating action must:

1. show a structured preview and diff;
2. identify every affected page, block, collection, record, and property;
3. require approval unless the user has explicitly enabled a narrowly scoped repeat rule;
4. execute validated ordinary domain commands under the initiating user's permissions;
5. commit atomically where practical and create undoable operations;
6. attribute the operation to the agent/provider and retain source references;
7. show partial failure honestly and never report success before local commit.

AI cannot bypass permissions, invoke arbitrary code, submit raw SQL, alter encryption/identity settings, or treat retrieved workspace text as authority. Generated links and citations must resolve to source IDs; unsupported claims are labelled rather than fabricated.

## Prompt-injection handling

- System policy, user intent, retrieved content, model output, and tool results remain distinct typed channels internally.
- Page text, comments, imported files, OCR, remote pages, and search results are untrusted content even when they contain instruction-like text.
- Retrieved content cannot grant capabilities, alter selected scope, choose a different provider, reveal secrets, or approve a mutation.
- Tool calls are checked against an independently computed capability and object scope after model generation.
- Tests include indirect instructions requesting workspace enumeration, secret disclosure, external fetches, permission changes, and hidden follow-up tool calls.

## Local MCP server

The optional MCP server may expose narrowly scoped resources for workspace lists, page metadata/content, collection schemas/records, and search results. Candidate tools are search, read page, create page, update selected blocks, create record, update property, link pages, and export page.

Requirements:

- disabled by default and bound locally unless explicitly configured;
- authenticated clients with named, expiring, revocable grants;
- distinct read, create, update, export, and administration capabilities;
- explicit workspace and, where useful, page/collection allow-lists;
- no general filesystem, shell, credential, database, network proxy, or raw-query capability;
- paginated bounded reads and request/rate/size limits;
- schema validation and optimistic concurrency/version checks;
- all mutations routed through the same domain commands, permission checks, operation log, and undo behavior as the UI;
- content returned with provenance and an explicit untrusted-data marker;
- audit events record client identity, capability, object IDs, result, and time, but redact content and secrets.

## Acceptance tests

- With all integrations disabled, no AI/MCP process starts and the full local workflow remains available offline.
- A grant for one page cannot read linked pages, backlinks, hidden properties, attachments, another workspace, or arbitrary files.
- Read-only credentials cannot mutate, export, or cause an indirect mutating tool call.
- Revocation takes effect without restarting the application and invalidates active sessions promptly.
- Mutation preview matches the committed domain operations, and undo restores the prior canonical state.
- Prompt-injection fixtures cannot expand context, disclose canary secrets, select an unapproved provider/domain, or bypass approval.
- Logs and support bundles contain no prompts, responses, document bodies, credentials, or attachment bytes by default.
