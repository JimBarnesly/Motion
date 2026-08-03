import type { Block, Database, Page, Workspace } from "./model.js";

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "-").trim() || "untitled";
const csvCell = (value: unknown) => `"${(Array.isArray(value) ? value.join("; ") : value ?? "").toString().replaceAll('"', '""')}"`;
const blockMarkdown = (b: Block, depth = 0): string => {
  const prefix: Record<string, string> = { "heading-1": "# ", "heading-2": "## ", "heading-3": "### ", quote: "> ", task: `- [${b.checked ? "x" : " "}] `, "bulleted-list": "- ", "numbered-list": "1. " };
  const own = b.type === "code" ? `\`\`\`${b.language ?? ""}\n${b.text}\n\`\`\`` : `${"  ".repeat(depth)}${prefix[b.type] ?? ""}${b.text}`;
  return [own, ...b.children.map(child => blockMarkdown(child, depth + 1))].join("\n");
};

export const exportPageMarkdown = (page: Page) => `# ${page.title}\n\n${page.blocks.map(b => blockMarkdown(b)).join("\n\n")}\n`;
/** Canonical key ordering makes exports byte-stable for backup verification. Array order remains meaningful. */
export const exportWorkspaceJson = (workspace: Workspace) => JSON.stringify(canonical(workspace), null, 2);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function exportDatabaseCsv(database: Database): string {
  const header = ["id", ...database.properties.map(p => p.name)].map(csvCell).join(",");
  return [header, ...database.rows.map(row => [row.id, ...database.properties.map(p => row.values[p.id])].map(csvCell).join(","))].join("\n") + "\n";
}

/** Portable archive manifest. The caller supplies attachment bytes to its zip/tar implementation. */
export interface FullExport {
  schemaVersion: 1;
  files: Record<string, string>;
  attachments: { archivePath: string; sourcePath: string; sha256: string; byteLength: number }[];
}
export function exportFullWorkspace(workspace: Workspace): FullExport {
  const files: Record<string, string> = { "workspace.json": exportWorkspaceJson(workspace) };
  for (const page of workspace.pages) files[`pages/${safeName(page.title)}-${page.id}.md`] = exportPageMarkdown(page);
  for (const db of workspace.databases) files[`databases/${safeName(db.name)}-${db.id}.csv`] = exportDatabaseCsv(db);
  return { schemaVersion: 1, files, attachments: workspace.attachments.map(a => ({ archivePath: `attachments/${a.id}/${safeName(a.fileName)}`, sourcePath: a.path, sha256: a.sha256, byteLength: a.byteLength })) };
}
