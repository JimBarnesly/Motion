import { MAX_ATTACHMENT_BYTES } from "./attachment-policy.js";
export { MAX_ATTACHMENT_BYTES } from "./attachment-policy.js";

export function createAttachmentIngestion({ activePage, authority, runCanonical, ingest, digest, confirm, status }) {
  const fromFiles = async files => {
    const file = files?.[0];
    if (!file) { status("No file selected"); return false; }
    const page = activePage();
    if (!page) { status("Attachment failed: open a page first"); return false; }
    try {
      return await runCanonical("attaching a file", async () => {
        const captured = authority();
        if (captured.pageId !== page.id) throw new Error("Workspace or page changed before attachment ingestion started");
        if (Number.isFinite(file.size) && file.size > MAX_ATTACHMENT_BYTES) throw new Error("Attachments must not exceed 3 MiB");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attachments must not exceed 3 MiB");
        const sha256 = await digest(bytes), current = authority();
        if (current.workspaceId !== captured.workspaceId || current.pageId !== captured.pageId || current.revision !== captured.revision) throw new Error("Workspace or page changed while the attachment was being prepared");
        const result = await ingest({ pageId: captured.pageId, position: { parentBlockId: null, beforeBlockId: null }, fileName: file.name,
          mediaType: file.type || "application/octet-stream", sha256, bytes });
        const after = authority();
        if (after.workspaceId !== captured.workspaceId || after.pageId !== captured.pageId || after.revision !== captured.revision) throw new Error("Workspace or page changed while the attachment was being published");
        confirm(result); status(`Attached ${file.name}`); return true;
      });
    } catch (error) {
      status(`Attachment failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
  return {
    fromSelection: fromFiles,
    async fromDrop(event) { event.preventDefault(); return fromFiles(event.dataTransfer?.files); }
  };
}
