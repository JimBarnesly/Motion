export function manualRecordOrderEnabled(view) {
  return !view?.filters && !(view?.sorts?.length);
}

export function applyBrowserRecordOrder(workspace, databaseId, orderedRecordPageIds) {
  const database = workspace?.databases?.find(candidate => candidate.id === databaseId);
  if (!database) throw new Error("Database not found");
  const indexed = database.recordPageIds ?? [];
  const byId = new Map((workspace.pages ?? []).map(page => [page.id, page]));
  const live = indexed.map(pageId => byId.get(pageId)).filter(page => page && !page.deletedAt);
  const liveIds = new Set(live.filter(page => page.collectionId === database.id).map(page => page.id));
  if (liveIds.size !== live.length || !Array.isArray(orderedRecordPageIds)
      || orderedRecordPageIds.length !== live.length
      || new Set(orderedRecordPageIds).size !== orderedRecordPageIds.length
      || orderedRecordPageIds.some(pageId => !liveIds.has(pageId))) {
    throw new Error("Record order must contain every live record in the target collection exactly once");
  }
  let next = 0;
  database.recordPageIds = indexed.map(pageId => liveIds.has(pageId) ? orderedRecordPageIds[next++] : pageId);
}

export function moveRecordInManualOrder(orderedRecordPageIds, recordPageId, beforeRecordPageId) {
  if (!Array.isArray(orderedRecordPageIds) || !orderedRecordPageIds.includes(recordPageId)
      || (beforeRecordPageId !== null && (!orderedRecordPageIds.includes(beforeRecordPageId) || beforeRecordPageId === recordPageId))) {
    throw new Error("Record move requires distinct records from the manual order");
  }
  const result = orderedRecordPageIds.filter(pageId => pageId !== recordPageId);
  const target = beforeRecordPageId === null ? result.length : result.indexOf(beforeRecordPageId);
  result.splice(target, 0, recordPageId);
  return result;
}
