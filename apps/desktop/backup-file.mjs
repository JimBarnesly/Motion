import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, readdir, rm, stat } from "./backup-filesystem.mjs";
import { basename, dirname, join } from "node:path";
import { canonicalJson, verifyBackup } from "@motion/backup";

const encode = value => value instanceof Uint8Array ? { $motionBytes: Array.from(value) }
  : Array.isArray(value) ? value.map(encode)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]))
  : value;
const revive = value => Array.isArray(value) ? value.map(revive)
  : value && typeof value === "object" && Object.keys(value).length === 1 && Array.isArray(value.$motionBytes)
    ? Uint8Array.from(value.$motionBytes)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, revive(child)]))
    : value;

async function pathState(path) {
  try { return await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function rejectDestination(destination) {
  const existing = await pathState(destination);
  if (!existing) return;
  if (existing.isSymbolicLink()) throw new Error("Backup destination must not be a symbolic link");
  throw new Error("Backup destination already exists");
}

async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { alive: false, token: null };
  if (process.platform === "linux") {
    try {
      const record = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = record.slice(record.lastIndexOf(")") + 2).trim().split(/\s+/);
      const uptimeSeconds = Number.parseFloat(await readFile("/proc/uptime", "utf8"));
      const startTicks = Number(fields[19]);
      const startedAtMs = Number.isFinite(uptimeSeconds) && Number.isFinite(startTicks)
        ? Date.now() - ((uptimeSeconds - startTicks / 100) * 1000) : null;
      return { alive: true, token: fields[19] ?? null, startedAtMs };
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") return { alive: false, token: null, startedAtMs: null };
    }
  }
  try { process.kill(pid, 0); return { alive: true, token: null, startedAtMs: null }; }
  catch (error) { return { alive: error?.code === "EPERM", token: null, startedAtMs: null }; }
}

const lockMetadataValid = value => value?.schemaVersion === 2 && Number.isSafeInteger(value.pid)
  && typeof value.processStartToken === "string" && value.processStartToken.length > 0
  && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
  && typeof value.nonce === "string" && /^[a-f0-9-]{36}$/.test(value.nonce)
  && typeof value.temporaryName === "string" && !value.temporaryName.includes("/") && !value.temporaryName.includes("\\")
  && Number.isSafeInteger(value.temporaryDev) && value.temporaryDev >= 0
  && Number.isSafeInteger(value.temporaryIno) && value.temporaryIno > 0;

async function readLock(lockPath) {
  const metadata = await lstat(lockPath);
  if (metadata.isSymbolicLink()) throw new Error("Backup lock must not be a symbolic link");
  if (!metadata.isFile()) throw new Error("Backup lock has an unexpected type");
  const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedMetadata = await handle.stat();
    if (metadata.dev !== openedMetadata.dev || metadata.ino !== openedMetadata.ino) throw new Error("Backup lock changed while being authenticated");
    const bytes = await handle.readFile();
    if (bytes.byteLength > 4096) return { metadata: openedMetadata, value: null };
    try { return { metadata: openedMetadata, value: JSON.parse(bytes.toString("utf8")) }; }
    catch { return { metadata: openedMetadata, value: null }; }
  } finally { await handle.close(); }
}

async function recoverAbandonedLock(destination, lockPath) {
  const lock = await readLock(lockPath);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : lock.metadata.uid;
  const privatelyOwned = lock.metadata.isFile() && lock.metadata.nlink === 1 && lock.metadata.uid === expectedUid
    && (lock.metadata.mode & 0o777) === 0o600;
  if (!privatelyOwned || !lockMetadataValid(lock.value)) throw new Error("Backup lock is malformed or unverifiable; inspect and remove it manually if no writer is active");
  const expectedName = `.${basename(destination)}.motion-backup-${lock.value.pid}-${lock.value.nonce}.tmp`;
  if (lock.value.temporaryName !== expectedName) throw new Error("Backup lock temporary ownership metadata is invalid; inspect the lock and temporary manually");
  const orphan = join(dirname(destination), lock.value.temporaryName);
  const orphanState = await pathState(orphan);
  if (!orphanState) throw new Error("Backup lock references a missing temporary file; lock evidence was left untouched for manual recovery");
  const temporaryPrivate = orphanState.isFile() && !orphanState.isSymbolicLink() && orphanState.nlink === 1
    && orphanState.uid === expectedUid && (orphanState.mode & 0o777) === 0o600
    && orphanState.dev === lock.value.temporaryDev && orphanState.ino === lock.value.temporaryIno;
  if (!temporaryPrivate) throw new Error("Backup lock temporary file is malformed, symbolic, or mismatched; lock and temporary were left untouched for manual recovery");
  const owner = await processIdentity(lock.value.pid);
  const sameOwner = owner.alive && (owner.token === null || owner.token === lock.value.processStartToken);
  if (sameOwner) throw new Error("Backup destination is locked by an active writer");
  if (owner.alive && owner.token !== lock.value.processStartToken) {
    const lockCreatedAt = Date.parse(lock.value.createdAt);
    if (!owner.startedAtMs || lockCreatedAt >= owner.startedAtMs) {
      throw new Error("Backup lock process identity mismatch is not a verifiable PID reuse; remove it manually if safe");
    }
  }
  const confirmedLock = await readLock(lockPath); const confirmedTemporary = await lstat(orphan);
  if (confirmedLock.metadata.dev !== lock.metadata.dev || confirmedLock.metadata.ino !== lock.metadata.ino
      || confirmedLock.value?.nonce !== lock.value.nonce || confirmedTemporary.dev !== orphanState.dev
      || confirmedTemporary.ino !== orphanState.ino) throw new Error("Backup recovery evidence changed during authentication; nothing was removed");
  await rm(orphan);
  await rm(lockPath);
}

