const STORAGE_KEY = "motion.workspace.v1";

/** Narrow persistence boundary. A future SQLite/CRDT adapter only needs load() and save(). */
const workspaceStore = {
  load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { schemaVersion: 1, pages: [], activePageId: null };
    try {
      const data = JSON.parse(raw);
      return data?.schemaVersion === 1 && Array.isArray(data.pages) ? data : { schemaVersion: 1, pages: [], activePageId: null };
    } catch { return { schemaVersion: 1, pages: [], activePageId: null }; }
  },
  save(workspace) { localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace)); }
};

let state = workspaceStore.load();
const $ = (selector) => document.querySelector(selector);
const uid = () => crypto.randomUUID();
const activePage = () => state.pages.find((page) => page.id === state.activePageId);
const childrenOf = (parentId) => state.pages.filter((page) => page.parentId === parentId).sort((a, b) => a.order - b.order);
const escapeHtml = (value = "") => value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function persist() {
  $("#saveState").textContent = "Saving…";
  workspaceStore.save(state);
  window.setTimeout(() => { $("#saveState").textContent = "Saved locally"; }, 180);
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
  state = candidate;
  if (!state.pages.some((page) => page.id === state.activePageId)) state.activePageId = state.pages[0]?.id ?? null;
  persist();
  render();
}

function addPage(parentId = null, type = "document") {
  const siblings = childrenOf(parentId);
  const page = { id: uid(), parentId, order: siblings.length, type, title: type === "database" ? "Untitled database" : "Untitled page", blocks: type === "document" ? [{ id: uid(), type: "paragraph", text: "" }] : [], columns: type === "database" ? [{ id: uid(), name: "Name", type: "text" }] : [], rows: [] };
  state.pages.push(page); state.activePageId = page.id; persist(); render();
  requestAnimationFrame(() => $("#pageTitle")?.select());
}

function removePage(pageId) {
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
      <button class="row-action" data-add-child="${page.id}" type="button" aria-label="Add page inside ${escapeHtml(page.title)}">+</button>
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
  $("#content").innerHTML = `<div class="empty-state"><div class="empty-icon" aria-hidden="true">◇</div><h1>Your workspace is ready</h1><p>Create a page or a table. Everything stays in this browser until you choose to sync or export it.</p><div class="empty-actions"><button class="primary" data-create="document" type="button">New page</button><button data-create="database" type="button">New table</button></div></div>`;
}

function renderDocument(page) {
  const blocks = page.blocks.map((block) => `<div class="block-row" data-block-id="${block.id}"><span class="block-handle" aria-hidden="true">⋮⋮</span><div class="block-input ${block.type}" contenteditable="true" role="textbox" data-block="${block.id}" data-placeholder="Type text, or paste a [[Page name]] link">${escapeHtml(block.text)}</div><button class="delete-block" type="button" data-delete-block="${block.id}" aria-label="Delete block">×</button></div>`).join("");
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

function renderContext(page) {
  if (!page) { $("#outgoingLinks").innerHTML = $("#backlinks").innerHTML = `<p class="muted">Open a page to see connections.</p>`; return; }
  const outgoing = [...new Set(linkedTitles(page))].map((title) => state.pages.find((p) => p.title.toLowerCase() === title)).filter(Boolean);
  const incoming = state.pages.filter((p) => p.id !== page.id && linkedTitles(p).includes(page.title.toLowerCase()));
  const linksHtml = (items, empty) => items.length ? items.map((p) => `<button class="context-link" data-open-page="${p.id}" type="button"><span>↗</span>${escapeHtml(p.title)}</button>`).join("") : `<p class="muted">${empty}</p>`;
  $("#outgoingLinks").innerHTML = linksHtml(outgoing, "No page links yet. Type [[Page title]] in a block.");
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
  if (el.dataset.create) addPage(null, el.dataset.create);
  if (el.dataset.deletePage && confirm("Delete this page and any pages inside it?")) removePage(el.dataset.deletePage);
  if (el.dataset.deleteBlock) { const page = activePage(); page.blocks = page.blocks.filter((b) => b.id !== el.dataset.deleteBlock); persist(); render(); }
  if (el.dataset.deleteRow) { const page = activePage(); page.rows = page.rows.filter((r) => r.id !== el.dataset.deleteRow); persist(); render(); }
  if (el.dataset.searchPage) { state.activePageId = el.dataset.searchPage; persist(); $("#searchDialog").close(); render(); }
  if (el.id === "addRootPage") addPage();
  if (el.id === "addBlock") { activePage().blocks.push({ id: uid(), type: "paragraph", text: "" }); persist(); render(); requestAnimationFrame(() => document.querySelector("[data-block]:last-of-type")?.focus()); }
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
  if (event.target.id === "pageTitle") { page.title = event.target.value; persist(); $("#pageTree").innerHTML = renderTree(); renderContext(page); }
  if (event.target.dataset.block) { page.blocks.find((b) => b.id === event.target.dataset.block).text = event.target.textContent; persist(); renderContext(page); }
  if (event.target.dataset.columnName) { page.columns.find((c) => c.id === event.target.dataset.columnName).name = event.target.value; persist(); }
  if (event.target.dataset.cell) { const [rowId, colId] = event.target.dataset.cell.split(":"); page.rows.find((r) => r.id === rowId).values[colId] = event.target.value; persist(); }
  if (event.target.id === "searchInput") renderSearch(event.target.value);
});

document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); } });
render();
