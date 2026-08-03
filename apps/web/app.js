import { createMotionUiAdapter } from "./app-adapter.js";

const workspaceStore = createMotionUiAdapter();
let state = await workspaceStore.load();
let saveQueue = Promise.resolve();
let undoStack = [], redoStack = [], editStartedFor = null;
const $ = (selector) => document.querySelector(selector);
const uid = () => crypto.randomUUID();
const activePage = () => state.pages.find((page) => page.id === state.activePageId);
const childrenOf = (parentId) => state.pages.filter((page) => page.parentId === parentId).sort((a, b) => a.order - b.order);
const escapeHtml = (value = "") => value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const BLOCK_TYPES = ["paragraph", "heading1", "heading2", "heading3", "bullet", "number", "task", "toggle", "quote", "code", "divider"];
const blockLabel = (type) => ({ paragraph:"Text", heading1:"Heading 1", heading2:"Heading 2", heading3:"Heading 3", bullet:"Bulleted list", number:"Numbered list", task:"Task", toggle:"Toggle", quote:"Quote", code:"Code", divider:"Divider" }[type] || `Unsupported: ${type}`);
const snapshot = () => JSON.stringify(state);
function checkpoint() { undoStack.push(snapshot()); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
function restoreSnapshot(raw) { state = JSON.parse(raw); void persist(); render(); }
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restoreSnapshot(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restoreSnapshot(redoStack.pop()); }

async function persist() {
  $("#saveState").textContent = "Saving…";
  try {
    const candidate = structuredClone(state);
    saveQueue = saveQueue.catch(() => undefined).then(() => workspaceStore.save(candidate));
    await saveQueue;
    $("#saveState").textContent = workspaceStore.kind === "tauri" ? "Saved to Motion" : "Saved in browser (development mode)";
  } catch (error) {
    console.error("Workspace save failed", error);
    $("#saveState").textContent = "Save failed";
  }
}

function exportWorkspace() {
  const payload = JSON.stringify({ exportVersion: "motion.workspace/1.0", exportedAt: new Date().toISOString(), workspace: state }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `motion-workspace-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function restoreWorkspace(file) {
  const parsed = JSON.parse(await file.text());
  const candidate = parsed?.exportVersion === "motion.workspace/1.0" ? parsed.workspace : parsed;
  if (candidate?.schemaVersion !== 1 || !Array.isArray(candidate.pages)) throw new Error("Unsupported or invalid Motion workspace backup");
  state = structuredClone(candidate);
  if (!state.pages.some((page) => page.id === state.activePageId)) state.activePageId = state.pages[0]?.id ?? null;
  await persist();
  render();
}

function addPage(parentId = null, type = "document") {
  checkpoint();
  const siblings = childrenOf(parentId);
  const page = { id: uid(), parentId, order: siblings.length, type, title: type === "database" ? "Untitled database" : "Untitled page", blocks: type === "document" ? [{ id: uid(), type: "paragraph", text: "" }] : [], columns: type === "database" ? [{ id: uid(), name: "Name", type: "text" }] : [], rows: [] };
  state.pages.push(page); state.activePageId = page.id; persist(); render();
  requestAnimationFrame(() => $("#pageTitle")?.select());
}

function removePage(pageId) {
  checkpoint();
  const doomed = new Set([pageId]);
  let changed = true;
  while (changed) { changed = false; state.pages.forEach((p) => { if (p.parentId && doomed.has(p.parentId) && !doomed.has(p.id)) { doomed.add(p.id); changed = true; } }); }
  state.pages = state.pages.filter((p) => !doomed.has(p.id));
  if (doomed.has(state.activePageId)) state.activePageId = state.pages[0]?.id ?? null;
  persist(); render();
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
    const input = block.type === "divider" ? `<hr aria-label="Divider">` : `<div class="block-input ${type}" contenteditable="true" role="textbox" data-block="${block.id}" data-placeholder="Type text, or [[Page name]]">${escapeHtml(block.text || "")}</div>`;
    return `<div class="block-row ${type}" data-block-id="${block.id}" style="--indent:${block.indent || 0}"><div class="block-tools"><button type="button" data-move-block="${block.id}:-1" aria-label="Move block up" ${index ? "" : "disabled"}>↑</button><button type="button" data-move-block="${block.id}:1" aria-label="Move block down" ${index < page.blocks.length - 1 ? "" : "disabled"}>↓</button></div><select data-block-type="${block.id}" aria-label="Block type"><option value="${escapeHtml(block.type)}">${escapeHtml(blockLabel(block.type))}</option>${BLOCK_TYPES.filter(t => t !== block.type).map(t => `<option value="${t}">${blockLabel(t)}</option>`).join("")}</select>${block.type === "task" ? `<input class="task-check" type="checkbox" data-task="${block.id}" ${block.checked ? "checked" : ""} aria-label="Mark task complete">` : ""}<span class="block-handle" aria-hidden="true">⋮⋮</span>${input}<button class="delete-block" type="button" data-delete-block="${block.id}" aria-label="Delete block">×</button></div>`;
  }).join("");
  $("#content").innerHTML = `<article class="page"><div class="page-kicker"><span>Document</span><button class="danger-text" data-delete-page="${page.id}" type="button">Delete</button></div><input id="pageTitle" class="page-title" value="${escapeHtml(page.title)}" aria-label="Page title" placeholder="Untitled page" />
    <div class="blocks">${blocks}</div><button class="add-block" id="addBlock" type="button">+ Add block</button></article>`;
}

function renderDatabase(page) {
  const headers = page.columns.map((c) => `<th><input value="${escapeHtml(c.name)}" data-column-name="${c.id}" aria-label="Column name" /></th>`).join("");
  const rows = page.rows.map((row) => `<tr>${page.columns.map((c) => `<td><input value="${escapeHtml(row.values[c.id] ?? "")}" data-cell="${row.id}:${c.id}" aria-label="${escapeHtml(c.name)}" /></td>`).join("")}<td class="row-tools"><button data-delete-row="${row.id}" type="button" aria-label="Delete row">×</button></td></tr>`).join("");
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
function renderSearch(query) {
  const term = query.trim().toLowerCase();
  if (!term) { $("#searchResults").innerHTML = `<div class="search-hint">Start typing to search page titles and document text.</div>`; return; }
  const hits = state.pages.filter((p) => p.title.toLowerCase().includes(term) || p.blocks?.some((b) => b.text.toLowerCase().includes(term)));
  $("#searchResults").innerHTML = hits.length ? hits.map((p) => `<button type="button" data-search-page="${p.id}"><span class="result-icon">${p.type === "database" ? "▦" : "□"}</span><span><strong>${escapeHtml(p.title)}</strong><small>${p.type === "database" ? `${p.rows.length} rows` : "Document"}</small></span></button>`).join("") : `<div class="search-hint">No results for “${escapeHtml(query)}”.</div>`;
}

document.addEventListener("click", (event) => {
  const el = event.target.closest("button"); if (!el) return;
  const openId = el.dataset.openPage; if (openId) { state.activePageId = openId; persist(); render(); $("#sidebar").classList.remove("open"); }
  if (el.dataset.addChild) addPage(el.dataset.addChild);
  if (el.dataset.movePage) { checkpoint(); const [id, deltaText] = el.dataset.movePage.split(":"); const page = state.pages.find(p => p.id === id), siblings = childrenOf(page.parentId), at = siblings.findIndex(p => p.id === id), to = at + Number(deltaText); if (to >= 0 && to < siblings.length) { const other = siblings[to]; [page.order, other.order] = [other.order, page.order]; persist(); render(); } }
  if (el.dataset.create) addPage(null, el.dataset.create);
  if (el.dataset.deletePage && confirm("Delete this page and any pages inside it?")) removePage(el.dataset.deletePage);
  if (el.dataset.deleteBlock) { checkpoint(); const page = activePage(); page.blocks = page.blocks.filter((b) => b.id !== el.dataset.deleteBlock); persist(); render(); }
  if (el.dataset.moveBlock) { checkpoint(); const [id, deltaText] = el.dataset.moveBlock.split(":"); const blocks = activePage().blocks, at = blocks.findIndex(b => b.id === id), to = at + Number(deltaText); if (at >= 0 && to >= 0 && to < blocks.length) [blocks[at], blocks[to]] = [blocks[to], blocks[at]]; persist(); render(); }
  if (el.dataset.deleteRow) { const page = activePage(); page.rows = page.rows.filter((r) => r.id !== el.dataset.deleteRow); persist(); render(); }
  if (el.dataset.searchPage) { state.activePageId = el.dataset.searchPage; persist(); $("#searchDialog").close(); render(); }
  if (el.id === "addRootPage") addPage();
  if (el.id === "addBlock") { checkpoint(); activePage().blocks.push({ id: uid(), type: "paragraph", text: "", indent:0, links:[] }); persist(); render(); requestAnimationFrame(() => [...document.querySelectorAll("[data-block]")].at(-1)?.focus()); }
  if (el.id === "addColumn") { const page = activePage(), id = uid(); page.columns.push({ id, name: "Property", type: "text" }); persist(); render(); }
  if (el.id === "addRow") { const page = activePage(); page.rows.push({ id: uid(), values: Object.fromEntries(page.columns.map((c) => [c.id, ""])) }); persist(); render(); }
  if (el.id === "openSearch") openSearch();
  if (el.id === "openSidebar") $("#sidebar").classList.add("open");
  if (el.id === "closeSidebar") $("#sidebar").classList.remove("open");
  if (el.id === "exportWorkspace") exportWorkspace();
  if (el.id === "restoreWorkspace") $("#restoreFile").click();
  if (el.id === "homeButton" && !state.pages.length) renderEmptyWorkspace();
});

$("#restoreFile").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    await restoreWorkspace(file);
  } catch (error) {
    alert(error instanceof Error ? error.message : "Could not restore this backup");
  } finally {
    event.target.value = "";
  }
});

document.addEventListener("input", (event) => {
  const page = activePage(); if (!page) return;
  if (event.target.id === "pageTitle") { const old = page.title; page.title = event.target.value; state.pages.forEach(p => (p.blocks || []).forEach(b => { if ((b.links || []).some(l => l.pageId === page.id)) { b.text = (b.text || "").replaceAll(`[[${old}]]`, `[[${page.title}]]`); (b.links || []).filter(l => l.pageId === page.id).forEach(l => l.title = page.title); } })); persist(); $("#pageTree").innerHTML = renderTree(); renderContext(page); }
  if (event.target.dataset.block) { const block = page.blocks.find((b) => b.id === event.target.dataset.block); block.text = event.target.textContent; refreshBlockLinks(block); persist(); renderContext(page); }
  if (event.target.dataset.columnName) { page.columns.find((c) => c.id === event.target.dataset.columnName).name = event.target.value; persist(); }
  if (event.target.dataset.cell) { const [rowId, colId] = event.target.dataset.cell.split(":"); page.rows.find((r) => r.id === rowId).values[colId] = event.target.value; persist(); }
  if (event.target.id === "searchInput") renderSearch(event.target.value);
});

document.addEventListener("focusin", event => {
  const key = event.target.id === "pageTitle" ? "title" : event.target.dataset?.block ? `block:${event.target.dataset.block}` : null;
  if (key && editStartedFor !== key) { checkpoint(); editStartedFor = key; }
});
document.addEventListener("focusout", event => { if (event.target.id === "pageTitle" || event.target.dataset?.block) editStartedFor = null; });

document.addEventListener("change", event => {
  const page = activePage(); if (!page) return;
  if (event.target.dataset.blockType) { checkpoint(); const block = page.blocks.find(b => b.id === event.target.dataset.blockType); block.type = event.target.value; if (block.type === "task") block.checked ||= false; persist(); render(); requestAnimationFrame(() => document.querySelector(`[data-block="${block.id}"]`)?.focus()); }
  if (event.target.dataset.task) { checkpoint(); page.blocks.find(b => b.id === event.target.dataset.task).checked = event.target.checked; persist(); }
});

document.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); return; }
  if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
  const input = event.target.closest?.("[data-block]"); if (!input) return;
  const page = activePage(), id = input.dataset.block, at = page.blocks.findIndex(b => b.id === id), block = page.blocks[at];
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); checkpoint(); const next = { id:uid(), type:block.type === "divider" ? "paragraph" : block.type, text:"", indent:block.indent || 0, links:[] }; page.blocks.splice(at + 1, 0, next); persist(); render(); requestAnimationFrame(() => document.querySelector(`[data-block="${next.id}"]`)?.focus()); }
  if (event.key === "Tab") { event.preventDefault(); checkpoint(); block.indent = Math.max(0, Math.min(4, (block.indent || 0) + (event.shiftKey ? -1 : 1))); persist(); render(); requestAnimationFrame(() => document.querySelector(`[data-block="${id}"]`)?.focus()); }
  if (mod && event.key.toLowerCase() === "d") { event.preventDefault(); checkpoint(); const copy = structuredClone(block); copy.id = uid(); page.blocks.splice(at + 1, 0, copy); persist(); render(); }
  if (mod && event.key === "Backspace") { event.preventDefault(); checkpoint(); page.blocks.splice(at, 1); persist(); render(); requestAnimationFrame(() => document.querySelectorAll("[data-block]")[Math.max(0, at - 1)]?.focus()); }
  if (event.altKey && ["ArrowUp","ArrowDown"].includes(event.key)) { event.preventDefault(); const to = at + (event.key === "ArrowUp" ? -1 : 1); if (to >= 0 && to < page.blocks.length) { checkpoint(); [page.blocks[at], page.blocks[to]] = [page.blocks[to], page.blocks[at]]; persist(); render(); requestAnimationFrame(() => document.querySelector(`[data-block="${id}"]`)?.focus()); } }
});
$("#saveState").textContent = workspaceStore.kind === "tauri" ? "Connected to Motion" : "Browser development mode";
render();
