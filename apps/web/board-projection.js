import { livePropertyDefinitions } from "./property-lifecycle.js";
import { selectDatabaseRecords } from "./record-selector.js";

const groupableTypes = new Set(["select", "status"]);

export function boardGroupingProperties(database) {
  return livePropertyDefinitions(database).filter(property => groupableTypes.has(property.type));
}

/**
 * Pure first-level board projection. A lane's value is its stable option ID;
 * null is the unassigned value already supported by the canonical record
 * command and JSON transport. No lane identities or layout settings are stored.
 * Unsupported configurations remain explicit and retain the selected records.
 */
export function projectBoardView(workspace, database, view, instant = new Date()) {
  if (view.type !== "board") throw new TypeError("Expected a board view");
  const records = selectDatabaseRecords(workspace, database, view, instant);
  const base = { records, groups: [] };
  if (view.groupByPropertyId === undefined) return { ...base, state: "unconfigured", reason: "grouping-required" };
  const property = livePropertyDefinitions(database).find(candidate => candidate.id === view.groupByPropertyId);
  if (!property) return { ...base, state: "unconfigured", reason: "grouping-property-unavailable" };
  if (!groupableTypes.has(property.type)) return { ...base, state: "unsupported", reason: "grouping-property-type" };
  if (view.subgroupByPropertyId !== undefined) return { ...base, state: "unsupported", reason: "subgroup" };

  const groups = (property.options ?? []).map(option => ({ value: option.id, label: option.name, records: [] }));
  const unassigned = { value: null, label: "Unassigned", records: [] };
  const byValue = new Map(groups.map(group => [group.value, group]));
  for (const record of records) {
    const value = record.properties?.[property.id];
    const group = value == null ? unassigned : byValue.get(value);
    if (!group) throw new Error("A record references an unavailable board option");
    group.records.push(record);
  }
  groups.push(unassigned);
  return { state: "ready", propertyId: property.id, propertyName: property.name, records, groups };
}
