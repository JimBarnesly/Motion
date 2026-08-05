import { createMotionUiAdapter } from "./app-adapter.js";
import { normalizeWorkspaceV1 } from "./workspace-v1.js";

const workspaceStore = createMotionUiAdapter();
let state = await workspaceStore.load();
let confirmedState = structuredClone(state);
if (state.pages.find(page => page.id === state.activePageId)?.deleted) state.activePageId = state.pages.find(page => !page.deleted)?.id ?? null;
let saveQueue = Promise.resolve();
let pendingEdit = null;
let editVersion = 0;
let confirmedAttachments = [];
let undoStack = [], redoStack = [], editStartedFor = null;
const $ = (selector) => document.querySelector(selector);
const uid = () => crypto.randomUUID();
const activePage = () => state.pages.find((page) => page.id === state.activePageId);
const childrenOf = (parentId) => state.pages.filter((page) => !page.deleted && page.parentId === parentId).sort((a, b) => a.order - b.order);
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const BLOCK_TYPES = ["paragraph", "heading1", "heading2", "heading3", "bullet", "number", "task", "toggle", "quote", "code", "divider"];
const blockLabel = (type) => ({ paragraph:"Text", heading1:"Heading 1", heading2:"Heading 2", heading3:"Heading 3", bullet:"Bulleted list", number:"Numbered list", task:"Task", toggle:"Toggle", quote:"Quote", code:"Code", divider:"Divider" }[type] || `Unsupported: ${type}`);
const snapshot = () => JSON.stringify(state);
function checkpoint() { undoStack.push(snapshot()); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
function restoreSnapshot(raw) { state = JSON.parse(raw); void persist(); render(); }
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restoreSnapshot(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restoreSnapshot(redoStack.pop()); }

async function persist() {
  if (pendingEdit) { showPendingResolution("Resolve the unsaved edit before making another change."); return false; }
  $("#saveState").textContent = "Saving…";
  try {
    const candidate = structuredClone(state);
    saveQueue = saveQueue.catch(() => undefined).then(() => workspaceStore.save(candidate));
    await saveQueue;
    confirmedState = candidate;
    $("#saveState").textContent = workspaceStore.kind === "tauri" ? "Saved to Motion" : "Saved in browser (development mode)";
    return true;
  } catch {
    $("#saveState").textContent = "Save failed";
    return false;
  }
}

function editTarget(descriptor) {
  if (!descriptor) return null;
  if (descriptor.kind === "title") return $("#pageTitle");
  if (descriptor.kind === "block") return document.querySelector(`[data-block="${CSS.escape(descriptor.blockId)}"]`);
  if (descriptor.kind === "block-type") return document.querySelector(`[data-block-type="${CSS.escape(descriptor.blockId)}"]`);
  if (descriptor.kind === "task") return document.querySelector(`[data-task="${CSS.escape(descriptor.blockId)}"]`);
  if (descriptor.kind === "column") return document.querySelector(`[data-column-name="${CSS.escape(descriptor.columnId)}"]`);
  if (descriptor.kind === "cell") return document.querySelector(`[data-cell="${CSS.escape(`${descriptor.rowId}:${descriptor.columnId}`)}"]`);
  return null;
}

function markPendingField() {
  document.querySelectorAll('[data-unsaved="true"]').forEach(element => {
    element.removeAttribute("data-unsaved"); element.removeAttribute("aria-invalid"); element.removeAttribute("aria-describedby");
  });
  const target = editTarget(pendingEdit?.descriptor);
  if (target) {
    target.dataset.unsaved = "true"; target.setAttribute("aria-describedby", pendingEdit.status === "failed" ? "editRecoveryMessage" : "saveState");
    if (pendingEdit.status === "failed") target.setAttribute("aria-invalid", "true"); else target.removeAttribute("aria-invalid");
  }
}

function showPendingResolution(message) {
  if (!pendingEdit) return false;
  const recovery = $("#editRecovery");
  recovery.hidden = false;
  $("#editRecoveryMessage").textContent = message || `${pendingEdit.label} could not be saved.`;
  const saveState = $("#saveState"); saveState.className = "save-state unsaved"; saveState.textContent = "Unsaved change — action required";
  markPendingField();
  requestAnimationFrame(() => editTarget(pendingEdit.descriptor)?.focus());
  return true;
}

function hidePendingResolution() {
  $("#editRecovery").hidden = true;
  $("#saveState").className = "save-state";
  markPendingField();
}

function scheduleEditSave() {
  clearTimeout(pendingEdit?.timer);
  if (!pendingEdit || pendingEdit.status === "failed" || pendingEdit.inFlight) return;
  pendingEdit.timer = setTimeout(() => void commitPendingEdit(), 120);
}

function queueEdit({ key, label, descriptor, apply }) {
  if (pendingEdit && pendingEdit.key !== key) { render(); showPendingResolution("Resolve the unsaved edit before editing other content."); return false; }
  const wasFailed = pendingEdit?.status === "failed";
  const saveInFlight = pendingEdit?.inFlight;
  if (!pendingEdit) pendingEdit = { key, label, descriptor, status: "editing", candidate: null, version: 0, timer: null, inFlight: false };
  apply();
  pendingEdit.candidate = structuredClone(state);
  pendingEdit.version = ++editVersion;
  pendingEdit.status = wasFailed ? "failed" : saveInFlight ? "saving" : "editing";
  const saveState = $("#saveState"); saveState.className = "save-state saving"; saveState.textContent = `${label} has unsaved changes. Saving…`;
  markPendingField();
  if (wasFailed) showPendingResolution(`${label} could not be saved. The updated attempt is still unsaved.`); else if (!saveInFlight) scheduleEditSave();
  return true;
}

async function commitPendingEdit() {
  if (!pendingEdit || pendingEdit.inFlight) return false;
  const record = pendingEdit, candidate = structuredClone(record.candidate), version = record.version;
  record.status = "saving"; record.inFlight = true;
  $("#retryEdit").disabled = $("#discardEdit").disabled = true;
  try {
    saveQueue = saveQueue.catch(() => undefined).then(() => workspaceStore.save(candidate));
    await saveQueue;
    confirmedState = candidate;
    if (pendingEdit !== record) return true;
    if (record.version !== version) { record.inFlight = false; record.status = "editing"; scheduleEditSave(); return true; }
    const descriptor = record.descriptor, label = record.label;
    pendingEdit = null; hidePendingResolution();
    $("#saveState").textContent = `${label} saved. ${workspaceStore.kind === "tauri" ? "Saved to Motion" : "Saved in browser (development mode)"}.`;
    requestAnimationFrame(() => editTarget(descriptor)?.focus());
    return true;
  } catch {
    if (pendingEdit !== record) return false;
    record.inFlight = false; record.status = "failed";
    showPendingResolution(`${record.label} could not be saved.`);
    return false;
  } finally {
    $("#retryEdit").disabled = $("#discardEdit").disabled = false;
  }
}

async function retryPendingEdit() {
  if (!pendingEdit || pendingEdit.inFlight) return false;
  pendingEdit.status = "editing";
  $("#saveState").className = "save-state saving"; $("#saveState").textContent = `Retrying ${pendingEdit.label.toLowerCase()}…`;
  return commitPendingEdit();
}

function discardPendingEdit() {
  if (!pendingEdit || pendingEdit.inFlight) return false;
  const descriptor = pendingEdit.descriptor, label = pendingEdit.label;
  clearTimeout(pendingEdit.timer);
  state = structuredClone(confirmedState); pendingEdit = null; hidePendingResolution(); render();
  $("#saveState").textContent = `${label} unsaved changes discarded.`;
  requestAnimationFrame(() => editTarget(descriptor)?.focus());
  return true;
}

function requireResolvedEdit(action) {
  if (!pendingEdit) return true;
  showPendingResolution(`Retry or discard the unsaved edit before ${action}.`);
  $("#retryEdit").focus();
  return false;
}

window.addEventListener("beforeunload", event => {
  if (!pendingEdit) return;
  event.preventDefault(); event.returnValue = "";
});

async function exportWorkspace() {
  if (!requireResolvedEdit("exporting")) return false;
  let payload, fileName;
  if (workspaceStore.kind === "tauri") {
    const exported = await workspaceStore.exportWorkspace();
    payload = JSON.stringify(exported, null, 2);
    fileName = `motion-canonical-export-${new Date().toISOString().slice(0, 10)}.json`;
  } else {
    payload = JSON.stringify({ exportVersion: "motion.workspace/1.0", exportedAt: new Date().toISOString(), workspace: confirmedState }, null, 2);
    fileName = `motion-browser-development-${new Date().toISOString().slice(0, 10)}.json`;
  }
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function attachNativeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await sha256(bytes);
  const result = await workspaceStore.putAttachment({ fileName: file.name, mediaType: file.type || "application/octet-stream", sha256: digest, bytes });
  const attachment = result.workspace?.attachments?.filter(item => item.fileName === file.name && item.byteLength === bytes.byteLength && item.sha256 === digest).at(-1);
  if (!attachment) throw new Error("Native service did not confirm the attachment metadata");
  confirmedAttachments = [...confirmedAttachments.filter(item => item.id !== attachment.id), attachment];
  renderContext(activePage());
}

async function createVerifiedBackup() {
  if (!requireResolvedEdit("creating a backup")) return false;
  const bundle = await workspaceStore.createBackup();
  const verification = await workspaceStore.verifyBackup(bundle);
  if (!verification.valid) throw new Error(`Backup verification failed: ${(verification.errors || []).join("; ")}`);
  const saved = await workspaceStore.saveBackup(bundle);
  if (saved.cancelled) { announce("Backup cancelled. Existing files were not changed."); return false; }
  if (!saved.saved) throw new Error("Backup was not saved");
  announce(saved.replaced ? "Verified backup replaced safely." : "Verified backup saved safely.");
  return true;
}

async function restoreVerifiedBackup(file) {
  if (!requireResolvedEdit("restoring")) return false;
  const bundle = JSON.parse(await file.text());
  const verification = await workspaceStore.verifyBackup(bundle);
  if (!verification.valid) throw new Error(`Backup verification failed: ${(verification.errors || []).join("; ")}`);
  const preview = await workspaceStore.previewBackup(bundle);
  const summary = `${preview.workspaceName || "Workspace"}: ${preview.pages} pages, ${preview.attachments} attachments, ${preview.totalBytes} bytes. Restore as a new workspace?`;
  if (!confirm(summary)) return;
  await workspaceStore.restoreBackup(bundle);
  state = await workspaceStore.load(); confirmedState = structuredClone(state); confirmedAttachments = []; render();
}

async function restoreWorkspace(file, trigger = $("#restoreWorkspace")) {
  if (!requireResolvedEdit("restoring")) return false;
  const parsed = JSON.parse(await file.text());
  const candidate = parsed?.exportVersion === "motion.workspace/1.0" ? parsed.workspace : parsed;
  if (candidate?.schemaVersion !== 1 || !Array.isArray(candidate.pages)) throw new Error("Unsupported or invalid Motion workspace backup");
  const replacement = normalizeWorkspaceV1(candidate); if (!confirm("Replace the current workspace with this restored workspace? The current workspace will no longer be active.")) { announce("Restore cancelled. Current workspace kept."); trigger?.focus(); return false; }
  state = replacement;
  if (!state.pages.some((page) => page.id === state.activePageId && !page.deleted)) state.activePageId = state.pages.find(page => !page.deleted)?.id ?? null;
  if (!await persist()) { state = structuredClone(confirmedState); render(); announce("Workspace restore failed. Previous saved content kept."); requestAnimationFrame(() => trigger?.focus()); return false; }
  render(); announce("Workspace restored."); requestAnimationFrame(() => $("#pageTitle")?.focus()); return true;
}

function addPage(parentId = null, type = "document") {
  checkpoint();
  const siblings = childrenOf(parentId);
  const page = { id: uid(), parentId, order: siblings.length, type, title: type === "database" ? "Untitled database" : "Untitled page", blocks: type === "document" ? [{ id: uid(), type: "paragraph", text: "" }] : [], columns: type === "database" ? [{ id: uid(), name: "Name", type: "text" }] : [], rows: [] };
  state.pages.push(page); state.activePageId = page.id; persist(); render();
  requestAnimationFrame(() => $("#pageTitle")?.select());
}

async function trashPage(pageId) {
  if (!requireResolvedEdit("moving content to Trash")) return false;
  checkpoint();
  const doomed = new Set([pageId]);
  let changed = true;
  while (changed) { changed = false; state.pages.forEach((p) => { if (p.parentId && doomed.has(p.parentId) && !doomed.has(p.id)) { doomed.add(p.id); changed = true; } }); }
  state.pages.forEach(page => { if (doomed.has(page.id)) page.deleted = true; });
  if (doomed.has(state.activePageId)) state.activePageId = state.pages.find(page => !page.deleted)?.id ?? null;
  await persist(); render(); announce("Page moved to Trash."); requestAnimationFrame(() => (document.querySelector(`[data-restore-page="${CSS.escape(pageId)}"]`) || $("#trashList button"))?.focus());
}

async function restorePage(pageId) {
  checkpoint();
  const restored = new Set([pageId]);
  let changed = true;
  while (changed) { changed = false; state.pages.forEach(page => { if (page.parentId && restored.has(page.parentId) && !restored.has(page.id)) { restored.add(page.id); changed = true; } }); }
  let current = state.pages.find(page => page.id === pageId);
  while (current) { restored.add(current.id); current = state.pages.find(page => page.id === current.parentId); }
  state.pages.forEach(page => { if (restored.has(page.id)) page.deleted = false; });
  state.activePageId = pageId; await persist(); render(); announce("Page restored."); requestAnimationFrame(() => $("#pageTitle")?.focus());
}

function renderTrash() {
  const roots = state.pages.filter(page => page.deleted && (!page.parentId || !state.pages.find(parent => parent.id === page.parentId)?.deleted));
  $("#trashList").innerHTML = roots.length ? roots.map(page => `<div class="tree-row"><span class="disclosure" aria-hidden="true">×</span><span class="page-link">${escapeHtml(page.title || "Untitled")}</span><button class="row-action" data-restore-page="${page.id}" type="button" aria-label="Restore ${escapeHtml(page.title || "Untitled")}">Restore</button></div>`).join("") : `<div class="empty-nav">Trash is empty</div>`;
}

function renderTree(parentId = null, depth = 0) {
  return childrenOf(parentId).map((page) => {
    const kids = childrenOf(page.id);
    return `<div class="tree-branch"><div class="tree-row ${page.id === state.activePageId ? "active" : ""}" style="--depth:${depth}">
      <span class="disclosure" aria-hidden="true">${kids.length ? "⌄" : ""}</span>
      <button class="page-link" data-open-page="${page.id}" type="button"><span aria-hidden="true">${page.type === "database" ? "▦" : "□"}</span><span>${escapeHtml(page.title || "Untitled")}</span></button>
      <button class="row-action" data-move-page="${page.id}:-1" type="button" aria-label="Move ${escapeHtml(page.title)} up">↑</button><button class="row-action" data-move-page="${page.id}:1" type="button" aria-label="Move ${escapeHtml(page.title)} down">↓</button><button class="row-action" data-add-child="${page.id}" type="button" aria-label="Add page inside ${escapeHtml(page.title)}">+</button>
    </div>${kids.length ? `<div>${renderTree(page.id, depth + 1)}</div>` : ""}</div>`;
  }).join("");
}

function ancestors(page) {
  const path = []; let current = page;
  while (current) { path.unshift(current); current = state.pages.find((p) => p.id === current.parentId); }
  return path;
}

function render() {
  $("#pageTree").innerHTML = state.pages.length ? renderTree() : `<div class="empty-nav">No pages yet</div>`;
  renderTrash();
  const page = activePage();
  if (!page) { renderEmptyWorkspace(); renderContext(null); return; }
  $("#breadcrumbs").innerHTML = ancestors(page).map((item) => `<button type="button" data-open-page="${item.id}">${escapeHtml(item.title || "Untitled")}</button>`).join(`<span aria-hidden="true">/</span>`);
  if (page.type === "database") renderDatabase(page); else renderDocument(page);
  renderContext(page);
}

function renderEmptyWorkspace() {
  $("#breadcrumbs").innerHTML = "Workspace";
  const storageCopy = workspaceStore.kind === "tauri" ? "Stored through Motion's native service." : "Browser development mode uses IndexedDB, not the native SQLite service.";
  $("#content").innerHTML = `<div class="empty-state"><div class="empty-icon" aria-hidden="true">◇</div><h1>Your workspace is ready</h1><p>${storageCopy}</p><div class="empty-actions"><button class="primary" data-create="document" type="button">New page</button><button data-create="database" type="button">New table</button></div></div>`;
}

function renderDocument(page) {
  page.blocks ||= [];
  const blocks = page.blocks.map((block, index) => {
    const known = BLOCK_TYPES.includes(block.type), type = known ? block.type : "unknown";
    const input = block.type === "divider" ? `<hr aria-label="Divider">` : `<textarea class="block-input ${type}" rows="1" data-block="${block.id}" placeholder="Type text, or [[Page name]]" aria-keyshortcuts="Alt+BracketLeft Alt+BracketRight" title="Indent with Alt+], outdent with Alt+[">${escapeHtml(block.text || "")}</textarea>`;
    return `<div class="block-row ${type}" data-block-id="${block.id}" style="--indent:${block.indent || 0}"><div class="block-tools"><button type="button" data-move-block="${block.id}:-1" aria-label="Move block up" ${index ? "" : "disabled"}>↑</button><button type="button" data-move-block="${block.id}:1" aria-label="Move block down" ${index < page.blocks.length - 1 ? "" : "disabled"}>↓</button></div><select data-block-type="${block.id}" aria-label="Block type: ${escapeHtml(blockLabel(block.type))}"><option value="${escapeHtml(block.type)}">${escapeHtml(blockLabel(block.type))}</option>${BLOCK_TYPES.filter(t => t !== block.type).map(t => `<option value="${t}">${blockLabel(t)}</option>`).join("")}</select>${block.type === "task" ? `<input class="task-check" type="checkbox" data-task="${block.id}" ${block.checked ? "checked" : ""} aria-label="Mark task complete">` : ""}<span class="block-handle" aria-hidden="true">⋮⋮</span>${input}<button class="delete-block" type="button" data-delete-block="${block.id}" aria-label="Delete block">×</button></div>`;
  }).join("");
  $("#content").innerHTML = `<article class="page"><div class="page-kicker"><span>Document</span><button class="danger-text" data-delete-page="${page.id}" type="button">Delete</button></div><input id="pageTitle" class="page-title" value="${escapeHtml(page.title)}" aria-label="Page title" placeholder="Untitled page" />
    <div class="blocks">${blocks}</div><button class="add-block" id="addBlock" type="button">+ Add block</button></article>`;
}

function renderDatabase(page) {
  const headers = page.columns.map((c) => `<th><input value="${escapeHtml(c.name)}" data-column-name="${c.id}" aria-label="Column name" /></th>`).join("");
  const rows = page.rows.map((row) => `<tr data-row-id="${row.id}">${page.columns.map((c) => `<td><textarea rows="1" data-cell="${row.id}:${c.id}" aria-label="${escapeHtml(c.name)}">${escapeHtml(row.values[c.id] ?? "")}</textarea></td>`).join("")}<td class="row-tools"><button data-delete-row="${row.id}" type="button" aria-label="Delete row">×</button></td></tr>`).join("");
  $("#content").innerHTML = `<article class="page database-page"><div class="page-kicker"><span>Table</span><button class="danger-text" data-delete-page="${page.id}" type="button">Delete</button></div><input id="pageTitle" class="page-title" value="${escapeHtml(page.title)}" aria-label="Database title" placeholder="Untitled database" />
    <div class="table-toolbar"><span>${page.rows.length} ${page.rows.length === 1 ? "row" : "rows"}</span><button id="addColumn" type="button">+ Property</button></div><div class="table-wrap"><table><thead><tr>${headers}<th class="row-tools"></th></tr></thead><tbody>${rows}</tbody></table>${page.rows.length ? "" : `<div class="table-empty">No rows yet. Add the first item when you’re ready.</div>`}</div><button class="add-row" id="addRow" type="button">+ New row</button></article>`;
}

function linkedTitles(page) {
  const text = page.blocks?.map((b) => b.text).join("\n") ?? "";
  return [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1].trim().toLowerCase());
}

