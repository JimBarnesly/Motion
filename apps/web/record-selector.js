import { matchesFilter } from "./filtering.js";
import { propertyValueForRecord } from "./property-editors.js";

/**
 * Select canonical record pages without writing display values into them.
 * Sorting follows WorkspaceDocument.queryRecords: null placement is independent
 * of direction, each string clause keeps its locale, and ties retain the
 * collection's manual recordPageIds order. Returned pages retain their identity.
 */
export function selectDatabaseRecords(workspace, database, view = {}, instant = new Date()) {
  const pages = new Map(workspace.pages.map(page => [page.id, page]));
  const properties = database.properties.filter(property => property.deletedAt === undefined);
  const byPropertyId = new Map(properties.map(property => [property.id, property]));
  let records = (database.recordPageIds ?? []).map(id => pages.get(id)).filter(page => page && !page.deletedAt);
  if (view.filters) records = records.filter(page => matchesFilter(view.filters, page, instant, properties));
  const clauses = (view.sorts ?? []).map(sort => ({ ...sort, property: byPropertyId.get(sort.propertyId) }));
  if (!clauses.length) return records;
  return records.map((page, index) => ({ page, index,
    values: clauses.map(clause => clause.property ? propertyValueForRecord(clause.property, page) : undefined)
  })).sort((left, right) => {
    for (const [index, clause] of clauses.entries()) {
      const a = left.values[index], b = right.values[index];
      if (a == null || b == null) {
        if (a == null && b == null) continue;
        return a == null ? (clause.nulls === "first" ? -1 : 1) : (clause.nulls === "first" ? 1 : -1);
      }
      const comparison = typeof a === "string" && typeof b === "string"
        ? a.localeCompare(b, clause.locale) : a < b ? -1 : a > b ? 1 : 0;
      if (comparison) return clause.direction === "asc" ? comparison : -comparison;
    }
    return left.index - right.index;
  }).map(item => item.page);
}
