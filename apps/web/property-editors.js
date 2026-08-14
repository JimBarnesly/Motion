export const INITIAL_PROPERTY_TYPES = Object.freeze([
  "title", "plain-text", "rich-text", "number", "checkbox", "select", "multi-select", "status",
  "date", "date-range", "url", "email", "phone", "files", "created-time", "updated-time", "created-by", "updated-by"
]);

export const PROPERTY_TYPE_LABELS = Object.freeze({
  title: "Title", "plain-text": "Text", "rich-text": "Rich text", number: "Number", checkbox: "Checkbox",
  select: "Select", "multi-select": "Multi-select", status: "Status", date: "Date", "date-range": "Date range",
  url: "URL", email: "Email", phone: "Phone", files: "Files", "created-time": "Created time",
  "updated-time": "Updated time", "created-by": "Created by", "updated-by": "Updated by"
});

const SYSTEM_PROPERTY_FIELDS = Object.freeze({
  "created-time": "createdAt", "updated-time": "updatedAt", "created-by": "createdBy", "updated-by": "updatedBy"
});
const SYSTEM_PROPERTY_TYPES = new Set(Object.keys(SYSTEM_PROPERTY_FIELDS));
const escapeText = (value = "") => String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const datePart = value => typeof value === "string" ? value.slice(0, 10) : "";
const canonicalDate = value => value ? `${value}T00:00:00.000Z` : undefined;

export function editablePropertyTypes() {
  return INITIAL_PROPERTY_TYPES.filter(type => type !== "title");
}

export function isSystemProperty(property) {
  return SYSTEM_PROPERTY_TYPES.has(property.type);
}

export function propertyValueForRecord(property, page) {
  if (property.type === "title") return page.title;
  const metadataField = SYSTEM_PROPERTY_FIELDS[property.type];
  return metadataField ? page[metadataField] ?? null : page.properties?.[property.id];
}

export function applyBrowserPropertyPatch(property, patch, records) {
  if (patch.type && patch.type !== property.type) for (const record of records) delete record.properties?.[property.id];
  Object.assign(property, patch);
}

function commonAttributes(property, recordId) {
  return `data-property="${escapeText(property.id)}"${recordId ? ` data-record="${escapeText(recordId)}"` : ""} aria-label="${escapeText(property.name)}"`;
}

export function propertyControlHtml(property, value, attachments = [], recordId) {
  if (isSystemProperty(property)) return `<output aria-label="${escapeText(property.name)}">${escapeText(propertyDisplayText(property, value, attachments))}</output>`;
  const common = commonAttributes(property, recordId);
  if (property.type === "checkbox") return `<input type="checkbox" ${common} ${value ? "checked" : ""}>`;
  if (property.type === "number") return `<input type="number" step="any" value="${escapeText(value ?? "")}" ${common}>`;
  if (property.type === "date") return `<input type="date" value="${escapeText(datePart(value))}" ${common}>`;
  if (property.type === "date-range") {
    const start = datePart(value?.start), end = datePart(value?.end);
    return `<fieldset class="date-range-editor"><legend class="visually-hidden">${escapeText(property.name)}</legend><label>Start<input type="date" value="${escapeText(start)}" ${common} data-property-range="start" aria-label="${escapeText(property.name)} start"></label><label>End<input type="date" value="${escapeText(end)}" ${common} data-property-range="end" aria-label="${escapeText(property.name)} end"></label></fieldset>`;
  }
  if (["select", "status"].includes(property.type)) return `<select ${common}><option value="">—</option>${(property.options ?? []).map(option => `<option value="${escapeText(option.id)}" ${value === option.id ? "selected" : ""}>${escapeText(option.name)}</option>`).join("")}</select>`;
  if (property.type === "multi-select") return `<select multiple ${common}>${(property.options ?? []).map(option => `<option value="${escapeText(option.id)}" ${Array.isArray(value) && value.includes(option.id) ? "selected" : ""}>${escapeText(option.name)}</option>`).join("")}</select>`;
  if (property.type === "files") {
    const selected = new Set(Array.isArray(value?.attachmentIds) ? value.attachmentIds : []);
    return `<select multiple ${common}>${attachments.map(attachment => `<option value="${escapeText(attachment.id)}" ${selected.has(attachment.id) ? "selected" : ""}>${escapeText(attachment.fileName)}</option>`).join("")}</select>`;
  }
  const inputType = property.type === "email" ? "email" : property.type === "url" ? "url" : property.type === "phone" ? "tel" : "text";
  return `<input type="${inputType}" value="${escapeText(value ?? "")}" ${common}>`;
}

export function readPropertyControl(target, property, attachments = []) {
  if (isSystemProperty(property) || property.type === "title") return undefined;
  if (property.type === "checkbox") return target.checked;
  if (property.type === "number") return target.value === "" ? undefined : Number(target.value);
  if (property.type === "date") return canonicalDate(target.value);
  if (property.type === "date-range") {
    const row = target.closest(".record-property") ?? target.closest("fieldset");
    const start = row?.querySelector('[data-property-range="start"]')?.value;
    const end = row?.querySelector('[data-property-range="end"]')?.value;
    return start && end ? { start: canonicalDate(start), end: canonicalDate(end) } : undefined;
  }
  if (property.type === "multi-select") return [...target.selectedOptions].map(option => option.value);
  if (property.type === "files") {
    const allowed = new Set(attachments.map(attachment => attachment.id));
    const attachmentIds = [...new Set([...target.selectedOptions].map(option => option.value).filter(id => allowed.has(id)))];
    return target.selectedOptions.length ? { attachmentIds } : undefined;
  }
  return target.value || undefined;
}

export function propertyDisplayText(property, value, attachments = []) {
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return "—";
  if (property.type === "checkbox") return value ? "Yes" : "No";
  if (["select", "status"].includes(property.type)) return property.options?.find(option => option.id === value)?.name ?? String(value);
  if (property.type === "multi-select") return value.map(id => property.options?.find(option => option.id === id)?.name ?? id).join(", ");
  if (property.type === "date") return datePart(value) || "—";
  if (property.type === "date-range") return value.start && value.end ? `${datePart(value.start)} – ${datePart(value.end)}` : "—";
  if (property.type === "files") {
    const byId = new Map(attachments.map(attachment => [attachment.id, attachment.fileName]));
    return (value.attachmentIds ?? []).map(id => byId.get(id)).filter(Boolean).join(", ") || "—";
  }
  return String(value);
}