function refreshBlockLinks(block) {
  const titles = [...(block.text || "").matchAll(/\[\[([^\]]+)\]\]/g)].map(match => match[1].trim());
  block.links = titles.map(title => ({ pageId: state.pages.find(p => p.title.toLowerCase() === title.toLowerCase())?.id || null, title }));
}

function pageLinks(page) { return (page.blocks || []).flatMap(block => block.links || []); }

function renderContext(page) {
  $("#attachments").innerHTML = confirmedAttachments.length ? confirmedAttachments.map(item => `<div class="context-link"><span>↗</span>${escapeHtml(item.fileName)} (${Number(item.byteLength)} bytes, ${escapeHtml(item.sha256.slice(0, 12))}…)</div>`).join("") : `<p class="muted">No attachments confirmed this session.</p>`;
  if (!page) { $("#outgoingLinks").innerHTML = $("#backlinks").innerHTML = `<p class="muted">Open a page to see connections.</p>`; return; }
  (page.blocks || []).forEach(block => { if (!block.links) refreshBlockLinks(block); });
  const outgoing = [...new Set(pageLinks(page).map(link => link.pageId))].map(id => state.pages.find(p => p.id === id)).filter(Boolean);
  const broken = pageLinks(page).filter(link => !link.pageId);
  const incoming = state.pages.filter((p) => p.id !== page.id && pageLinks(p).some(link => link.pageId === page.id));
  const linksHtml = (items, empty) => items.length ? items.map((p) => `<button class="context-link ${p.archived ? "archived" : ""}" data-open-page="${p.id}" type="button"><span>↗</span>${escapeHtml(p.title)}${p.archived ? " (archived)" : ""}</button>`).join("") : `<p class="muted">${empty}</p>`;
  $("#outgoingLinks").innerHTML = linksHtml(outgoing, "No page links yet. Type [[Page title]] in a block.") + broken.map(link => `<div class="broken-link" title="No page with this title">⚠ ${escapeHtml(link.title)}</div>`).join("");
  $("#backlinks").innerHTML = linksHtml(incoming, "No pages link here yet.");
}

