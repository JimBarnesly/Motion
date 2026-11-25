import { canContainBlockChildren, cloneBlockSubtree, findBlockLocation } from "./block-tree.js";

function requiredBlock(page, id) {
  const location = findBlockLocation(page.blocks, id);
  if (!location) throw new Error("Block was not found");
  return location;
}

function transformBlock(block, transform) {
  if (!canContainBlockChildren(transform.type) && block.children.length) throw new Error(`Block type ${transform.type} cannot contain children`);
  for (const key of ["checked", "language", "attachmentId", "headingLevel", "pageId", "viewId", "date", "url"]) delete block[key];
  Object.assign(block, structuredClone(transform));
}

function duplicateBlock(workspace, page, blockId, newBlockId) {
  const location = requiredBlock(page, blockId);
  const copy = cloneBlockSubtree(workspace, location.block, newBlockId);
  location.blocks.splice(location.index + 1, 0, copy);
}

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
    const { block } = requiredBlock(target, candidate.payload.blockId);
    block.text = candidate.payload.content.text;
    if (candidate.payload.content.references !== undefined) block.references = structuredClone(candidate.payload.content.references);
    target.updatedAt = timestamp;
  } else if (candidate.type === "block.transform") {
    const target = page(candidate.payload.pageId);
    const { block } = requiredBlock(target, candidate.payload.blockId);
    transformBlock(block, candidate.payload.transform);
    target.updatedAt = timestamp;
  } else if (candidate.type === "block.duplicate") {
    const target = page(candidate.payload.pageId);
    duplicateBlock(document.workspace, target, candidate.payload.blockId, candidate.payload.newBlockId);
    target.updatedAt = timestamp;
  } else if (candidate.type === "block.indent" || candidate.type === "block.outdent") {
    const target = page(candidate.payload.pageId);
    const location = requiredBlock(target, candidate.payload.blockId);
    if (candidate.type === "block.indent") {
      if (location.index === 0) throw new Error("Block has no previous sibling to indent under");
      const parent = location.blocks[location.index - 1];
      if (!canContainBlockChildren(parent.type)) throw new Error(`Block type ${parent.type} cannot contain children`);
      const moving = location.blocks.splice(location.index, 1)[0];
      (parent.children ??= []).push(moving);
    } else {
      if (!location.parent) throw new Error("Top-level block cannot be outdented");
      const moving = location.blocks.splice(location.index, 1)[0];
      const destination = requiredBlock(target, location.parent.id);
      destination.blocks.splice(destination.index + 1, 0, moving);
    }
    target.updatedAt = timestamp;
  } else if (candidate.type === "block.batch") {
    for (const command of candidate.payload.commands) {
      const target = page(command.pageId);
      if (command.type === "block.delete") {
        const location = requiredBlock(target, command.blockId);
        location.blocks.splice(location.index, 1);
      } else if (command.type === "block.update-content") {
        const { block } = requiredBlock(target, command.blockId);
        block.text = command.content.text;
        if (command.content.references !== undefined) block.references = structuredClone(command.content.references);
        else delete block.references;
      } else if (command.type === "block.transform") {
        const { block } = requiredBlock(target, command.blockId);
        transformBlock(block, command.transform);
      } else if (command.type === "block.duplicate") {
        duplicateBlock(document.workspace, target, command.blockId, command.newBlockId);
      } else if (command.type === "block.create") {
        const parent = command.position.parentBlockId === null ? null : requiredBlock(target, command.position.parentBlockId).block;
        if (parent && !canContainBlockChildren(parent.type)) throw new Error(`Block type ${parent.type} cannot contain children`);
        const siblings = parent ? (parent.children ??= []) : target.blocks;
        const index = command.position.beforeBlockId === null ? siblings.length : siblings.findIndex(block => block.id === command.position.beforeBlockId);
        if (index < 0) throw new Error("Paste insertion target was not found");
        siblings.splice(index, 0, structuredClone(command.block));
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
