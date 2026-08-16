import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { matchesRelativeDate as matchesCoreRelativeDate } from "../../../packages/core/dist/relative-date.js";
import { FILTER_OPERATOR_CHOICES, buildFilterCondition, createFilterValueControl, filterValueControlHtml } from "../filter-controls.js";
import { RELATIVE_DATE_PRESETS, matchesRelativeDate } from "../relative-date.js";
import { matchesFilter } from "../filtering.js";

const instant = new Date("2026-03-16T12:00:00.000Z");

test("browser relative-date evaluation stays in parity with canonical core", () => {
  assert.deepEqual(RELATIVE_DATE_PRESETS, ["today", "yesterday", "tomorrow", "past-week", "next-week", "past-month", "next-month"]);
  const values = [
    "2026-03-16T00:00:00.000Z",
    "2026-03-17T00:00:00.000Z",
    { start: "2026-03-15T00:00:00.000Z", end: "2026-03-16T00:00:00.000Z" },
    { start: "2026-03-17T00:00:00.000Z" },
    null
  ];
  for (const preset of RELATIVE_DATE_PRESETS) for (const value of values) {
    assert.equal(matchesRelativeDate(value, preset, instant), matchesCoreRelativeDate(value, preset, instant), `${preset}: ${JSON.stringify(value)}`);
  }
  assert.equal(matchesRelativeDate(values[0], "someday", instant), false, "unknown presets fail closed in browser evaluation");
});

test("browser filter evaluation preserves nested AND OR NOT with one injected instant", () => {
  const filter = { kind: "and", children: [
    { kind: "or", children: [
      { kind: "condition", propertyId: "date", operator: "relative-date", value: "today" },
      { kind: "condition", propertyId: "state", operator: "equals", value: "queued" }
    ] },
    { kind: "not", child: { kind: "condition", propertyId: "state", operator: "equals", value: "closed" } }
  ] };
  assert.equal(matchesFilter(filter, { properties: { date: "2026-03-16T23:59:59.999Z", state: "open" } }, instant), true);
  assert.equal(matchesFilter(filter, { properties: { date: "2026-03-17T00:00:00.000Z", state: "closed" } }, instant), false);
  assert.equal(matchesFilter({ kind: "condition", propertyId: "date", operator: "relative-date", value: "invalid" }, { properties: { date: "2026-03-16T12:00:00.000Z" } }, instant), false);
});

test("browser relative-date filtering projects created-time and updated-time like canonical core", () => {
  const page = { createdAt: "2026-03-16T08:00:00.000Z", updatedAt: "2026-03-17T08:00:00.000Z", properties: {} };
  const properties = [{ id: "created", type: "created-time" }, { id: "updated", type: "updated-time" }];
  assert.equal(matchesFilter({ kind: "condition", propertyId: "created", operator: "relative-date", value: "today" }, page, instant, properties), true);
  assert.equal(matchesFilter({ kind: "condition", propertyId: "updated", operator: "relative-date", value: "today" }, page, instant, properties), false);
});

test("filter UI exposes readable bounded presets and persists the selected preset", () => {
  assert.ok(FILTER_OPERATOR_CHOICES.some(choice => choice.value === "relative-date" && choice.label === "Relative date"));
  const html = filterValueControlHtml({ type: "date" }, { operator: "relative-date", value: "past-week" });
  assert.match(html, /<select[^>]+data-filter-value/);
  assert.doesNotMatch(html, /<input/);
  for (const [value, label] of [["today", "Today"], ["yesterday", "Yesterday"], ["tomorrow", "Tomorrow"], ["past-week", "Past week"], ["next-week", "Next week"], ["past-month", "Past month"], ["next-month", "Next month"]]) {
    assert.match(html, new RegExp(`value="${value}"[^>]*>${label}<`));
  }
  assert.match(html, /value="past-week" selected/);
  assert.deepEqual(buildFilterCondition({ id: "due", type: "date" }, "relative-date", "next-month"), { kind: "condition", propertyId: "due", operator: "relative-date", value: "next-month" });
  assert.throws(() => buildFilterCondition({ id: "due", type: "date" }, "relative-date", "someday"), /relative-date preset/i);
  assert.throws(() => buildFilterCondition({ id: "name", type: "plain-text" }, "relative-date", "today"), /date property/i);
});

test("browser app uses canonical relative-date filtering and ships its modules", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  assert.match(app, /import \{ matchesFilter \} from "\.\/filtering\.js"/);
  assert.match(app, /buildFilterCondition/);
  assert.match(app, /filterValueControlHtml/);
  assert.doesNotMatch(app, /function matches\(/);
  for (const file of ["filtering.js", "filter-controls.js", "relative-date.js"]) assert.match(build, new RegExp(`"${file.replace(".", "\\.")}"`));
});

test("dynamic relative-date controls are built without an HTML sink", () => {
  const document = { createElement(tagName) { return { tagName, dataset:{}, children:[], append(...children) { this.children.push(...children); } }; } };
  const control = createFilterValueControl(document, { operator:"relative-date", value:"next-week" });
  assert.equal(control.tagName, "select");
  assert.equal(control.dataset.filterValue, "");
  assert.equal(control.children.length, RELATIVE_DATE_PRESETS.length);
  assert.equal(control.children.find(option => option.selected)?.value, "next-week");
});
