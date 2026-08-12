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

export function renderBlockTypeSelect({ blockId, type, types, labels }) {
  const currentLabel = labels[type] ?? "Unsupported";
  const orderedTypes = types.includes(type) ? types : [type, ...types];
  const options = orderedTypes.map(candidate => {
    const selected = candidate === type ? " selected" : "";
    return `<option value="${escapeHtml(candidate)}"${selected}>${escapeHtml(labels[candidate] ?? "Unsupported")}</option>`;
  }).join("");
  return `<select class="block-type-select" data-block-type="${escapeHtml(blockId)}" aria-label="Block type: ${escapeHtml(currentLabel)}">${options}</select>`;
}
