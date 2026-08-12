import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, root] = process.argv.slice(2);
const lockPath = join(root, ".motion-service.lock");
const value = { schemaVersion: 1, pid: process.pid, nonce: randomUUID() };

if (mode === "after-link") {
  const temporary = `${lockPath}.${value.nonce}.tmp`;
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  linkSync(temporary, lockPath);
} else if (mode === "after-truncate") {
  const descriptor = openSync(lockPath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  closeSync(descriptor);
} else {
  throw new Error("unknown crash mode");
}

process.kill(process.pid, "SIGKILL");
