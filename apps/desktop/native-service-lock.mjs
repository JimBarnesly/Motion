import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  accessSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync
} from "node:fs";
import { join } from "node:path";

const BUSY_MESSAGE = "Motion data is already open in another desktop process";
// The directory flock is authoritative. This versioned file is diagnostics only;
// unknown bytes under older evidence names are deliberately left untouched.
const LOCK_NAME = ".motion-service.owner-v1";
const FLOCK_PATH = "/usr/bin/flock";
const MAX_EVIDENCE_BYTES = 4096;
const ACQUIRE_TIMEOUT_MS = 5_000;
const RELEASE_TIMEOUT_MS = 1_000;

export class NativeServiceLockError extends Error {
  constructor() {
    super(BUSY_MESSAGE);
    this.name = "NativeServiceLockError";
    this.code = "MOTION_DATA_ROOT_BUSY";
  }
}

function reject() { throw new NativeServiceLockError(); }

function expectedUid(metadata) {
  return typeof process.getuid === "function" ? process.getuid() : metadata.uid;
}

function validateRootMetadata(metadata) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || metadata.uid !== expectedUid(metadata) || metadata.nlink < 2
      || (metadata.mode & 0o777) !== 0o700) reject();
}

function validateOpenedRoot(path, descriptor) {
  let pathMetadata;
  try { pathMetadata = lstatSync(path); } catch { reject(); }
  const opened = fstatSync(descriptor);
  validateRootMetadata(pathMetadata);
  validateRootMetadata(opened);
  if (pathMetadata.dev !== opened.dev || pathMetadata.ino !== opened.ino) reject();
  return opened;
}

function validateDescriptorRoot(mutableRoot, descriptor, identity) {
  let procMetadata;
  try { procMetadata = statSync(mutableRoot); } catch { reject(); }
  const opened = fstatSync(descriptor);
  validateRootMetadata(opened);
  if (!procMetadata.isDirectory() || procMetadata.dev !== opened.dev || procMetadata.ino !== opened.ino
      || opened.dev !== identity.dev || opened.ino !== identity.ino) reject();
}

function validateOpenedEvidence(lockPath, descriptor) {
  let pathMetadata;
  try { pathMetadata = lstatSync(lockPath); } catch { reject(); }
  const opened = fstatSync(descriptor);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || !opened.isFile()
      || pathMetadata.dev !== opened.dev || pathMetadata.ino !== opened.ino
      || opened.uid !== expectedUid(opened) || opened.nlink < 1
      || (opened.mode & 0o777) !== 0o600) reject();
  return opened;
}

function readBoundedEvidence(descriptor) {
  const buffer = Buffer.allocUnsafe(MAX_EVIDENCE_BYTES + 1);
  const count = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
  return { complete: count <= MAX_EVIDENCE_BYTES, bytes: buffer.subarray(0, Math.min(count, MAX_EVIDENCE_BYTES)) };
}

function evidenceTemporaryPath(lockPath, bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
  if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return undefined;
  return `${lockPath}.${value.nonce}.tmp`;
}

function validateEvidencePayload(bytes) {
  if (!evidenceTemporaryPath("", bytes)) reject();
}

