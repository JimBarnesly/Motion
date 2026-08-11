import { CANONICAL_MAX_ID_LENGTH, stableIdPattern } from "./id-security.js";

const CANONICAL_ID = stableIdPattern(CANONICAL_MAX_ID_LENGTH);

const fail = path => { throw new Error(`Invalid Motion workspace: ${path} contains an unsafe canonical ID`); };
const id = (value, path) => {
  if (typeof value !== "string" || !CANONICAL_ID.test(value)) fail(path);
  return value;
};
const object = (value, path) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Motion workspace: ${path} must be an object`);
  return value;
};
const array = (value, path) => {
  if (!Array.isArray(value)) throw new Error(`Invalid Motion workspace: ${path} must be an array`);
  return value;
};
const optionalId = (value, path) => { if (value !== undefined) id(value, path); };
const idArray = (value, path) => array(value, path).forEach((entry, index) => id(entry, `${path}[${index}]`));
const idKeys = (value, path) => Object.keys(object(value, path)).forEach(key => id(key, `${path} key`));

function validatePropertyValue(value, property, path) {
  if (value == null) return;
  if (["select", "status", "created-by", "updated-by", "page"].includes(property?.type)) id(value, path);
  else if (["multi-select", "relation"].includes(property?.type)) idArray(value, path);
  else if (property?.type === "files") idArray(object(value, path).attachmentIds, `${path}.attachmentIds`);
}

function validateFilter(filter, properties, path) {
  object(filter, path);
  if (filter.kind === "condition") {
    const propertyId = id(filter.propertyId, `${path}.propertyId`);
    validatePropertyValue(filter.value, properties.get(propertyId), `${path}.value`);
  } else if (filter.kind === "and" || filter.kind === "or") {
    array(filter.children, `${path}.children`).forEach((child, index) => validateFilter(child, properties, `${path}.children[${index}]`));
  } else if (filter.kind === "not") validateFilter(filter.child, properties, `${path}.child`);
}

function validateBlocks(blocks, path) {
  array(blocks, path).forEach((block, index) => {
    const here = `${path}[${index}]`;
    object(block, here);
    id(block.id, `${here}.id`);
    optionalId(block.attachmentId, `${here}.attachmentId`);
    optionalId(block.pageId, `${here}.pageId`);
    optionalId(block.viewId, `${here}.viewId`);
    if (block.references !== undefined) array(block.references, `${here}.references`).forEach((reference, refIndex) => {
      object(reference, `${here}.references[${refIndex}]`);
      id(reference.pageId, `${here}.references[${refIndex}].pageId`);
    });
    validateBlocks(block.children, `${here}.children`);
  });
}

export function assertSafeCanonicalWorkspaceIds(workspace) {
  object(workspace, "workspace");
  if (workspace.schemaVersion !== 2) throw new Error("Invalid Motion workspace: schemaVersion must be 2");
  id(workspace.id, "id");
  array(workspace.attachments, "attachments").forEach((attachment, index) => {
    object(attachment, `attachments[${index}]`);
    id(attachment.id, `attachments[${index}].id`);
  });

  const properties = new Map();
  array(workspace.databases, "databases").forEach((database, dbIndex) => {
    object(database, `databases[${dbIndex}]`);
    array(database.properties, `databases[${dbIndex}].properties`).forEach((property, propertyIndex) => {
      const path = `databases[${dbIndex}].properties[${propertyIndex}]`;
      object(property, path);
      properties.set(id(property.id, `${path}.id`), property);
      if (property.options !== undefined) array(property.options, `${path}.options`).forEach((option, optionIndex) => {
        object(option, `${path}.options[${optionIndex}]`);
        id(option.id, `${path}.options[${optionIndex}].id`);
      });
      if (property.relation !== undefined) {
        object(property.relation, `${path}.relation`);
        id(property.relation.targetCollectionId, `${path}.relation.targetCollectionId`);
        optionalId(property.relation.reciprocalPropertyId, `${path}.relation.reciprocalPropertyId`);
      }
      optionalId(property.relationDatabaseId, `${path}.relationDatabaseId`);
    });
  });

  array(workspace.pages, "pages").forEach((page, pageIndex) => {
    const path = `pages[${pageIndex}]`;
    object(page, path);
    id(page.id, `${path}.id`);
    if (page.parentId !== null) id(page.parentId, `${path}.parentId`);
    for (const field of ["createdBy", "updatedBy", "templateOriginId", "collectionId"]) optionalId(page[field], `${path}.${field}`);
    if (page.properties !== undefined) {
      idKeys(page.properties, `${path}.properties`);
      for (const [propertyId, value] of Object.entries(page.properties)) validatePropertyValue(value, properties.get(propertyId), `${path}.properties.${propertyId}`);
    }
    validateBlocks(page.blocks, `${path}.blocks`);
  });

  workspace.databases.forEach((database, dbIndex) => {
    const path = `databases[${dbIndex}]`;
    id(database.id, `${path}.id`);
    id(database.pageId, `${path}.pageId`);
    array(database.rows, `${path}.rows`).forEach((row, rowIndex) => {
      const here = `${path}.rows[${rowIndex}]`;
      object(row, here);
      id(row.id, `${here}.id`);
      optionalId(row.pageId, `${here}.pageId`);
      idKeys(row.values, `${here}.values`);
      for (const [propertyId, value] of Object.entries(row.values)) validatePropertyValue(value, properties.get(propertyId), `${here}.values.${propertyId}`);
    });
    if (database.recordPageIds !== undefined) idArray(database.recordPageIds, `${path}.recordPageIds`);
    array(database.views, `${path}.views`).forEach((view, viewIndex) => {
      const here = `${path}.views[${viewIndex}]`;
      object(view, here);
      id(view.id, `${here}.id`);
      optionalId(view.collectionId, `${here}.collectionId`);
      idArray(view.visiblePropertyIds, `${here}.visiblePropertyIds`);
      if (view.propertyOrder !== undefined) idArray(view.propertyOrder, `${here}.propertyOrder`);
      if (view.columnWidths !== undefined) idKeys(view.columnWidths, `${here}.columnWidths`);
      if (view.filters !== undefined) validateFilter(view.filters, properties, `${here}.filters`);
      if (view.sorts !== undefined) array(view.sorts, `${here}.sorts`).forEach((sort, sortIndex) => {
        object(sort, `${here}.sorts[${sortIndex}]`);
        id(sort.propertyId, `${here}.sorts[${sortIndex}].propertyId`);
      });
      for (const field of ["groupByPropertyId", "subgroupByPropertyId", "calendarDatePropertyId", "timelineStartPropertyId", "timelineEndPropertyId"]) optionalId(view[field], `${here}.${field}`);
    });
  });

  array(workspace.linkIndex, "linkIndex").forEach((link, index) => {
    object(link, `linkIndex[${index}]`);
    id(link.sourcePageId, `linkIndex[${index}].sourcePageId`);
    id(link.targetPageId, `linkIndex[${index}].targetPageId`);
    id(link.blockId, `linkIndex[${index}].blockId`);
  });
  return workspace;
}

export const escapeAttribute = (value = "") => String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
