import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUSY_MESSAGE = "Motion data is already open in another desktop process";

export class NativeServiceLockError extends Error {
  constructor(message = BUSY_MESSAGE) {
    super(message);
    this.name = "NativeServiceLockError";
    this.code = "MOTION_DATA_ROOT_BUSY";
  }
}

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { alive: false, token: null };
  if (process.platform === "linux") {
    try {
      const record = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = record.slice(record.lastIndexOf(")") + 2).trim().split(/\s+/);
      const uptimeSeconds = Number.parseFloat(readFileSync("/proc/uptime", "utf8"));
      const startTicks = Number(fields[19]);
      const startedAtMs = Number.isFinite(uptimeSeconds) && Number.isFinite(startTicks)
        ? Date.now() - ((uptimeSeconds - startTicks / 100) * 1000) : null;
      return { alive: true, token: fields[19] ?? null, startedAtMs };
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") return { alive: false, token: null };
      throw new NativeServiceLockError();
    }
  }
  try { process.kill(pid, 0); return { alive: true, token: null }; }
  catch (error) { return { alive: error?.code === "EPERM", token: null }; }
}

function validLockValue(value) {
  return value?.schemaVersion === 1 && Number.isSafeInteger(value.pid) && value.pid > 0
    && (process.platform === "linux" ? typeof value.processStartToken === "string" && value.processStartToken.length > 0
      : value.processStartToken === null || typeof value.processStartToken === "string")
    && typeof value.nonce === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.nonce)
    && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt));
}

function readLock(lockPath) {
  const before = lstatSync(lockPath);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : before.uid;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== expectedUid
      || (process.platform !== "win32" && (before.mode & 0o777) !== 0o600)) throw new NativeServiceLockError();
  const descriptor = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (before.dev !== opened.dev || before.ino !== opened.ino || opened.nlink !== 1 || opened.uid !== expectedUid) throw new NativeServiceLockError();
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength > 4096) throw new NativeServiceLockError();
    const value = JSON.parse(bytes.toString("utf8"));
    if (!validLockValue(value)) throw new NativeServiceLockError();
    return { metadata: opened, value };
  } catch { throw new NativeServiceLockError(); }
  finally { closeSync(descriptor); }
}

function sameEvidence(left, right) {
  return left.metadata.dev === right.metadata.dev && left.metadata.ino === right.metadata.ino
    && left.value?.nonce === right.value?.nonce && left.value?.processStartToken === right.value?.processStartToken;
}

export function acquireNativeServiceLock(dataRoot, options = {}) {
  const lockPath = join(dataRoot, ".motion-service.lock");
  const identity = processIdentity(process.pid);
  if (!identity.alive || (process.platform === "linux" && !identity.token)) throw new NativeServiceLockError();
  const value = { schemaVersion: 1, pid: process.pid, processStartToken: identity.token, nonce: randomUUID(), createdAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
      fsyncSync(descriptor);
      const owned = fstatSync(descriptor);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          closeSync(descriptor);
          try {
            const current = readLock(lockPath);
            if (current.metadata.dev === owned.dev && current.metadata.ino === owned.ino
                && current.value?.nonce === value.nonce && current.value?.processStartToken === value.processStartToken) unlinkSync(lockPath);
          } catch (error) {
            if (error?.code !== "ENOENT" && !(error instanceof NativeServiceLockError)) throw error;
          }
        }
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== "EEXIST" || attempt > 0) {
        if (error instanceof NativeServiceLockError) throw error;
        throw new NativeServiceLockError();
      }
      const evidence = readLock(lockPath);
      const owner = processIdentity(evidence.value?.pid);
      if (owner.alive && (owner.token === null || owner.token === evidence.value?.processStartToken)) throw new NativeServiceLockError();
      if (owner.alive && owner.token !== evidence.value?.processStartToken
          && (!owner.startedAtMs || Date.parse(evidence.value.createdAt) >= owner.startedAtMs)) throw new NativeServiceLockError();
      options.beforeStaleDelete?.();
      const confirmed = readLock(lockPath);
      if (!sameEvidence(evidence, confirmed)) throw new NativeServiceLockError();
      unlinkSync(lockPath);
    }
  }
  throw new NativeServiceLockError();
}
