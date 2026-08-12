export function createAttachmentIngestion({ activePage, ingest, digest, confirm, status }) {
  const fromFiles = async files => {
    const file = files?.[0];
    if (!file) { status("No file selected"); return false; }
    const page = activePage();
    if (!page) { status("Attachment failed: open a page first"); return false; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await ingest({ pageId: page.id, position: { parentBlockId: null, beforeBlockId: null }, fileName: file.name,
        mediaType: file.type || "application/octet-stream", sha256: await digest(bytes), bytes });
      confirm(result);
      status(`Attached ${file.name}`);
      return true;
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
