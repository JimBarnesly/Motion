import { CANONICAL_MAX_ID_LENGTH, stableIdPattern } from "./id-security.js";

const CANONICAL_ID = stableIdPattern(CANONICAL_MAX_ID_LENGTH);
const MAX_BLOCK_DEPTH = 64;
const MAX_BLOCKS = 1_000_000;
const LEAF_BLOCK_TYPES = new Set(["divider", "image", "file", "bookmark", "child-page", "page-mention", "date-mention", "simple-table", "collection-view"]);

export const canContainBlockChildren = type => !LEAF_BLOCK_TYPES.has(type);

function* blockLocations(blocks, parent = null) {
  const pending = [{ blocks: blocks ?? [], parent, index: 0, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const frame = pending.at(-1);
    if (!Array.isArray(frame.blocks) || frame.depth > MAX_BLOCK_DEPTH) throw new Error("Block subtree exceeds limits");
    if (frame.index === frame.blocks.length) { pending.pop(); continue; }
    const index = frame.index++, block = frame.blocks[index];
    if (!block || typeof block !== "object" || !Array.isArray(block.children) || ++count > MAX_BLOCKS) {
      throw new Error("Block subtree exceeds limits");
    }
    yield { block, blocks: frame.blocks, index, parent: frame.parent };
    if (block.children.length) pending.push({ blocks: block.children, parent: block, index: 0, depth: frame.depth + 1 });
  }
}

export function findBlockLocation(blocks, id, parent = null) {
  for (const location of blockLocations(blocks, parent)) if (location.block.id === id) return location;
  return null;
}

function workspaceIdentities(workspace) {
  const ids = new Set([workspace.id]);
  let blockCount = 0;
  for (const attachment of workspace.attachments ?? []) ids.add(attachment.id);
  for (const page of workspace.pages ?? []) {
    ids.add(page.id);
    for (const { block } of blockLocations(page.blocks)) {
      if (++blockCount > MAX_BLOCKS) throw new Error("Block count exceeds limit");
      ids.add(block.id);
    }
  }
  for (const database of workspace.databases ?? []) {
    ids.add(database.id);
    for (const property of database.properties) {
      ids.add(property.id);
      for (const option of property.options ?? []) ids.add(option.id);
    }
    for (const row of database.rows) ids.add(row.id);
    for (const view of database.views) ids.add(view.id);
  }
  return { ids, blockCount };
}

// Match WorkspaceDocument.duplicateBlock: clone every payload unchanged and
// replace only block IDs, using the new root ID plus each descendant's path.
// Validate the entire copy before the caller inserts anything into the tree.
export function cloneBlockSubtree(workspace, block, newRootId) {
  const existing = workspaceIdentities(workspace), generated = new Set();
  const copy = structuredClone(block), pending = [{ block: copy, path: "", depth: 0 }];
  let count = 0;
  while (pending.length) {
    const entry = pending.pop(), candidate = entry.block;
    if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.children)
      || entry.depth > MAX_BLOCK_DEPTH || ++count > MAX_BLOCKS || existing.blockCount + count > MAX_BLOCKS) {
      throw new Error("Block subtree exceeds limits");
    }
    const id = entry.path ? `${newRootId}:${entry.path}` : newRootId;
    if (typeof id !== "string" || !CANONICAL_ID.test(id)) throw new Error("Block ID must be a safe canonical ID");
    if (existing.ids.has(id) || generated.has(id)) throw new Error(`duplicate ID ${id}`);
    generated.add(id);
    candidate.id = id;
    if ((entry.depth >= MAX_BLOCK_DEPTH && candidate.children.length)
      || candidate.children.length > MAX_BLOCKS - count - pending.length) throw new Error("Block subtree exceeds limits");
    for (let index = candidate.children.length - 1; index >= 0; index -= 1) {
      pending.push({ block: candidate.children[index], path: entry.path ? `${entry.path}.${index}` : String(index), depth: entry.depth + 1 });
    }
  }
  return copy;
}
