const publicFailure = error => {
  const message = error instanceof Error ? error.message : String(error);
  if (/metadata did not match|size did not match|integrity check failed/i.test(message)) return message;
  return "canonical bytes could not be read";
};

export function createAttachmentAccess({ read, digest, download, status }) {
  const saving = new Set();
  return {
    async save(expected) {
      if (saving.has(expected.id)) {
        status(`Already saving ${expected.fileName}`);
        return false;
      }
      saving.add(expected.id);
      try {
        const result = await read(expected.id);
        if (result?.attachment?.id !== expected.id || result.attachment.fileName !== expected.fileName
            || result.attachment.mediaType !== expected.mediaType || result.attachment.sha256 !== expected.sha256) {
          throw new Error("attachment metadata did not match the active workspace");
        }
        if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength !== expected.byteLength) {
          throw new Error("attachment size did not match canonical metadata");
        }
        if (await digest(result.bytes) !== expected.sha256) throw new Error("attachment integrity check failed");
        download({ fileName: expected.fileName, mediaType: expected.mediaType, bytes: result.bytes });
        status(`Saved a copy of ${expected.fileName}`);
        return true;
      } catch (error) {
        const reason = publicFailure(error);
        status(`Attachment ${expected.fileName} could not be saved: ${reason}`);
        throw new Error(reason);
      } finally {
        saving.delete(expected.id);
      }
    }
  };
}
