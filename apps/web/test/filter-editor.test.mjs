import assert from "node:assert/strict";
import test from "node:test";
import { filterConditionFromControls, filterOperatorsForProperty, restoreFilterNegations, unwrapFilterNegations } from "../filter-editor.js";
import { matchesFilter } from "../filtering.js";

test("editing an untouched filter retains its typed value and does not mutate it", () => {
  for (const value of [null, false, 0, ["a", "b"], { start: "2026-11-25T00:00:00.000Z" }]) {
    const original = { kind: "condition", propertyId: "property", operator: "equals", value };
    const raw = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    const restored = filterConditionFromControls(original, { id: "property", type: "text" }, "equals", raw);
    assert.deepEqual(restored, original);
    assert.notEqual(restored, original);
  }
});

test("filter drafts validate numeric and boolean edits instead of silently coercing invalid values", () => {
  const number = { id: "cost", name: "Cost", type: "number" };
  assert.equal(filterConditionFromControls(null, number, "gt", "4200").value, 4200);
  for (const value of ["", " ", "Infinity", "four"]) assert.throws(() => filterConditionFromControls(null, number, "gt", value), /finite number/);
  const checkbox = { id: "done", name: "Done", type: "checkbox" };
  assert.equal(filterConditionFromControls(null, checkbox, "equals", "false").value, false);
  assert.throws(() => filterConditionFromControls(null, checkbox, "equals", "yes"), /true or false/);
  assert.deepEqual(filterConditionFromControls(null, number, "is-empty", "invalid"), { kind: "condition", propertyId: "cost", operator: "is-empty" });
});

test("untouched repeated negations retain their complete expression tree", () => {
  const leaf = { kind: "condition", propertyId: "status", operator: "equals", value: "open" };
  const expression = { kind: "not", child: { kind: "not", child: leaf } };
  const { node, count } = unwrapFilterNegations(expression);
  assert.equal(count, 2);
  assert.deepEqual(restoreFilterNegations(node, count, false), expression);
  assert.deepEqual(restoreFilterNegations(node, count, true), { kind: "not", child: leaf });
});

test("nested conditions filter titles and stored properties consistently", () => {
  const filter = { kind: "and", children: [
    { kind: "or", children: [
      { kind: "condition", propertyId: "title", operator: "contains", value: "Pump" },
      { kind: "condition", propertyId: "cost", operator: "gt", value: 500 }
    ] },
    { kind: "not", child: { kind: "condition", propertyId: "done", operator: "equals", value: true } }
  ] };
  const properties = [{ id: "title", type: "title" }, { id: "cost", type: "number" }, { id: "done", type: "checkbox" }];
  assert.equal(matchesFilter(filter, { title: "Pump service", properties: { cost: 100, done: false } }, new Date(), properties), true);
  assert.equal(matchesFilter(filter, { title: "Pump service", properties: { cost: 900, done: true } }, new Date(), properties), false);
  assert.equal(matchesFilter(filter, { title: "Lighting", properties: { cost: 100, done: false } }, new Date(), properties), false);
});

test("filter editing does not offer collection comparisons without a working canonical operand contract", () => {
  const property = { id: "tags", type: "multi-select", name: "Tags" };
  assert.deepEqual(filterOperatorsForProperty(property).map(choice => choice.value), ["equals", "not-equals", "is-empty", "is-not-empty"]);
  assert.throws(() => filterConditionFromControls(null, property, "contains", '["tag"]'), /supported comparison/);
  const existing = { kind: "condition", propertyId: "tags", operator: "contains", value: ["tag"] };
  assert.deepEqual(filterConditionFromControls(existing, property, "contains", '["tag"]'), existing);
});

test("actor metadata filters use the same page-field projection as record controls", () => {
  const page = { title: "Record", createdBy: "creator", updatedBy: "editor", properties: {} };
  const properties = [{ id: "author", type: "created-by" }, { id: "last-editor", type: "updated-by" }];
  assert.equal(matchesFilter({ kind: "condition", propertyId: "author", operator: "equals", value: "creator" }, page, new Date(), properties), true);
  assert.equal(matchesFilter({ kind: "condition", propertyId: "last-editor", operator: "equals", value: "editor" }, page, new Date(), properties), true);
});
