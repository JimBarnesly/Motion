import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  INITIAL_PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
  applyBrowserPropertyPatch,
  editablePropertyTypes,
  propertyControlHtml,
  propertyDisplayText,
  propertyValueForRecord,
  readPropertyControl,
  restorePropertyControl
} from "../property-editors.js";

const initialTypes = [
  "title", "plain-text", "rich-text", "number", "checkbox", "select", "multi-select", "status",
  "date", "date-range", "url", "email", "phone", "files", "created-time", "updated-time", "created-by", "updated-by"
];

test("initial property controls expose exactly the honest M3 type set", () => {
  assert.deepEqual(INITIAL_PROPERTY_TYPES, initialTypes);
  assert.deepEqual(editablePropertyTypes(), initialTypes.filter(type => type !== "title"));
  assert.deepEqual(Object.keys(PROPERTY_TYPE_LABELS), initialTypes);
  assert.equal(PROPERTY_TYPE_LABELS["rich-text"], "Rich text");
  assert.equal(PROPERTY_TYPE_LABELS["date-range"], "Date range");
});

test("date range controls emit one closed canonical range or clear it", () => {
  const html = propertyControlHtml({ id: "window", name: "Window", type: "date-range" }, undefined, [], "record-1");
  assert.equal((html.match(/aria-label=/g) ?? []).length, 2);
  assert.match(html, /aria-label="Window start"/);
  assert.match(html, /aria-label="Window end"/);
  assert.doesNotMatch(html, /aria-label="Window"(?:\s|>)/);
  const complete = {
    closest: () => ({ querySelector: selector => ({ value: selector.includes("start") ? "2026-08-14" : "2026-08-16" }) })
  };
  assert.deepEqual(readPropertyControl(complete, { type: "date-range" }), {
    start: "2026-08-14T00:00:00.000Z",
    end: "2026-08-16T00:00:00.000Z"
  });
  const partial = {
    closest: () => ({ querySelector: selector => ({ value: selector.includes("start") ? "2026-08-14" : "" }) })
  };
  assert.equal(readPropertyControl(partial, { type: "date-range" }), undefined);
  const reversed = {
    closest: () => ({ querySelector: selector => ({ value: selector.includes("start") ? "2026-08-16" : "2026-08-14" }) })
  };
  assert.throws(() => readPropertyControl(reversed, { type: "date-range" }), /ordered date range/i);
});

test("rejected date-range and files edits restore their complete canonical controls", () => {
  const start = { value: "" }, end = { value: "" }, range = { closest: () => ({ querySelector: selector => selector.includes("start") ? start : end }) };
  restorePropertyControl(range, { type: "date-range" }, { start: "2026-08-14T00:00:00.000Z", end: "2026-08-16T00:00:00.000Z" }, []);
  assert.deepEqual([start.value, end.value], ["2026-08-14", "2026-08-16"]);
  const options = [{ value: "a-1", selected: false }, { value: "a-2", selected: false }], files = { options };
  restorePropertyControl(files, { type: "files" }, { attachmentIds: ["a-2"] }, [{ id: "a-1" }, { id: "a-2" }]);
  assert.deepEqual(options.map(option => option.selected), [false, true]);
});

test("files controls emit only unique selected canonical workspace attachment IDs", () => {
  const target = { selectedOptions: [{ value: "attachment-1" }, { value: "attachment-1" }, { value: "attachment-2" }] };
  const attachments = [{ id: "attachment-1" }, { id: "attachment-2" }, { id: "attachment-3" }];
  assert.deepEqual(readPropertyControl(target, { type: "files" }, attachments), { attachmentIds: ["attachment-1", "attachment-2"] });
  assert.equal(readPropertyControl({ selectedOptions: [] }, { type: "files" }, attachments), undefined);
  assert.deepEqual(readPropertyControl({ selectedOptions: [{ value: "missing" }] }, { type: "files" }, attachments), { attachmentIds: [] });
});

