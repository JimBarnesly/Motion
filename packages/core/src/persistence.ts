import { assertWorkspace, type Workspace } from "./model.js";

/** Storage boundary: browser IndexedDB, SQLite, or filesystem adapters can implement this. */
export interface WorkspaceStore {
  load(workspaceId: string): Promise<Workspace | undefined>;
  save(workspace: Workspace): Promise<void>;
  list(): Promise<Pick<Workspace, "id" | "name" | "updatedAt">[]>;
  remove(workspaceId: string): Promise<void>;
}

export class MemoryWorkspaceStore implements WorkspaceStore {
  private readonly workspaces = new Map<string, Workspace>();
  async load(id: string) { const value = this.workspaces.get(id); return value && structuredClone(value); }
  async save(workspace: Workspace) { assertWorkspace(workspace); this.workspaces.set(workspace.id, structuredClone(workspace)); }
  async list() { return [...this.workspaces.values()].map(({ id, name, updatedAt }) => ({ id, name, updatedAt })); }
  async remove(id: string) { this.workspaces.delete(id); }
}