function openSearch() { $("#searchDialog").showModal(); $("#searchInput").value = ""; renderSearch(""); $("#searchInput").focus(); }
let searchRequest = 0;
function renderSearchState(kind, query = "") {
  const results = $("#searchResults");
  results.className = `search-results search-results-${kind}`;
  results.setAttribute("role", kind === "error" ? "alert" : "status");
  if (kind === "guidance") results.innerHTML = `<div class="search-state search-guidance">Start typing to search page titles, document text, and table cells.</div>`;
  if (kind === "loading") results.innerHTML = `<div class="search-state search-loading"><span class="search-spinner" aria-hidden="true"></span>Searching for “${escapeHtml(query)}”…</div>`;
  if (kind === "empty") results.innerHTML = `<div class="search-state search-empty"><strong>No results</strong><span>Nothing matched “${escapeHtml(query)}”.</span></div>`;
  if (kind === "error") results.innerHTML = `<div class="search-state search-error"><strong>Search couldn’t be completed.</strong><span>Your query is unchanged. Try again.</span><button type="button" data-search-retry>Retry search</button></div>`;
}
async function renderSearch(query) {
  const request = ++searchRequest;
  const term = query.trim().toLowerCase();
  if (!term) { renderSearchState("guidance"); return; }
  renderSearchState("loading", query);
  try {
    let hits;
    if (workspaceStore.kind === "tauri") {
      const nativeHits = await workspaceStore.search(query, 50);
      if (request !== searchRequest) return;
      const seenEntities = new Set();
      hits = nativeHits.map(hit => {
        const page = hit.entityType === "row"
          ? state.pages.find(candidate => candidate.id === hit.ownerEntityId && candidate.rows?.some(row => row.id === hit.entityId))
          : state.pages.find(candidate => candidate.id === hit.entityId || candidate.blocks?.some(block => block.id === hit.entityId));
        const key = `${hit.entityType}:${hit.entityId}`;
        if (!page || page.deleted || seenEntities.has(key)) return null;
        seenEntities.add(key);
        return { page, rowId: hit.entityType === "row" ? hit.entityId : undefined, snippet: cleanSnippet(hit.snippet), native: true };
      }).filter(Boolean);
    } else {
      hits = browserSearchHits(query);
    }
    if (request !== searchRequest) return;
    if (!hits.length) { renderSearchState("empty", query); return; }
    const results = $("#searchResults");
    results.className = "search-results search-results-complete";
    results.setAttribute("role", "status");
    results.innerHTML = hits.map(({ page, rowId, snippet, native }) => `<button type="button" data-search-page="${page.id}"${rowId ? ` data-search-row="${rowId}"` : ""}><span class="result-icon">${rowId || page.type === "database" ? "▦" : "□"}</span><span><strong>${escapeHtml(page.title)}</strong><small>${escapeHtml(snippet || (native ? "Indexed result" : "Document"))}</small></span></button>`).join("");
  } catch {
    if (request !== searchRequest) return;
    renderSearchState("error", query);
  }
}

