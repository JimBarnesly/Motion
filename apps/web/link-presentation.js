export function buildLinkEntries({ pages, links, pageId, direction }) {
  if (direction !== "incoming" && direction !== "outgoing") throw new Error("Link direction must be incoming or outgoing");
  const pagesById = new Map(pages.map(page => [page.id, page]));
  const relevant = links.filter(link => direction === "incoming" ? link.targetPageId === pageId : link.sourcePageId === pageId);
  const seenTargets = new Set();
  const presented = direction === "incoming" ? relevant : relevant.filter(link => {
    if (seenTargets.has(link.targetPageId)) return false;
    seenTargets.add(link.targetPageId);
    return true;
  });
  return presented.map(link => {
    const linkedPageId = direction === "incoming" ? link.sourcePageId : link.targetPageId;
    const page = pagesById.get(linkedPageId);
    return {
      pageId: linkedPageId,
      blockId: link.blockId,
      title: page?.title || (page ? "Untitled" : "Missing page"),
      status: page ? (page.deletedAt ? "trashed" : "live") : "missing"
    };
  });
}

export function linkEntryLabel(entry) {
  if (entry.status === "trashed") return `${entry.title} — In Trash`;
  if (entry.status === "missing") return `${entry.title} — Missing`;
  return entry.title;
}
