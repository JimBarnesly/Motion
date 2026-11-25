import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ATTACHMENT_SIZE_LIMIT_ERROR, MAX_ATTACHMENT_BYTES } from "@motion/core";
import type { AttachmentRecoveryReport, StagedAttachment, StoredAttachment } from "./index.js";
import { invokeWindowsNativeHelper, type WindowsNativeRequest } from "./windows-native-helper.js";

type NativeCall = <T = unknown>(request: WindowsNativeRequest) => T;
type Receipt = Readonly<{ stagingName: string; fileIdentity: string; sha256: string; byteLength: number }>;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const safeIdentity = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalid(): never { throw new Error("The native attachment operation returned invalid data"); }
function assertHash(value: string): void { if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Attachment hash must be 64 lowercase hexadecimal characters"); }

/** The Windows helper owns filesystem effects; JS owns store-bound, single-use capabilities. */
export class WindowsAttachmentStore {
  private readonly rootIdentity: string;
  private readonly stagingIdentity: string;
  private readonly issued = new WeakMap<object, Receipt>();

  constructor(private readonly root: string, private readonly invoke: NativeCall = invokeWindowsNativeHelper) {
    const result = invoke({ operation: "attachment.initialize", root });
    if (!object(result) || !safeIdentity(result.rootIdentity) || !safeIdentity(result.stagingIdentity)
        || Object.keys(result).some(key => !["rootIdentity", "stagingIdentity"].includes(key))) invalid();
    this.rootIdentity = result.rootIdentity;
    this.stagingIdentity = result.stagingIdentity;
  }

  private request<T = unknown>(operation: string, parameters: Record<string, unknown> = {}): T {
    return this.invoke<T>({ operation, root: this.root, expectedRootIdentity: this.rootIdentity,
      expectedStagingIdentity: this.stagingIdentity, ...parameters });
  }

  private path(sha256: string): string { return join(this.root, sha256.slice(0, 2), sha256); }

  private consume(value: StagedAttachment): Receipt {
    const receipt = value !== null && typeof value === "object" ? this.issued.get(value) : undefined;
    if (!receipt) throw new Error("Staged attachment was not issued by this attachment store");
    this.issued.delete(value);
    return receipt;
  }

  async stage(bytes: Uint8Array): Promise<StagedAttachment> {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(ATTACHMENT_SIZE_LIMIT_ERROR);
    const sha256 = hash(bytes), byteLength = bytes.byteLength;
    const stagingName = `${sha256}.${randomUUID()}.staging`;
    const result = this.request("attachment.stage", { sha256, stagingName, bytes: Array.from(bytes) });
    if (!object(result) || result.stagingName !== stagingName || result.sha256 !== sha256
        || result.byteLength !== byteLength || !safeIdentity(result.fileIdentity)
        || Object.keys(result).some(key => !["stagingName", "fileIdentity", "sha256", "byteLength"].includes(key))) invalid();
    const capability = Object.freeze({ sha256, byteLength, path: this.path(sha256) }) as StagedAttachment;
    this.issued.set(capability, Object.freeze({ stagingName, sha256, byteLength, fileIdentity: result.fileIdentity }));
    return capability;
  }

  async promote(capability: StagedAttachment): Promise<StoredAttachment> {
    const receipt = this.consume(capability);
    const result = this.request("attachment.promote", { receipt });
    if (!object(result) || result.sha256 !== receipt.sha256 || result.byteLength !== receipt.byteLength
        || typeof result.newlyCreated !== "boolean"
        || Object.keys(result).some(key => !["sha256", "byteLength", "newlyCreated"].includes(key))) invalid();
    return { sha256: receipt.sha256, byteLength: receipt.byteLength, path: this.path(receipt.sha256), newlyCreated: result.newlyCreated };
  }

  async discard(capability: StagedAttachment): Promise<void> {
    const result = this.request("attachment.discard", { receipt: this.consume(capability) });
    if (!object(result) || result.removed !== true || Object.keys(result).some(key => key !== "removed")) invalid();
  }

  async get(sha256: string): Promise<Uint8Array> {
    assertHash(sha256);
    const result = this.request("attachment.read", { sha256 });
    if (!object(result) || Object.keys(result).some(key => key !== "bytes") || !Array.isArray(result.bytes)
        || result.bytes.length > MAX_ATTACHMENT_BYTES || result.bytes.some(value => !Number.isInteger(value) || value < 0 || value > 255)) invalid();
    const bytes = Uint8Array.from(result.bytes);
    if (hash(bytes) !== sha256) throw new Error(`Attachment integrity check failed: ${sha256}`);
    return bytes;
  }

  async recover(referencedHashes: Iterable<string>): Promise<AttachmentRecoveryReport> {
    const hashes = [...new Set(referencedHashes)]; hashes.forEach(assertHash);
    const result = this.request("attachment.recover", { referencedHashes: hashes });
    const fields = ["promoted", "removedStaging", "missingReferenced", "unreferencedBlobs", "oversizedBlobs", "corruptBlobs"];
    if (!object(result) || Object.keys(result).some(key => !fields.includes(key))) invalid();
    for (const field of fields) {
      const values = result[field];
      if (!Array.isArray(values) || values.length > 100_000 || values.some(value => typeof value !== "string"
          || (field === "removedStaging" ? !/^[A-Za-z0-9._-]{1,200}$/.test(value) : !/^[0-9a-f]{64}$/.test(value)))) invalid();
    }
    return result as unknown as AttachmentRecoveryReport;
  }
}
