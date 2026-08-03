const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PAGE_TYPES = new Set(["document", "database"]);
const MAX_PAGES = 100_000;

const fail = message => { throw new Error(`Invalid Motion workspace: ${message}`); };
const text = (value, field, max = 100_000) => {
  if (typeof value !== "string" || value.length > max) fail(`${field} must be a string no longer than ${max} characters`);
  return value;
};
const id = (value, field) => {
  if (typeof value !== "string" || !ID.test(value)) fail(`${field} is not a safe stable ID`);
  return value;
};
const integer = (value, field, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${field} must be an integer from ${min} to ${max}`);
  return value;
};

function unique(items, field) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) fail(`duplicate ${field} ID: ${item.id}`);
    seen.add(item.id);
  }
}

function normalizeBlock(value, pageId, position) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`page ${pageId} block ${position} must be an object`);
  const block = {
    id: id(value.id, `page ${pageId} block ${position} ID`),
    type: text(value.type, `page ${pageId} block ${position} type`, 128),
    text: text(value.text ?? "", `page ${pageId} block ${position} text`),
    indent: integer(value.indent ?? 0, `page ${pageId} block ${position} indent`, 0, 4),
    links: []
  };
  if (value.checked !== undefined) block.checked = Boolean(value.checked);
  if (value.links !== undefined) {
    if (!Array.isArray(value.links) || value.links.length > 10_000) fail(`page ${pageId} block ${position} links must be an array`);
    block.links = value.links.map((link, at) => {
      if (!link || typeof link !== "object" || Array.isArray(link)) fail(`page ${pageId} block ${position} link ${at} must be an object`);
      return { pageId: link.pageId === null ? null : id(link.pageId, `page ${pageId} block ${position} link target`), title: text(link.title, `page ${pageId} block ${position} link title`, 10_000) };
    });
  }
  return block;
}

function normalizePage(value, position) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`page ${position} must be an object`);
  const pageId = id(value.id, `page ${position} ID`);
  const type = PAGE_TYPES.has(value.type) ? value.type : fail(`page ${pageId} has unsupported type`);
  const page = {
    id: pageId,
    parentId: value.parentId === null ? null : id(value.parentId, `page ${pageId} parent ID`),
    order: integer(value.order, `page ${pageId} order`),
    type,
    title: text(value.title, `page ${pageId} title`, 10_000)
  };
  if (value.archived !== undefined) page.archived = Boolean(value.archived);
  page.deleted = Boolean(value.deleted);
  if (type === "document") {
    if (!Array.isArray(value.blocks) || value.blocks.length > 100_000) fail(`page ${pageId} blocks must be an array`);
    page.blocks = value.blocks.map((block, at) => normalizeBlock(block, pageId, at));
    unique(page.blocks, `block in page ${pageId}`);
  } else {
    if (!Array.isArray(value.columns) || value.columns.length > 1_000) fail(`page ${pageId} columns must be an array`);
    if (!Array.isArray(value.rows) || value.rows.length > 100_000) fail(`page ${pageId} rows must be an array`);
    page.columns = value.columns.map((column, at) => {
      if (!column || typeof column !== "object" || Array.isArray(column)) fail(`page ${pageId} column ${at} must be an object`);
      return { id: id(column.id, `page ${pageId} column ${at} ID`), name: text(column.name, `page ${pageId} column ${at} name`, 10_000), type: "text" };
    });
    unique(page.columns, `column in page ${pageId}`);
    const columnIds = new Set(page.columns.map(column => column.id));
    page.rows = value.rows.map((row, at) => {
      if (!row || typeof row !== "object" || Array.isArray(row) || !row.values || typeof row.values !== "object" || Array.isArray(row.values)) fail(`page ${pageId} row ${at} is invalid`);
      const values = {};
      for (const [columnId, cell] of Object.entries(row.values)) {
        if (!columnIds.has(columnId)) fail(`page ${pageId} row ${at} references an unknown column`);
        values[columnId] = text(cell, `page ${pageId} row ${at} cell`, 100_000);
      }
      return { id: id(row.id, `page ${pageId} row ${at} ID`), values };
    });
    unique(page.rows, `row in page ${pageId}`);
  }
  return page;
}

export function normalizeWorkspaceV1(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || !Array.isArray(value.pages) || value.pages.length > MAX_PAGES) fail("unsupported schema or pages collection");
  const pages = value.pages.map(normalizePage);
  unique(pages, "page");
  const stableIds = new Set();
  const register = (stableId, kind) => {
    if (stableIds.has(stableId)) fail(`duplicate stable ID across workspace: ${stableId} (${kind})`);
    stableIds.add(stableId);
  };
  for (const page of pages) {
    register(page.id, "page");
    for (const block of page.blocks ?? []) register(block.id, "block");
    for (const column of page.columns ?? []) register(column.id, "column");
    for (const row of page.rows ?? []) register(row.id, "row");
  }
  const byId = new Map(pages.map(page => [page.id, page]));
  for (const page of pages) if (page.parentId !== null && !byId.has(page.parentId)) fail(`page ${page.id} has a missing parent`);
  for (const page of pages) {
    const ancestors = new Set([page.id]);
    let parentId = page.parentId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) fail(`page hierarchy contains a cycle at ${page.id}`);
      ancestors.add(parentId);
      parentId = byId.get(parentId).parentId;
    }
  }
  const activePageId = value.activePageId === null ? null : id(value.activePageId, "active page ID");
  if (activePageId !== null && !byId.has(activePageId)) fail("active page does not exist");
  return { schemaVersion: 1, pages, activePageId };
}