function writeTemporaryEvidence(lockPath, value) {
  const temporary = `${lockPath}.${value.nonce}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch (closeError) { error.cause ??= closeError; }
    try { unlinkSync(temporary); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") error.cause ??= cleanupError; }
    throw error;
  }
}

function writeNewEvidence(lockPath, value) {
  const temporary = writeTemporaryEvidence(lockPath, value);
  try {
    linkSync(temporary, lockPath);
    unlinkSync(temporary);
  } catch (error) {
    try { unlinkSync(temporary); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") error.cause ??= cleanupError; }
    throw error;
  }
}

function authenticateReplaceableEvidence(lockPath) {
  const descriptor = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = validateOpenedEvidence(lockPath, descriptor);
    const evidence = readBoundedEvidence(descriptor);
    if (!evidence.complete) reject();
    if (metadata.nlink > 1) {
      if (!evidence.complete) reject();
      const temporary = evidenceTemporaryPath(lockPath, evidence.bytes);
      if (!temporary) reject();
      let temporaryMetadata;
      try { temporaryMetadata = lstatSync(temporary); } catch { reject(); }
      if (!temporaryMetadata.isFile() || temporaryMetadata.isSymbolicLink()
          || temporaryMetadata.dev !== metadata.dev || temporaryMetadata.ino !== metadata.ino
          || temporaryMetadata.uid !== expectedUid(temporaryMetadata)
          || (temporaryMetadata.mode & 0o777) !== 0o600 || temporaryMetadata.nlink !== metadata.nlink) reject();
      unlinkSync(temporary);
      if (fstatSync(descriptor).nlink !== 1) reject();
    }
  } finally { closeSync(descriptor); }
}

function replaceEvidence(lockPath, value) {
  authenticateReplaceableEvidence(lockPath);
  const temporary = writeTemporaryEvidence(lockPath, value);
  try { renameSync(temporary, lockPath); }
  catch (error) {
    try { unlinkSync(temporary); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") error.cause ??= cleanupError; }
    throw error;
  }
}

function publishEvidence(lockPath, value) {
  try { writeNewEvidence(lockPath, value); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    replaceEvidence(lockPath, value);
  }
}

function startGuardian(descriptor) {
  if (process.platform !== "linux") reject();
  const command = `${FLOCK_PATH} --exclusive --nonblock 3 || exit 73; printf ready; while IFS= read -r line; do :; done`;
  const guardian = spawn("/bin/sh", ["-c", command], {
    stdio: ["pipe", "pipe", "pipe", descriptor],
    env: { PATH: "/usr/bin:/bin", LANG: "C" }
  });
  let stderr = "";
  guardian.stderr.setEncoding("utf8").on("data", chunk => { if (stderr.length < 1024) stderr += chunk; });
  return new Promise((resolve, rejectPromise) => {
    let settled = false;
    let stdout = "";
    const timer = setTimeout(() => finish(new NativeServiceLockError()), ACQUIRE_TIMEOUT_MS);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      guardian.stdout?.removeListener("data", onData);
      guardian.removeListener("error", onError);
      guardian.removeListener("exit", onExit);
      if (error) { guardian.kill(); rejectPromise(error); } else resolve(guardian);
    };
    const onError = () => finish(new NativeServiceLockError());
    const onExit = code => { const error = new NativeServiceLockError(); error.cause = `flock exited ${code}: ${stderr}`; finish(error); };
    const onData = chunk => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 5 || !"ready".startsWith(stdout)) finish(new NativeServiceLockError());
      else if (stdout === "ready") finish();
    };
    guardian.once("error", onError);
    guardian.once("exit", onExit);
    guardian.stdout.on("data", onData);
  });
}

async function stopGuardian(guardian) {
  if (guardian.exitCode !== null || guardian.signalCode !== null) return;
  const exited = new Promise(resolve => guardian.once("exit", resolve));
  guardian.stdin.end();
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), RELEASE_TIMEOUT_MS))
  ]);
  if (!graceful && guardian.exitCode === null && guardian.signalCode === null) {
    guardian.kill("SIGKILL");
    await exited;
  }
}

export async function acquireNativeServiceLock(dataRoot) {
  let rootDescriptor;
  let createdRootIdentity;
  let guardian;
  let guardianStopping = false;
  const guardianDied = () => { if (!guardianStopping) process.exit(74); };
  try {
    if (process.platform !== "linux" || !constants.O_DIRECTORY || !constants.O_NOFOLLOW) reject();
    try {
      accessSync(FLOCK_PATH, constants.X_OK);
      if (!statSync("/proc/self/fd").isDirectory()) reject();
    } catch { reject(); }
    const inheritedUmask = process.umask(0);
    try {
      try {
        mkdirSync(dataRoot, { mode: 0o700 });
        const created = lstatSync(dataRoot);
        createdRootIdentity = { dev: created.dev, ino: created.ino };
      } catch (error) { if (error?.code !== "EEXIST") reject(); }
    } finally { process.umask(inheritedUmask); }
    rootDescriptor = openSync(dataRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (createdRootIdentity) {
      // The synchronous zero-umask mkdir creates the private mode directly.
      // Authenticate the exact created inode before accepting or syncing it.
      const pathMetadata = lstatSync(dataRoot);
      const opened = fstatSync(rootDescriptor);
      if (!pathMetadata.isDirectory() || pathMetadata.isSymbolicLink()
          || pathMetadata.dev !== opened.dev || pathMetadata.ino !== opened.ino
          || opened.dev !== createdRootIdentity.dev || opened.ino !== createdRootIdentity.ino
          || opened.uid !== expectedUid(opened) || (opened.mode & 0o777) !== 0o700) reject();
      fsyncSync(rootDescriptor);
    }
    const identity = validateOpenedRoot(dataRoot, rootDescriptor);
    const mutableRoot = `/proc/self/fd/${rootDescriptor}/`;
    validateDescriptorRoot(mutableRoot, rootDescriptor, identity);
    guardian = await startGuardian(rootDescriptor);
    guardian.once("exit", guardianDied);
    guardian.once("error", guardianDied);
    if (guardian.exitCode !== null || guardian.signalCode !== null) process.exit(74);
    validateOpenedRoot(dataRoot, rootDescriptor);
    validateDescriptorRoot(mutableRoot, rootDescriptor, identity);
    const lockPath = join(mutableRoot, LOCK_NAME);
    publishEvidence(lockPath, { schemaVersion: 1, pid: process.pid, nonce: randomUUID() });
    validateDescriptorRoot(mutableRoot, rootDescriptor, identity);
    return {
      guardianPid: guardian.pid,
      mutableRoot,
      async release() {
        if (guardianStopping) return;
        guardianStopping = true;
        guardian.removeListener("exit", guardianDied);
        guardian.removeListener("error", guardianDied);
        try { await stopGuardian(guardian); }
        finally { closeSync(rootDescriptor); rootDescriptor = undefined; }
      }
    };
  } catch (error) {
    if (guardian) {
      guardianStopping = true;
      guardian.removeListener("exit", guardianDied);
      guardian.removeListener("error", guardianDied);
      try { await stopGuardian(guardian); } catch (stopError) { error.cause ??= stopError; }
    }
    if (rootDescriptor !== undefined) try { closeSync(rootDescriptor); } catch (closeError) { error.cause ??= closeError; }
    if (error instanceof NativeServiceLockError) throw error;
    reject();
  }
}
