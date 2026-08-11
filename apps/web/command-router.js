const FORBIDDEN_PAYLOAD_FIELDS = new Set(["workspace", "document", "schemaVersion", "workspaceId", "expectedRevision"]);

export function createNativeCommandController({ execute, confirm, currentRevision }) {
  if (typeof execute !== "function" || typeof confirm !== "function" || typeof currentRevision !== "function") throw new TypeError("Native command controller requires execute, confirm, and currentRevision functions");
  return Object.freeze({
    async execute(type, payload = {}) {
      if (type === "workspace.import-web-v1") throw new Error("Web-v1 import is not a normal edit command");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Native command payload must be an object");
      const forbidden = Object.keys(payload).find(key => FORBIDDEN_PAYLOAD_FIELDS.has(key));
      if (forbidden === "workspace" || forbidden === "document" || forbidden === "schemaVersion") throw new Error("Normal edits cannot carry a caller snapshot");
      const authoritativePayload = Object.fromEntries(Object.entries(payload).filter(([key]) => !FORBIDDEN_PAYLOAD_FIELDS.has(key)));
      const result = await execute(type, authoritativePayload);
      if (!result?.workspace || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error("Native command returned an invalid confirmed snapshot");
      if (result.revision > currentRevision()) confirm(result.workspace, result.revision);
      return result;
    }
  });
}
