const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;"
})[character]);

export function renderBlockTypeOption(type, label) {
  return `<option value="${escapeHtml(type)}">${escapeHtml(label)}</option>`;
}
