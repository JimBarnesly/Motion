import type { SearchDocument } from "./types.js";

/** Storage boundary intended to be implemented by SQLite FTS5 on desktop. */
export interface SearchIndexAdapter {
  upsert(document: SearchDocument): Promise<void>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<SearchDocument | undefined>;
  list(): Promise<readonly SearchDocument[]>;
  replaceAll(documents: readonly SearchDocument[]): Promise<void>;
}

export class MemorySearchIndexAdapter implements SearchIndexAdapter {
  private documents = new Map<string, SearchDocument>();

  async upsert(document: SearchDocument): Promise<void> {
    this.documents.set(document.id, structuredClone(document));
  }
  async remove(id: string): Promise<void> { this.documents.delete(id); }
  async get(id: string): Promise<SearchDocument | undefined> {
    const value = this.documents.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async list(): Promise<readonly SearchDocument[]> {
    return [...this.documents.values()].map((value) => structuredClone(value));
  }
  async replaceAll(documents: readonly SearchDocument[]): Promise<void> {
    this.documents = new Map(documents.map((document) => [document.id, structuredClone(document)]));
  }
}
