import { RELATIVE_DATE_PRESETS, isRelativeDatePreset } from "./relative-date.js";

export const FILTER_OPERATOR_CHOICES = Object.freeze([
  ["equals","Equals"], ["not-equals","Does not equal"], ["contains","Contains"], ["not-contains","Does not contain"],
  ["gt","Greater than"], ["gte","Greater than or equal"], ["lt","Less than"], ["lte","Less than or equal"],
  ["before","Before"], ["after","After"], ["is-empty","Is empty"], ["is-not-empty","Is not empty"], ["relative-date","Relative date"]
].map(([value,label]) => Object.freeze({ value, label })));
export const RELATIVE_DATE_LABELS = Object.freeze({ today:"Today", yesterday:"Yesterday", tomorrow:"Tomorrow", "past-week":"Past week", "next-week":"Next week", "past-month":"Past month", "next-month":"Next month" });
const dateTypes = new Set(["date", "date-range", "created-time", "updated-time"]);
const escape = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);

export function filterValueControlHtml(property, condition = {}) {
  if (condition.operator === "relative-date") return `<select data-filter-value aria-label="Relative date preset">${RELATIVE_DATE_PRESETS.map(value => `<option value="${value}" ${condition.value === value ? "selected" : ""}>${RELATIVE_DATE_LABELS[value]}</option>`).join("")}</select>`;
  return `<input data-filter-value value="${escape(condition.value)}" placeholder="Value">`;
}

export function createFilterValueControl(document, condition = {}) {
  if (condition.operator === "relative-date") {
    const select = document.createElement("select");
    select.dataset.filterValue = "";
    select.setAttribute?.("aria-label", "Relative date preset");
    for (const value of RELATIVE_DATE_PRESETS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = RELATIVE_DATE_LABELS[value];
      option.selected = condition.value === value;
      select.append(option);
    }
    return select;
  }
  const input = document.createElement("input");
  input.dataset.filterValue = "";
  input.value = condition.value ?? "";
  input.placeholder = "Value";
  return input;
}

export function buildFilterCondition(property, operator, raw) {
  if (operator === "relative-date") {
    if (!dateTypes.has(property.type)) throw new Error("Relative date requires a date property");
    if (!isRelativeDatePreset(raw)) throw new Error("Invalid relative-date preset");
    return { kind:"condition", propertyId:property.id, operator, value:raw };
  }
  if (["is-empty", "is-not-empty"].includes(operator)) return { kind:"condition", propertyId:property.id, operator };
  const value = property.type === "number" ? Number(raw) : property.type === "checkbox" ? raw === "true" : raw;
  return { kind:"condition", propertyId:property.id, operator, value };
}
