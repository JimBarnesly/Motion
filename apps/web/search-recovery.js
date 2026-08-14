const normalize = value => String(value ?? "").normalize("NFKC").toLocaleLowerCase();
const queryTerms = query => [...new Set(normalize(query).trim().split(/\s+/).filter(Boolean))];

function scalarText(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalarText);
  if (value && typeof value === "object" && !Array.isArray(value.attachmentIds)) return Object.values(value).flatMap(scalarText);
  return [];
}

function flattenBlocks(blocks = []) {
  return blocks.flatMap(block => [block, ...flattenBlocks(block?.children ?? [])]);
}

function matchingSnippet(sources, terms) {
  const source = sources.find(value => terms.some(term => normalize(value).includes(term))) ?? sources[0] ?? "";
  return String(source).replace(/\s+/g, " ").trim().slice(0, 180);
}

function owningTable(workspace, page) {
  const database = workspace?.databases?.find(candidate => candidate.id === page?.collectionId);
  return database?.pageId;
}

export function normalizeSearchHits(input, limit = 50) {
  const unique = new Map();
  for (const hit of input ?? []) {
    if (!hit || typeof hit.entityId !== "string" || !hit.entityId || unique.has(hit.entityId)) continue;
    unique.set(hit.entityId, {
      entityId: hit.entityId,
      entityType: hit.entityType ?? "entity",
      ...(typeof hit.ownerEntityId === "string" && hit.ownerEntityId ? { ownerEntityId: hit.ownerEntityId } : {}),
      title: String(hit.title ?? "Untitled"),
      snippet: String(hit.snippet ?? "")
    });
  }
  return [...unique.values()]
    .sort((left, right) => left.title.localeCompare(right.title) || left.entityId.localeCompare(right.entityId))
    .slice(0, Math.max(0, limit));
}

export function buildBrowserSearchHits(workspace, query, limit = 50) {
  const terms = queryTerms(query);
  if (!terms.length || !workspace) return [];
  const attachments = new Map((workspace.attachments ?? []).map(attachment => [attachment.id, attachment.fileName]));
  const hits = [];
  for (const page of workspace.pages ?? []) {
    if (page.deletedAt) continue;
    const ownerEntityId = owningTable(workspace, page);
    const database = ownerEntityId ? workspace.databases.find(candidate => candidate.id === page.collectionId) : undefined;
    const properties = Object.entries(page.properties ?? {}).flatMap(([id, value]) => {
      const property = database?.properties?.find(candidate => candidate.id === id && candidate.deletedAt === undefined);
      if (!property) return [];
      const label = property.name;
      const fileNames = Array.isArray(value?.attachmentIds) ? value.attachmentIds.map(attachmentId => attachments.get(attachmentId)).filter(Boolean) : [];
      const values = [...scalarText(value), ...fileNames];
      return values.map(item => `${label}: ${item}`);
    });
    const blocks = flattenBlocks(page.blocks);
    const blockText = blocks.map(block => block?.text).filter(value => typeof value === "string" && value);
    const blockFiles = blocks.map(block => attachments.get(block?.attachmentId)).filter(Boolean);
    const sources = [page.title, ...blockText, ...blockFiles, ...properties].filter(value => typeof value === "string" && value);
    const combined = normalize(sources.join(" \n"));
    if (!terms.every(term => combined.includes(term))) continue;
    hits.push({
      entityId: page.id,
      entityType: "page",
      ...(ownerEntityId ? { ownerEntityId } : {}),
      title: page.title || "Untitled",
      snippet: matchingSnippet(sources, terms)
    });
  }
  return normalizeSearchHits(hits, limit);
}

export function resolveSearchTarget(hit, workspace) {
  if (!hit || !workspace) return null;
  if (hit.entityType === "block") return hit.ownerEntityId ? { pageId: hit.ownerEntityId, blockId: hit.entityId } : null;
  if (hit.entityType === "row") {
    if (!hit.ownerEntityId) return null;
    const database = (workspace.databases ?? []).find(candidate => candidate.pageId === hit.ownerEntityId);
    const row = database?.rows?.find(candidate => candidate.id === hit.entityId);
    if (!database || !row?.pageId || !(database.recordPageIds ?? []).includes(row.pageId)) return null;
    const record = (workspace.pages ?? []).find(candidate => candidate.id === row.pageId && candidate.collectionId === database.id && !candidate.deletedAt);
    return record ? { pageId: database.pageId, recordId: record.id } : null;
  }
  const page = (workspace.pages ?? []).find(candidate => candidate.id === hit.entityId && !candidate.deletedAt);
  if (page) return { pageId: page.id, ...(page.collectionId ? { recordId: page.id } : {}) };
  return null;
}

export function searchStatus(query, phase) {
  const term = String(query ?? "").trim();
  if (!term || phase === "idle") return { kind: "guidance", message: "Search page titles, block text, record properties, and attachment filenames." };
  if (phase === "loading") return { kind: "loading", message: `Searching for “${term}”…` };
  if (phase === "empty") return { kind: "empty", message: `No results for “${term}”.` };
  if (phase === "error") return { kind: "error", message: "Search is unavailable right now. Your workspace was not changed.", retryQuery: term };
  return { kind: "results", message: `Search results for “${term}”.` };
}
