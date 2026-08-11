export function applyLocalEdit(document, candidate, timestamp) {
  const page = id => document.workspace.pages.find(item => item.id === id);
  if (candidate.type === "page.rename") {
    const target = page(candidate.payload.pageId);
    target.title = candidate.payload.title;
    target.updatedAt = timestamp;
    const database = document.workspace.databases.find(item => item.pageId === target.id);
    if (database) database.name = candidate.payload.title;
  } else if (candidate.type === "page.replace-blocks") {
    const target = page(candidate.payload.pageId);
    target.blocks = structuredClone(candidate.payload.blocks);
    target.updatedAt = timestamp;
  } else if (candidate.type === "database.record-update") {
    const target = page(candidate.payload.pageId);
    target.properties ??= {};
    for (const [propertyId, value] of Object.entries(candidate.payload.values)) {
      if (value === undefined) delete target.properties[propertyId];
      else target.properties[propertyId] = structuredClone(value);
    }
    target.updatedAt = timestamp;
  } else if (candidate.type === "database.view-update") {
    const database = document.workspace.databases.find(item => item.id === candidate.payload.databaseId);
    const view = database.views.find(item => item.id === candidate.payload.viewId);
    Object.assign(view, structuredClone(candidate.payload.patch));
  } else {
    throw new Error("Unsupported local edit command");
  }
}

export async function confirmBrowserEdit(confirmedState, candidate, save, timestamp = () => new Date().toISOString()) {
  const next = structuredClone(confirmedState);
  const stamp = timestamp();
  applyLocalEdit(next, candidate, stamp);
  next.workspace.updatedAt = stamp;
  next.revision += 1;
  await save(structuredClone(next));
  return next;
}
