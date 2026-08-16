import { matchesRelativeDate } from "./relative-date.js";

export function matchesFilter(condition, page, instant = new Date(), properties = []) {
  if (!condition || typeof condition !== "object") return false;
  if (condition.kind === "and") return Array.isArray(condition.children) && condition.children.every(item => matchesFilter(item, page, instant, properties));
  if (condition.kind === "or") return Array.isArray(condition.children) && condition.children.some(item => matchesFilter(item, page, instant, properties));
  if (condition.kind === "not") return !matchesFilter(condition.child, page, instant, properties);
  if (condition.kind !== "condition") return false;
  const propertyType = properties.find(property => property.id === condition.propertyId)?.type;
  const actual = propertyType === "created-time" ? page.createdAt : propertyType === "updated-time" ? page.updatedAt : page.properties?.[condition.propertyId], expected = condition.value;
  const empty = actual == null || actual === "" || (Array.isArray(actual) && !actual.length);
  const evaluator = {
    equals: () => JSON.stringify(actual) === JSON.stringify(expected),
    "not-equals": () => JSON.stringify(actual) !== JSON.stringify(expected),
    contains: () => Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected ?? "")),
    "not-contains": () => !(Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected ?? ""))),
    gt: () => actual > expected, gte: () => actual >= expected, lt: () => actual < expected, lte: () => actual <= expected,
    before: () => actual < expected, after: () => actual > expected,
    "is-empty": () => empty, "is-not-empty": () => !empty,
    "relative-date": () => matchesRelativeDate(actual, expected, instant)
  }[condition.operator];
  return evaluator ? evaluator() : false;
}
