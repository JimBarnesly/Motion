const FILTER_REFERENCE_FIELDS = ["groupByPropertyId", "subgroupByPropertyId", "calendarDatePropertyId", "timelineStartPropertyId", "timelineEndPropertyId"];
const PROPERTY_FIELDS = new Set(["id", "name", "type", "relation", "relationDatabaseId", "options", "validation", "deletedAt"]);
const VALIDATION_FIELDS = new Set(["required", "min", "max", "minLength", "maxLength"]);
const OPTION_FIELDS = new Set(["id", "name", "color"]);
const RELATION_FIELDS = new Set(["targetCollectionId", "reciprocalPropertyId", "cardinality", "maxItems", "onDelete"]);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const closed = (value, fields, label) => { if (!plain(value) || Object.keys(value).some(key => !fields.has(key))) throw new Error(`${label} has an invalid shape`); };
const liveReference = (value, liveIds, label) => { if (typeof value !== "string" || !liveIds.has(value)) throw new Error(`${label} must reference a live property`); };
function validateFilterReferences(filter, liveIds, depth = 0) {
  if (!plain(filter) || depth > 64) throw new Error("Filter has an invalid shape");
  if (filter.kind === "condition") return liveReference(filter.propertyId, liveIds, "Filter");
  if (filter.kind === "not") return validateFilterReferences(filter.child, liveIds, depth + 1);
  if ((filter.kind !== "and" && filter.kind !== "or") || !Array.isArray(filter.children)) throw new Error("Filter has an invalid shape");
  filter.children.forEach(child => validateFilterReferences(child, liveIds, depth + 1));
}
export function assertSafePropertyLifecycle(workspace) {
  if (!plain(workspace) || !Array.isArray(workspace.databases)) throw new Error("Workspace lifecycle has an invalid shape");
  for (const database of workspace.databases) {
    if (!plain(database) || !Array.isArray(database.properties) || !Array.isArray(database.views)) throw new Error("Database lifecycle has an invalid shape");
    const ids = new Set();
    for (const property of database.properties) {
      closed(property, PROPERTY_FIELDS, "Property");
      if (typeof property.id !== "string" || !property.id || ids.has(property.id)) throw new Error("Property IDs must be unique strings");
      ids.add(property.id);
      if (property.validation !== undefined) closed(property.validation, VALIDATION_FIELDS, "Property validation");
      if (property.options !== undefined) { if (!Array.isArray(property.options)) throw new Error("Property options have an invalid shape"); property.options.forEach(option => closed(option, OPTION_FIELDS, "Property option")); }
      if (property.relation !== undefined) closed(property.relation, RELATION_FIELDS, "Property relation");
    }
    const live = database.properties.filter(property => property.deletedAt === undefined), liveIds = new Set(live.map(property => property.id));
    const order = database.propertyOrder ?? live.map(property => property.id);
    if (!Array.isArray(order) || order.length !== live.length || new Set(order).size !== order.length || order.some(propertyId => !liveIds.has(propertyId))) throw new Error("Canonical property order must contain every live property exactly once");
    const titles = database.properties.filter(property => property.type === "title");
    if (titles.length && (titles.length !== 1 || titles[0].deletedAt !== undefined)) throw new Error("Database must retain exactly one live title property");
    for (const view of database.views) {
      if (!plain(view) || !Array.isArray(view.visiblePropertyIds)) throw new Error("View lifecycle has an invalid shape");
      for (const propertyId of view.visiblePropertyIds) liveReference(propertyId, liveIds, "Visible property");
      for (const propertyId of view.propertyOrder ?? []) liveReference(propertyId, liveIds, "View property order");
      for (const propertyId of Object.keys(view.columnWidths ?? {})) liveReference(propertyId, liveIds, "Column width");
      for (const sort of view.sorts ?? []) liveReference(sort?.propertyId, liveIds, "Sort");
      if (view.filters !== undefined) validateFilterReferences(view.filters, liveIds);
      for (const field of FILTER_REFERENCE_FIELDS) if (view[field] !== undefined) liveReference(view[field], liveIds, field);
    }
  }
  return true;
}

export function livePropertyDefinitions(database) {
  const live = database.properties.filter(property => property.deletedAt === undefined);
  const byId = new Map(live.map(property => [property.id, property]));
  const order = database.propertyOrder ?? live.map(property => property.id);
  return order.map(propertyId => byId.get(propertyId)).filter(Boolean);
}

export function reorderPropertyDefinitions(database, orderedPropertyIds) {
  const live = database.properties.filter(property => property.deletedAt === undefined);
  const liveIds = new Set(live.map(property => property.id));
  if (!Array.isArray(orderedPropertyIds) || orderedPropertyIds.length !== live.length || new Set(orderedPropertyIds).size !== orderedPropertyIds.length || orderedPropertyIds.some(propertyId => !liveIds.has(propertyId))) {
    throw new Error("Property order must contain every live property exactly once");
  }
  if (live.some(property => property.type === "title") && !orderedPropertyIds.some(propertyId => live.find(property => property.id === propertyId)?.type === "title")) {
    throw new Error("Property order must retain the title property");
  }
  const byId = new Map(database.properties.map(property => [property.id, property]));
  database.propertyOrder = [...orderedPropertyIds];
  database.properties = [...orderedPropertyIds.map(propertyId => byId.get(propertyId)), ...database.properties.filter(property => property.deletedAt !== undefined)];
}

function removeFilterProperty(filter, propertyId) {
  if (filter.kind === "condition") return filter.propertyId === propertyId ? undefined : filter;
  if (filter.kind === "not") {
    const child = removeFilterProperty(filter.child, propertyId);
    return child ? { ...filter, child } : undefined;
  }
  const children = filter.children.map(child => removeFilterProperty(child, propertyId)).filter(Boolean);
  if (!children.length) return undefined;
  if (children.length === 1) return children[0];
  return { ...filter, children };
}

export function tombstonePropertyDefinition(database, propertyId, deletedAt) {
  const property = database.properties.find(candidate => candidate.id === propertyId);
  if (!property || property.deletedAt) throw new Error(`Property is missing or tombstoned: ${propertyId}`);
  if (property.type === "title") throw new Error("The title property cannot be deleted");
  property.deletedAt = deletedAt;
  database.propertyOrder = (database.propertyOrder ?? database.properties.map(candidate => candidate.id)).filter(id => id !== propertyId);
  for (const view of database.views) {
    view.visiblePropertyIds = view.visiblePropertyIds.filter(id => id !== propertyId);
    if (view.propertyOrder) view.propertyOrder = view.propertyOrder.filter(id => id !== propertyId);
    if (view.columnWidths) delete view.columnWidths[propertyId];
    if (view.sorts) view.sorts = view.sorts.filter(sort => sort.propertyId !== propertyId);
    if (view.filters) view.filters = removeFilterProperty(view.filters, propertyId);
    for (const field of FILTER_REFERENCE_FIELDS) if (view[field] === propertyId) delete view[field];
  }
  return property;
}