async function acquireLock(destination, temporary, temporaryMetadata, nonce, options) {
  const lockPath = `${destination}.motion-backup.lock`;
  const identity = await processIdentity(process.pid);
  if (!identity.alive || !identity.token) throw new Error("Could not establish backup writer process identity");
  const value = { schemaVersion: 2, pid: process.pid, processStartToken: identity.token, createdAt: new Date().toISOString(), nonce,
    temporaryName: basename(temporary), temporaryDev: temporaryMetadata.dev, temporaryIno: temporaryMetadata.ino };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.chmod(0o600); await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync();
      return { handle, lockPath, value };
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      await recoverAbandonedLock(destination, lockPath);
    }
  }
  throw new Error("Could not acquire backup destination lock");
}

async function releaseOwnedLock(lock) {
  await lock.handle.close().catch(() => {});
  try {
    const current = await readLock(lock.lockPath);
    if (lockMetadataValid(current.value) && current.value.nonce === lock.value.nonce
        && current.value.processStartToken === lock.value.processStartToken) await rm(lock.lockPath);
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

export async function cleanupStaleBackupFiles(destination) {
  const directory = dirname(destination);
  const prefix = `.${basename(destination)}.motion-backup-`;
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    throw new Error(`Unowned backup temporary evidence was left untouched: ${name}; authenticate its lock or inspect it manually`);
  }
}

export function serializeBackup(bundle) {
  const verification = verifyBackup(bundle);
  if (!verification.valid) throw new Error("Backup verification failed before serialization");
  return Buffer.from(`${canonicalJson(encode(bundle))}\n`, "utf8");
}

export function verifySerializedBackup(bytes) {
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { return { valid: false, errors: ["Backup file is not valid JSON"] }; }
  if (`${canonicalJson(parsed)}\n` !== bytes.toString("utf8")) return { valid: false, errors: ["Backup file is not canonical"] };
  return verifyBackup(revive(parsed));
}

export async function createAtomicBackupFile(destination, bundle, options = {}) {
  const directory = dirname(destination);
  const directoryState = await pathState(directory);
  if (!directoryState?.isDirectory() || directoryState.isSymbolicLink()) throw new Error("Backup destination directory is unavailable");
  await rejectDestination(destination);
  const nonce = randomUUID();
  const temporary = join(directory, `.${basename(destination)}.motion-backup-${process.pid}-${nonce}.tmp`);
  let lock;
  let file;
  let published = false;
  try {
    file = options.openTemporary
      ? await options.openTemporary(temporary)
      : await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await file.chmod(0o600);
    const temporaryMetadata = await file.stat();
    if (!temporaryMetadata.isFile() || temporaryMetadata.nlink !== 1 || (temporaryMetadata.mode & 0o777) !== 0o600) {
      throw new Error("Backup temporary file could not be authenticated");
    }
    lock = await acquireLock(destination, temporary, temporaryMetadata, nonce, options);
    await rejectDestination(destination);
    const bytes = serializeBackup(bundle);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = options.write ? await options.write(file, bytes, offset) : await file.write(bytes, offset, bytes.byteLength - offset, offset);
      if (!result || result.bytesWritten <= 0) throw new Error("Backup write made no progress");
      offset += result.bytesWritten;
    }
    await (options.flush ? options.flush(file) : file.sync());
    await file.close(); file = null;

    const persisted = await readFile(temporary);
    if (!persisted.equals(bytes)) throw new Error("Backup write did not persist the complete canonical payload");
    const verification = options.verify ? await options.verify(persisted) : verifySerializedBackup(persisted);
    if (!verification.valid) throw new Error("Persisted backup failed canonical verification");
    await rejectDestination(destination);
    if (options.beforePublish) await options.beforePublish(temporary);
    await (options.publish ? options.publish(temporary, destination) : link(temporary, destination));
    published = true;
    await rm(temporary);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return { path: destination, byteLength: bytes.byteLength };
  } finally {
    if (file) await file.close().catch(() => {});
    if (!published) await rm(temporary, { force: true }).catch(() => {});
    if (lock) await releaseOwnedLock(lock);
  }
}

export async function readAndVerifyBackupFile(path) {
  let handle;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) return { valid: false, errors: ["Backup path is not an authenticated single-link regular file"] };
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      return { valid: false, errors: ["Backup changed while being authenticated"] };
    }
    const bytes = await handle.readFile();
    const completed = await handle.stat();
    if (completed.dev !== opened.dev || completed.ino !== opened.ino || completed.size !== opened.size
        || completed.mtimeNs !== opened.mtimeNs || completed.ctimeNs !== opened.ctimeNs) {
      return { valid: false, errors: ["Backup changed while being read"] };
    }
    return verifySerializedBackup(bytes);
  } catch {
    return { valid: false, errors: ["Backup could not be authenticated"] };
  } finally { await handle?.close().catch(() => {}); }
}
