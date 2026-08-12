function requireIdentity(value, label) {
  if (typeof value !== "string" || value.length === 0 || value === "." || value === "..") throw new Error(`${label} ID is required`);
  return value;
}

export function buildInternalUrl({ workspaceId, pageId, blockId }) {
  const workspace = encodeURIComponent(requireIdentity(workspaceId, "workspace"));
  const page = encodeURIComponent(requireIdentity(pageId, "page"));
  const block = blockId === undefined ? "" : `?block=${encodeURIComponent(requireIdentity(blockId, "block"))}`;
  return `motion://open/${workspace}/${page}${block}`;
}

export function parseInternalUrl(value) {
  try {
    if (typeof value !== "string" || /%(?![0-9a-f]{2})/i.test(value) || /[&?]$|&&/.test(value)) return null;
    const url = new URL(value);
    if (url.protocol !== "motion:" || url.hostname !== "open" || url.username || url.password || url.port || url.hash) return null;
    const segments = url.pathname.split("/").slice(1);
    if (segments.length !== 2 || segments.some(segment => segment.length === 0)) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => key !== "block") || url.searchParams.getAll("block").length > 1) return null;
    const block = url.searchParams.get("block");
    if (block === "") return null;
    const parsed = {
      workspaceId: decodeURIComponent(segments[0]),
      pageId: decodeURIComponent(segments[1]),
      ...(block === null ? {} : { blockId: block })
    };
    return buildInternalUrl(parsed) === value ? parsed : null;
  } catch {
    return null;
  }
}
