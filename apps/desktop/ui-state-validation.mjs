const UI_STATE_FIELDS = new Set(["workspaceId", "activePageId", "expandedPageIds"]);
const UI_STATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const validUiStateId = value => value === null || (typeof value === "string" && UI_STATE_ID.test(value));

export function isValidUiState(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && !Object.keys(value).some(key => !UI_STATE_FIELDS.has(key))
    && validUiStateId(value.workspaceId ?? null)
    && validUiStateId(value.activePageId ?? null)
    && (value.expandedPageIds === undefined || (Array.isArray(value.expandedPageIds)
      && value.expandedPageIds.length <= 256
      && value.expandedPageIds.every(id => typeof id === "string" && validUiStateId(id))
      && new Set(value.expandedPageIds).size === value.expandedPageIds.length)));
}