document.addEventListener("click", async (event) => {
  const el = event.target.closest("button"); if (!el) return;
  if (el.id === "retryEdit") { await retryPendingEdit(); return; }
  if (el.id === "discardEdit") { discardPendingEdit(); return; }
  if (pendingEdit && el.id !== "openSearch" && !el.closest("#searchDialog")) { requireResolvedEdit("continuing"); return; }
  const openId = el.dataset.openPage; if (openId) { state.activePageId = openId; persist(); render(); $("#sidebar").classList.remove("open"); }
  if (el.dataset.addChild) addPage(el.dataset.addChild);
  if (el.dataset.movePage) { checkpoint(); const [id, deltaText] = el.dataset.movePage.split(":"); const page = state.pages.find(p => p.id === id), siblings = childrenOf(page.parentId), at = siblings.findIndex(p => p.id === id), to = at + Number(deltaText); if (to >= 0 && to < siblings.length) { const other = siblings[to]; [page.order, other.order] = [other.order, page.order]; persist(); render(); } }
  if (el.dataset.create) await createRootPage(el.dataset.create, el);
  if (el.dataset.deletePage && confirm("Move this page and any pages inside it to Trash? You can restore it from Trash.")) await trashPage(el.dataset.deletePage);
  if (el.dataset.restorePage) await restorePage(el.dataset.restorePage);
  if (el.dataset.deleteBlock) await deleteBlock(el.dataset.deleteBlock, el);
  if (el.dataset.moveBlock) { checkpoint(); const [id, deltaText] = el.dataset.moveBlock.split(":"); const blocks = activePage().blocks, at = blocks.findIndex(b => b.id === id), to = at + Number(deltaText); if (at >= 0 && to >= 0 && to < blocks.length) [blocks[at], blocks[to]] = [blocks[to], blocks[at]]; persist(); render(); }
  if (el.dataset.deleteRow) { const page = activePage(); page.rows = page.rows.filter((r) => r.id !== el.dataset.deleteRow); persist(); render(); }
  if (el.dataset.searchPage) openSearchResult(el.dataset.searchPage, el.dataset.searchRow);
  if (el.hasAttribute("data-search-retry")) { el.disabled = true; await renderSearch($("#searchInput").value); }
  if (el.id === "addRootPage") await createRootPage("document", el);
  if (el.id === "addRootTable") await createRootPage("database", el);
  if (el.id === "addBlock") { checkpoint(); activePage().blocks.push({ id: uid(), type: "paragraph", text: "", indent:0, links:[] }); persist(); render(); requestAnimationFrame(() => [...document.querySelectorAll("[data-block]")].at(-1)?.focus()); }
  if (el.id === "addColumn") { const page = activePage(), id = uid(); page.columns.push({ id, name: "Property", type: "text" }); persist(); render(); }
  if (el.id === "addRow") { const page = activePage(); page.rows.push({ id: uid(), values: Object.fromEntries(page.columns.map((c) => [c.id, ""])) }); persist(); render(); }
  if (el.id === "openSearch") openSearch();
  if (el.id === "openSidebar") $("#sidebar").classList.add("open");
  if (el.id === "closeSidebar") $("#sidebar").classList.remove("open");
  if (el.id === "exportWorkspace") exportWorkspace().catch(error => alert(error instanceof Error ? error.message : "Export failed"));
  if (el.id === "restoreWorkspace") $("#restoreFile").click();
  if (el.id === "attachFile") $("#attachmentFile").click();
  if (el.id === "createVerifiedBackup") createVerifiedBackup().catch(error => {
    announce(`Backup failed: ${error instanceof Error ? error.message : "Existing files were preserved"}`); el.focus();
  });
  if (el.id === "restoreVerifiedBackup") $("#verifiedBackupFile").click();
  if (el.id === "homeButton" && !state.pages.length) renderEmptyWorkspace();
});

