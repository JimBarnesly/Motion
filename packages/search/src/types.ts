export type SearchEntityType = "page" | "collection" | "attachment";

export interface SearchDocument {
  id: string;
  workspaceId: string;
  type: SearchEntityType;
  title: string;
  body?: string;
  headings?: readonly string[];
  blocks?: readonly string[];
  collectionId?: string;
  collectionName?: string;
  propertyNames?: readonly string[];
  propertyValues?: Readonly<Record<string, string | readonly string[]>>;
  selectValues?: readonly string[];
  fileNames?: readonly string[];
  aliases?: readonly string[];
  backlinks?: readonly string[];
  updatedAt: string;
}

export interface SearchFilters {
  workspaceId?: string;
  types?: readonly SearchEntityType[];
  collectionId?: string;
  updatedFrom?: string;
  updatedTo?: string;
  property?: { name: string; value?: string };
}

export interface HighlightRange { start: number; end: number }

export interface SearchHit {
  id: string;
  type: SearchEntityType;
  title: string;
  score: number;
  snippet: string;
  highlights: HighlightRange[];
  matchedFields: string[];
}

export interface SearchOptions {
  filters?: SearchFilters;
  limit?: number;
  recordHistory?: boolean;
}

export interface SearchIntegrityReport {
  ok: boolean;
  documentCount: number;
  duplicateIds: string[];
  invalidDocuments: Array<{ id: string; reason: string }>;
}
