import type { SearchIndexAdapter } from "./adapter.js";
import type { HighlightRange, SearchDocument, SearchFilters, SearchHit, SearchIntegrityReport, SearchOptions } from "./types.js";

const normalize = (value: string): string => value.normalize("NFKD").toLocaleLowerCase();
const terms = (query: string): string[] => [...new Set(normalize(query).trim().split(/\s+/).filter(Boolean))];
const values = (record?: Readonly<Record<string, string | readonly string[]>>): string[] =>
  record ? Object.values(record).flatMap((value) => typeof value === "string" ? [value] : [...value]) : [];

function fields(document: SearchDocument): Array<[string, string, number]> {
  return [
    ["title", document.title, 12],
    ["aliases", (document.aliases ?? []).join(" "), 10],
    ["headings", (document.headings ?? []).join(" \n"), 8],
    ["body", document.body ?? "", 4],
    ["blocks", (document.blocks ?? []).join(" \n"), 5],
    ["collection", document.collectionName ?? "", 7],
    ["properties", [...(document.propertyNames ?? []), ...values(document.propertyValues)].join(" "), 6],
    ["selectValues", (document.selectValues ?? []).join(" "), 6],
    ["fileNames", (document.fileNames ?? []).join(" "), 7],
    ["backlinks", (document.backlinks ?? []).join(" "), 3]
  ];
}

function matchesFilters(document: SearchDocument, filters?: SearchFilters): boolean {
  if (!filters) return true;
  if (filters.workspaceId && document.workspaceId !== filters.workspaceId) return false;
  if (filters.types && !filters.types.includes(document.type)) return false;
  if (filters.collectionId && document.collectionId !== filters.collectionId) return false;
  if (filters.updatedFrom && document.updatedAt < filters.updatedFrom) return false;
  if (filters.updatedTo && document.updatedAt > filters.updatedTo) return false;
  if (filters.property) {
    const entry = Object.entries(document.propertyValues ?? {}).find(([name]) => normalize(name) === normalize(filters.property!.name));
    if (!entry) return false;
    if (filters.property.value && !normalize(typeof entry[1] === "string" ? entry[1] : entry[1].join(" ")).includes(normalize(filters.property.value))) return false;
  }
  return true;
}

function ranges(text: string, queryTerms: readonly string[]): HighlightRange[] {
  const lower = normalize(text);
  const found: HighlightRange[] = [];
  for (const term of queryTerms) {
    let at = lower.indexOf(term);
    while (at >= 0) { found.push({ start: at, end: at + term.length }); at = lower.indexOf(term, at + term.length); }
  }
  return found.sort((a, b) => a.start - b.start || a.end - b.end);
}

function makeSnippet(document: SearchDocument, queryTerms: readonly string[]): { snippet: string; highlights: HighlightRange[] } {
  const source = fields(document).map(([, value]) => value).find((value) => queryTerms.some((term) => normalize(value).includes(term))) ?? document.title;
  const first = Math.min(...queryTerms.map((term) => normalize(source).indexOf(term)).filter((index) => index >= 0));
  const start = Number.isFinite(first) ? Math.max(0, first - 45) : 0;
  const snippet = source.slice(start, start + 160).replace(/\s+/g, " ");
  return { snippet, highlights: ranges(snippet, queryTerms) };
}

export class LocalSearch {
  private historyEnabled = true;
  private history: string[] = [];
  constructor(private readonly adapter: SearchIndexAdapter) {}

  async index(document: SearchDocument): Promise<void> { validate(document); await this.adapter.upsert(document); }
  async remove(id: string): Promise<void> { await this.adapter.remove(id); }
  async reindex(documents: readonly SearchDocument[]): Promise<void> {
    documents.forEach(validate);
    await this.adapter.replaceAll(documents);
  }
  async quickSearch(query: string, limit = 8): Promise<SearchHit[]> { return this.search(query, { limit }); }
  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const queryTerms = terms(query);
    if (!queryTerms.length) return [];
    if (this.historyEnabled && options.recordHistory !== false) {
      this.history = [query.trim(), ...this.history.filter((item) => normalize(item) !== normalize(query.trim()))].slice(0, 20);
    }
    const hits: SearchHit[] = [];
    for (const document of await this.adapter.list()) {
      if (!matchesFilters(document, options.filters)) continue;
      const matchedFields: string[] = [];
      let score = 0;
      const allText = fields(document);
      for (const term of queryTerms) {
        let termMatched = false;
        for (const [name, text, weight] of allText) {
          const at = normalize(text).indexOf(term);
          if (at >= 0) { termMatched = true; score += weight + (at === 0 ? 2 : 0); if (!matchedFields.includes(name)) matchedFields.push(name); }
        }
        if (!termMatched) { score = 0; break; }
      }
      if (score) {
        const display = makeSnippet(document, queryTerms);
        hits.push({ id: document.id, type: document.type, title: document.title, score, ...display, matchedFields });
      }
    }
    return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)).slice(0, options.limit ?? 50);
  }
  setHistoryEnabled(enabled: boolean): void { this.historyEnabled = enabled; if (!enabled) this.history = []; }
  recentSearches(): readonly string[] { return [...this.history]; }
  clearHistory(): void { this.history = []; }
  async checkIntegrity(): Promise<SearchIntegrityReport> {
    const documents = await this.adapter.list();
    const seen = new Set<string>();
    const duplicateIds: string[] = [];
    const invalidDocuments: Array<{ id: string; reason: string }> = [];
    for (const document of documents) {
      if (seen.has(document.id)) duplicateIds.push(document.id); else seen.add(document.id);
      try { validate(document); } catch (error) { invalidDocuments.push({ id: document.id, reason: error instanceof Error ? error.message : String(error) }); }
    }
    return { ok: !duplicateIds.length && !invalidDocuments.length, documentCount: documents.length, duplicateIds, invalidDocuments };
  }
}

function validate(document: SearchDocument): void {
  if (!document.id.trim()) throw new Error("Search document ID is required");
  if (!document.workspaceId.trim()) throw new Error("Workspace ID is required");
  if (!document.title.trim()) throw new Error("Search document title is required");
  if (!Number.isFinite(Date.parse(document.updatedAt))) throw new Error("updatedAt must be an ISO-compatible date");
}