$("#attachmentFile").addEventListener("change", async event => {
  const [file] = event.target.files; event.target.value = ""; if (!file) return;
  try { await attachNativeFile(file); } catch (error) { alert(error instanceof Error ? error.message : "Attachment failed"); }
});

$("#verifiedBackupFile").addEventListener("change", async event => {
  const [file] = event.target.files; event.target.value = ""; if (!file) return;
  try { await restoreVerifiedBackup(file); } catch (error) { alert(error instanceof Error ? error.message : "Restore failed"); }
});

$("#restoreFile").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    await restoreWorkspace(file, $("#restoreWorkspace"));
  } catch (error) {
    announce(`Restore failed: ${error instanceof Error ? error.message : "Could not restore this backup"}`); $("#restoreWorkspace")?.focus();
  } finally {
    event.target.value = "";
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "searchInput") {
    void renderSearch(event.target.value);
    return;
  }
  const page = activePage(); if (!page) return;
  if (event.target.id === "pageTitle") {
    const value = event.target.value;
    queueEdit({ key: `title:${page.id}`, label: page.type === "database" ? "Table title" : "Page title", descriptor: { kind: "title", pageId: page.id }, apply: () => {
      const old = page.title; page.title = value;
      state.pages.forEach(p => (p.blocks || []).forEach(b => { if ((b.links || []).some(l => l.pageId === page.id)) { b.text = (b.text || "").replaceAll(`[[${old}]]`, `[[${page.title}]]`); (b.links || []).filter(l => l.pageId === page.id).forEach(l => l.title = page.title); } }));
      $("#pageTree").innerHTML = renderTree(); renderContext(page);
    } });
  }
  if (event.target.dataset.block) {
    const blockId = event.target.dataset.block, value = event.target.value;
    queueEdit({ key: `block-text:${page.id}:${blockId}`, label: `${blockLabel(page.blocks.find(block => block.id === blockId)?.type)} text`, descriptor: { kind: "block", pageId: page.id, blockId }, apply: () => {
      const block = page.blocks.find(candidate => candidate.id === blockId); block.text = value; refreshBlockLinks(block); renderContext(page);
    } });
  }
  if (event.target.dataset.columnName) {
    const columnId = event.target.dataset.columnName, value = event.target.value;
    queueEdit({ key: `column:${page.id}:${columnId}`, label: "Table column name", descriptor: { kind: "column", pageId: page.id, columnId }, apply: () => {
      page.columns.find(column => column.id === columnId).name = value;
      document.querySelectorAll("[data-cell]").forEach(cell => { if (cell.dataset.cell.split(":")[1] === columnId) cell.setAttribute("aria-label", value); });
    } });
  }
  if (event.target.dataset.cell) {
    const [rowId, columnId] = event.target.dataset.cell.split(":"), value = event.target.value;
    queueEdit({ key: `cell:${page.id}:${rowId}:${columnId}`, label: "Table cell", descriptor: { kind: "cell", pageId: page.id, rowId, columnId }, apply: () => { page.rows.find(row => row.id === rowId).values[columnId] = value; } });
  }
});

