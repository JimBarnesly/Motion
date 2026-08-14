const FILTER_REFERENCE_FIELDS = ["groupByPropertyId", "subgroupByPropertyId", "calendarDatePropertyId", "timelineStartPropertyId", "timelineEndPropertyId"];

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
