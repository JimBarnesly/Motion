const UI_STATE_FIELDS = new Set(["workspaceId", "activePageId", "expandedPageIds", "activeViewIds", "collapsedBlockIds"]);
const UI_STATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const validUiStateId = value => value === null || (typeof value === "string" && UI_STATE_ID.test(value));

export function isValidCollapsedBlockIds(value) {
  return value === undefined || (Array.isArray(value) && value.length <= 256
    && Array.from(value).every(id => typeof id === "string" && id.match(UI_STATE_ID)?.[0] === id) && new Set(value).size === value.length);
}

export function survivingCollapsedBlockIds(workspace, value = []) {
  if (!isValidCollapsedBlockIds(value)) throw new TypeError("Invalid collapsed block preferences");
  const toggles = new Set(), pending = (workspace?.pages ?? []).flatMap(page => page.blocks ?? []);
  while (pending.length) {
    const block = pending.pop();
    if (block.type === "toggle") toggles.add(block.id);
    for (const child of block.children ?? []) pending.push(child);
  }
  return value.filter(id => toggles.has(id));
}

export function isValidUiState(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && !Object.keys(value).some(key => !UI_STATE_FIELDS.has(key))
    && validUiStateId(value.workspaceId ?? null)
    && validUiStateId(value.activePageId ?? null)
    && isValidCollapsedBlockIds(value.collapsedBlockIds)
    && (value.expandedPageIds === undefined || (Array.isArray(value.expandedPageIds)
      && value.expandedPageIds.length <= 256
      && value.expandedPageIds.every(id => typeof id === "string" && validUiStateId(id))
      && new Set(value.expandedPageIds).size === value.expandedPageIds.length))
    && (value.activeViewIds === undefined || (value.activeViewIds && typeof value.activeViewIds === "object" && !Array.isArray(value.activeViewIds)
      && Object.keys(value.activeViewIds).length <= 256
      && Object.entries(value.activeViewIds).every(([databaseId, viewId]) => validUiStateId(databaseId) && validUiStateId(viewId)))));
}
