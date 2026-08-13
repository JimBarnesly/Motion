const LEAF_BLOCK_TYPES = new Set(["divider", "image", "file", "bookmark", "child-page", "page-mention", "date-mention", "simple-table", "collection-view"]);

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
  } else if (candidate.type === "block.update-content") {
    const target = page(candidate.payload.pageId);
    const block = target.blocks.find(item => item.id === candidate.payload.blockId);
    block.text = candidate.payload.content.text;
    if (candidate.payload.content.references !== undefined) block.references = structuredClone(candidate.payload.content.references);
    target.updatedAt = timestamp;
  } else if (candidate.type === "block.transform") {
    const target = page(candidate.payload.pageId);
    const block = target.blocks.find(item => item.id === candidate.payload.blockId);
    for (const key of ["checked", "language", "attachmentId", "headingLevel", "pageId", "viewId", "date", "url"]) delete block[key];
    Object.assign(block, structuredClone(candidate.payload.transform));
    target.updatedAt = timestamp;
  } else if (candidate.type === "block.indent" || candidate.type === "block.outdent") {
    const target = page(candidate.payload.pageId);
    const locate = (blocks, parent = null) => {
      for (let index = 0; index < blocks.length; index += 1) {
        if (blocks[index].id === candidate.payload.blockId) return { blocks, index, parent };
        const nested = locate(blocks[index].children ?? [], blocks[index]);
        if (nested) return nested;
      }
      return null;
    };
    const location = locate(target.blocks);
    if (!location) throw new Error("Block was not found");
    if (candidate.type === "block.indent") {
      if (location.index === 0) throw new Error("Block has no previous sibling to indent under");
      const parent = location.blocks[location.index - 1];
      if (LEAF_BLOCK_TYPES.has(parent.type)) throw new Error(`Block type ${parent.type} cannot contain children`);
      const moving = location.blocks.splice(location.index, 1)[0];
      (parent.children ??= []).push(moving);
    } else {
      if (!location.parent) throw new Error("Top-level block cannot be outdented");
      const moving = location.blocks.splice(location.index, 1)[0];
      const findParent = blocks => {
        const index = blocks.findIndex(block => block.id === location.parent.id);
        if (index >= 0) return { blocks, index };
        for (const block of blocks) { const nested = findParent(block.children ?? []); if (nested) return nested; }
        return null;
      };
      const destination = findParent(target.blocks);
      destination.blocks.splice(destination.index + 1, 0, moving);
    }
    target.updatedAt = timestamp;
  } else if (candidate.type === "block.batch") {
    for (const command of candidate.payload.commands) {
      const target = page(command.pageId);
      if (command.type === "block.delete") {
        target.blocks = target.blocks.filter(block => block.id !== command.blockId);
      } else if (command.type === "block.update-content") {
        const block = target.blocks.find(item => item.id === command.blockId);
        block.text = command.content.text;
        if (command.content.references !== undefined) block.references = structuredClone(command.content.references);
        else delete block.references;
      } else if (command.type === "block.transform") {
        const block = target.blocks.find(item => item.id === command.blockId);
        for (const key of ["checked", "language", "attachmentId", "headingLevel", "pageId", "viewId", "date", "url"]) delete block[key];
        Object.assign(block, structuredClone(command.transform));
      } else if (command.type === "block.create") {
        const index = command.position.beforeBlockId === null ? target.blocks.length : target.blocks.findIndex(block => block.id === command.position.beforeBlockId);
        if (index < 0) throw new Error("Paste insertion target was not found");
        target.blocks.splice(index, 0, structuredClone(command.block));
      } else {
        throw new Error("Unsupported local block batch command");
      }
      target.updatedAt = timestamp;
    }
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