test("system properties project page metadata and render read-only without mutation authority", () => {
  const page = {
    title: "Canonical title", createdAt: "2026-08-14T01:00:00.000Z", updatedAt: "2026-08-14T02:00:00.000Z",
    createdBy: "author", updatedBy: "editor", properties: { created: "forged", editor: "forged" }
  };
  const cases = [
    [{ id: "created", name: "Created", type: "created-time" }, page.createdAt],
    [{ id: "updated", name: "Updated", type: "updated-time" }, page.updatedAt],
    [{ id: "author", name: "Author", type: "created-by" }, page.createdBy],
    [{ id: "editor", name: "Editor", type: "updated-by" }, page.updatedBy]
  ];
  for (const [property, expected] of cases) {
    assert.equal(propertyValueForRecord(property, page), expected);
    const html = propertyControlHtml(property, expected, []);
    assert.match(html, /<output/);
    assert.match(html, /aria-label=/);
    assert.doesNotMatch(html, /data-property=/);
    assert.doesNotMatch(html, /<input|<select/);
  }
  assert.equal(propertyValueForRecord({ id: "title", type: "title" }, page), "Canonical title");
});

test("plain and rich text are escaped text controls, never HTML authority", () => {
  for (const type of ["plain-text", "rich-text"]) {
    const html = propertyControlHtml({ id: "notes", name: "Notes", type }, '<img src=x onerror="alert(1)">', []);
    assert.match(html, /type="text"/);
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /contenteditable/);
  }
});

test("date range and files controls have keyboard-native labelled controls and safe projections", () => {
  const range = propertyControlHtml({ id: "range", name: "Window", type: "date-range" }, { start: "2026-08-14T00:00:00.000Z", end: "2026-08-16T00:00:00.000Z" }, []);
  assert.match(range, /<fieldset/);
  assert.match(range, /aria-label="Window start"/);
  assert.match(range, /aria-label="Window end"/);
  assert.equal((range.match(/data-property="range"/g) ?? []).length, 2);

  const files = propertyControlHtml({ id: "files", name: "Files", type: "files" }, { attachmentIds: ["a-2"] }, [
    { id: "a-1", fileName: '<unsafe>.txt' }, { id: "a-2", fileName: "report.pdf" }
  ]);
  assert.match(files, /<select multiple/);
  assert.match(files, /&lt;unsafe&gt;\.txt/);
  assert.match(files, /value="a-2" selected/);
  assert.equal(propertyDisplayText({ type: "files" }, { attachmentIds: ["a-2"] }, [{ id: "a-2", fileName: "report.pdf" }]), "report.pdf");
  assert.equal(propertyDisplayText({ type: "date-range" }, { start: "2026-08-14T00:00:00.000Z", end: "2026-08-16T00:00:00.000Z" }, []), "2026-08-14 – 2026-08-16");
});

test("populated property type changes fail without deleting browser values", () => {
  const property = { id: "notes", name: "Notes", type: "plain-text" };
  const records = [{ properties: { notes: "old", keep: true } }, { properties: { notes: "other" } }];
  assert.throws(() => applyBrowserPropertyPatch(property, { name: "When", type: "date-range" }, records), /populated|type change/i);
  assert.deepEqual(property, { id: "notes", name: "Notes", type: "plain-text" });
  assert.deepEqual(records, [{ properties: { notes: "old", keep: true } }, { properties: { notes: "other" } }]);
  assert.throws(() => applyBrowserPropertyPatch({ id: "title", name: "Name", type: "title" }, { type: "number" }, []), /title.*type|type.*title/i);
  assert.throws(() => applyBrowserPropertyPatch({ id: "empty", name: "Empty", type: "number" }, { type: "title" }, []), /title.*type|type.*title/i);
  applyBrowserPropertyPatch(property, { name: "Schedule" }, records);
  assert.equal(records[0].properties.notes, "old");
});

test("browser UI wires every editor through canonical record update while computed projections cannot submit", async () => {
  const root = resolve(import.meta.dirname, "..");
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const build = await readFile(resolve(root, "scripts/build.mjs"), "utf8");
  assert.match(source, /from "\.\/property-editors\.js"/);
  assert.match(source, /propertyValueForRecord\(property,record\)/);
  assert.match(source, /readPropertyControl\(target,property,workspace\(\)\.attachments\)/);
  assert.match(source, /async function queueDiscreteCanonicalEdit/);
  assert.match(source, /pending\.key!==edit\.key/);
  assert.match(source, /await flushCanonicalEdit/);
  assert.match(source, /await queueDiscreteCanonicalEdit/);
  assert.match(source, /type:"database\.record-update"/);
  assert.match(source, /propertyControlHtml\(property,value,workspace\(\)\.attachments/);
  assert.match(source, /property:\{name,type:"plain-text"\}/);
  assert.doesNotMatch(source, /property:\{name,type:"text"\}/);
  assert.match(build, /"property-editors\.js"/);
});
