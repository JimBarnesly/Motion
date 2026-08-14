import { CANONICAL_MAX_ID_LENGTH, stableIdPattern } from "./id-security.js";

const FILTER_REFERENCE_FIELDS = ["groupByPropertyId", "subgroupByPropertyId", "calendarDatePropertyId", "timelineStartPropertyId", "timelineEndPropertyId"];
const CANONICAL_ID = stableIdPattern(CANONICAL_MAX_ID_LENGTH);
const PROPERTY_TYPES = new Set(["title", "plain-text", "rich-text", "number", "checkbox", "select", "multi-select", "status", "date", "date-range", "url", "email", "phone", "files", "created-time", "updated-time", "created-by", "updated-by", "relation", "text", "page"]);
const PROPERTY_FIELDS = new Set(["id", "name", "type", "relation", "relationDatabaseId", "options", "validation", "deletedAt"]);
const VALIDATION_FIELDS = new Set(["required", "min", "max", "minLength", "maxLength"]);
const OPTION_FIELDS = new Set(["id", "name", "color"]);
const RELATION_FIELDS = new Set(["targetCollectionId", "reciprocalPropertyId", "cardinality", "maxItems", "onDelete"]);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const closed = (value, fields, label) => { if (!plain(value) || Object.keys(value).some(key => !fields.has(key))) throw new Error(`${label} has an invalid shape`); };
const canonicalId = (value, label) => { if (typeof value !== "string" || !CANONICAL_ID.test(value)) throw new Error(`${label} must be a canonical ID`); return value; };
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
      canonicalId(property.id, "Property ID");
      if (ids.has(property.id)) throw new Error("Property IDs must be unique strings");
      ids.add(property.id);
      if (typeof property.name !== "string" || !PROPERTY_TYPES.has(property.type)) throw new Error("Property metadata has an invalid shape");
      if (property.validation !== undefined) {
        closed(property.validation, VALIDATION_FIELDS, "Property validation");
        const validation = property.validation;
        if (validation.required !== undefined && typeof validation.required !== "boolean") throw new Error("Property validation required must be boolean");
        for (const key of ["min", "max"]) if (validation[key] !== undefined && (typeof validation[key] !== "number" || !Number.isFinite(validation[key]))) throw new Error("Property validation numeric bounds must be finite");
        for (const key of ["minLength", "maxLength"]) if (validation[key] !== undefined && (!Number.isSafeInteger(validation[key]) || validation[key] < 0)) throw new Error("Property validation length bounds must be non-negative safe integers");
        if (validation.min !== undefined && validation.max !== undefined && validation.min > validation.max) throw new Error("Property validation min/max must be ordered");
        if (validation.minLength !== undefined && validation.maxLength !== undefined && validation.minLength > validation.maxLength) throw new Error("Property validation length bounds must be ordered");
      }
      if (property.options !== undefined) {
        if (!Array.isArray(property.options)) throw new Error("Property options have an invalid shape");
        const optionIds = new Set();
        property.options.forEach(option => { closed(option, OPTION_FIELDS, "Property option"); canonicalId(option.id, "Property option ID"); if (optionIds.has(option.id) || typeof option.name !== "string" || (option.color !== undefined && typeof option.color !== "string")) throw new Error("Property options have invalid metadata"); optionIds.add(option.id); });
      }
      if (property.relation !== undefined) {
        closed(property.relation, RELATION_FIELDS, "Property relation");
        canonicalId(property.relation.targetCollectionId, "Relation target");
        if (property.relation.reciprocalPropertyId !== undefined) canonicalId(property.relation.reciprocalPropertyId, "Reciprocal property");
        if (property.relation.cardinality !== undefined && !["one-to-one", "one-to-many", "many-to-many"].includes(property.relation.cardinality)) throw new Error("Relation cardinality is invalid");
        if (property.relation.maxItems !== undefined && (!Number.isSafeInteger(property.relation.maxItems) || property.relation.maxItems < 1)) throw new Error("Relation maxItems must be a positive safe integer");
        if (property.relation.onDelete !== undefined && !["retain", "remove"].includes(property.relation.onDelete)) throw new Error("Relation onDelete is invalid");
      }
      if (property.relationDatabaseId !== undefined) canonicalId(property.relationDatabaseId, "Relation database");
    }
    const live = database.properties.filter(property => property.deletedAt === undefined), liveIds = new Set(live.map(property => property.id));
    const order = database.propertyOrder ?? live.map(property => property.id);
    if (!Array.isArray(order) || order.length !== live.length || new Set(order).size !== order.length || order.some(propertyId => !liveIds.has(propertyId))) throw new Error("Canonical property order must contain every live property exactly once");
    const titles = database.properties.filter(property => property.type === "title");
    if (titles.length && (titles.length !== 1 || titles[0].deletedAt !== undefined)) throw new Error("Database must retain exactly one live title property");
    if (titles.length && (canonicalId(database.titlePropertyId, "Canonical title property") !== titles[0].id)) throw new Error("Canonical title property identity changed");
    if (!titles.length && database.titlePropertyId !== undefined) throw new Error("Canonical title property identity is invalid");
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