document.addEventListener("focusin", event => {
  const key = event.target.id === "pageTitle" ? "title" : event.target.dataset?.block ? `block:${event.target.dataset.block}` : null;
  if (key && editStartedFor !== key) { checkpoint(); editStartedFor = key; }
});
document.addEventListener("focusout", event => { if (event.target.id === "pageTitle" || event.target.dataset?.block) editStartedFor = null; });

document.addEventListener("change", event => {
  const page = activePage(); if (!page) return;
  if (event.target.dataset.blockType) {
    const blockId = event.target.dataset.blockType, value = event.target.value;
    queueEdit({ key: `block-type:${page.id}:${blockId}`, label: "Block type", descriptor: { kind: "block-type", pageId: page.id, blockId }, apply: () => {
      checkpoint(); const block = page.blocks.find(candidate => candidate.id === blockId); block.type = value; if (block.type === "task") block.checked ||= false; render();
    } });
  }
  if (event.target.dataset.task) {
    const blockId = event.target.dataset.task, checked = event.target.checked;
    queueEdit({ key: `task:${page.id}:${blockId}`, label: "Checklist state", descriptor: { kind: "task", pageId: page.id, blockId }, apply: () => { checkpoint(); page.blocks.find(block => block.id === blockId).checked = checked; } });
  }
});

document.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); return; }
  if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
  const input = event.target.closest?.("[data-block]"); if (!input) return;
  const page = activePage(), id = input.dataset.block, at = page.blocks.findIndex(b => b.id === id), block = page.blocks[at];
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); checkpoint(); const next = { id:uid(), type:block.type === "divider" ? "paragraph" : block.type, text:"", indent:block.indent || 0, links:[] }; page.blocks.splice(at + 1, 0, next); persist(); render(); requestAnimationFrame(() => document.querySelector(`[data-block="${next.id}"]`)?.focus()); }
  if (event.key === "Tab") return;
  if (event.altKey && ["[", "]"].includes(event.key)) { event.preventDefault(); checkpoint(); block.indent = Math.max(0, Math.min(4, (block.indent || 0) + (event.key === "[" ? -1 : 1))); persist(); render(); requestAnimationFrame(() => document.querySelector(`[data-block="${id}"]`)?.focus()); }
  if (mod && event.key.toLowerCase() === "d") { event.preventDefault(); checkpoint(); const copy = structuredClone(block); copy.id = uid(); page.blocks.splice(at + 1, 0, copy); persist(); render(); }
  if (mod && event.key === "Backspace") { event.preventDefault(); void deleteBlock(id, input); }
  if (event.altKey && ["ArrowUp","ArrowDown"].includes(event.key)) { event.preventDefault(); const to = at + (event.key === "ArrowUp" ? -1 : 1); if (to >= 0 && to < page.blocks.length) { checkpoint(); [page.blocks[at], page.blocks[to]] = [page.blocks[to], page.blocks[at]]; persist(); render(); requestAnimationFrame(() => document.querySelector(`[data-block="${id}"]`)?.focus()); } }
});
function searchableScalars(value) {
  if (["string", "number", "boolean"].includes(typeof value)) return [String(value)];
  if (Array.isArray(value)) return value.flatMap(searchableScalars);
  if (value && typeof value === "object") return Object.values(value).flatMap(searchableScalars);
  return [];
}
function cleanSnippet(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function searchablePageText(page) {
  return [page.title, ...(page.blocks ?? []).map(block => block.text)].join(" ").normalize("NFKC").toLowerCase();
}
function browserSearchHits(query) {
  const terms = query.normalize("NFKC").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const matches = text => terms.every(term => text.includes(term));
  const hits = [];
  for (const page of confirmedState.pages.filter(candidate => !candidate.deleted)) {
    const pageText = searchablePageText(page);
    if (matches(pageText)) hits.push({ page, snippet: page.type === "database" ? `${page.rows.length} rows` : "Browser development search", native: false });
    for (const row of page.rows ?? []) {
      const cells = page.columns.map(column => ({ column, value: searchableScalars(row.values[column.id]).join(" ") }));
      const rowText = cells.map(cell => cell.value).join(" ").normalize("NFKC").toLowerCase();
      if (!matches(rowText)) continue;
      const context = cells.filter(cell => terms.some(term => cell.value.normalize("NFKC").toLowerCase().includes(term)))
        .map(cell => `${cell.column.name}: ${cleanSnippet(cell.value)}`).join(" · ");
      hits.push({ page, rowId: row.id, snippet: context || "Matching table row", native: false });
    }
  }
  return hits.slice(0, 50);
}
function openSearchResult(pageId, rowId) {
  const page = state.pages.find(candidate => candidate.id === pageId && !candidate.deleted);
  if (!page || (rowId && !page.rows?.some(row => row.id === rowId))) return;
  state.activePageId = page.id;
  $("#searchDialog").close();
  render();
  requestAnimationFrame(() => {
    const target = rowId ? document.querySelector(`[data-row-id="${CSS.escape(rowId)}"] [data-cell]`) : $("#pageTitle");
    target?.focus();
    if (rowId) announce(`Opened ${page.title}, matching table row.`);
  });
}
let rootCreationInFlight = false;
async function createRootPage(type, trigger) {
  if (rootCreationInFlight) return false;
  rootCreationInFlight = true;
  const controls = [$("#addRootPage"), $("#addRootTable")].filter(Boolean);
  controls.forEach(control => { control.disabled = true; });
  const previous = structuredClone(state);
  const siblings = childrenOf(null);
  const page = { id: uid(), parentId: null, order: siblings.length, type,
    title: type === "database" ? "Untitled database" : "Untitled page",
    blocks: type === "document" ? [{ id: uid(), type: "paragraph", text: "" }] : [],
    columns: type === "database" ? [{ id: uid(), name: "Name", type: "text" }] : [], rows: [] };
  state.pages.push(page); state.activePageId = page.id;
  render();
  $("#sidebar").classList.remove("open");
  const saved = await persist();
  if (!saved) {
    state = previous;
    render();
    announce(`${type === "database" ? "Table" : "Page"} creation failed. No content was added.`);
    requestAnimationFrame(() => trigger?.focus());
  } else {
    undoStack.push(JSON.stringify(previous)); if (undoStack.length > 80) undoStack.shift(); redoStack = [];
    announce(type === "database" ? "Table created and saved." : "Page created and saved.");
    requestAnimationFrame(() => $("#pageTitle")?.select());
  }
  rootCreationInFlight = false;
  controls.forEach(control => { control.disabled = false; });
  return saved;
}
function announce(message) { $("#saveState").textContent = message; }
async function deleteBlock(blockId, trigger) {
  if (!confirm("Permanently delete this block? This cannot be undone.")) { announce("Block deletion cancelled."); trigger?.focus(); return false; }
  const page = activePage();
  const at = page?.blocks?.findIndex(block => block.id === blockId) ?? -1;
  if (at < 0) { announce("Block deletion failed: block not found."); trigger?.focus(); return false; }
  checkpoint(); page.blocks.splice(at, 1);
  await persist(); render(); announce("Block deleted.");
  requestAnimationFrame(() => {
    const surviving = document.querySelectorAll('[data-block]');
    surviving[Math.min(at, surviving.length - 1)]?.focus();
    if (!surviving.length) $("#addBlock")?.focus();
  });
  return true;
}
$("#saveState").textContent = workspaceStore.kind === "tauri" ? "Connected to Motion" : "Browser development mode";
for (const id of ["attachFile", "createVerifiedBackup", "restoreVerifiedBackup"]) {
  const button = $(`#${id}`); button.disabled = workspaceStore.kind !== "tauri";
  if (button.disabled) button.title = "Available in the native Motion application";
}
render();
