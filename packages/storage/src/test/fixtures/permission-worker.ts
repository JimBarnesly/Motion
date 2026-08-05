import { chmod, lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContentAddressedAttachmentStore, SqliteWorkspaceStore, ensurePrivateDirectory, hardenPrivateFile } from "../../index.js";

const [root, maskText] = process.argv.slice(2);
if (!root || !maskText) throw new Error("permission-worker requires a root and umask");
process.umask(Number.parseInt(maskText, 8));
const mode = async (path: string) => (await lstat(path)).mode & 0o777;

await mkdir(root, { recursive: true, mode: 0o777 });
await chmod(root, 0o777);
ensurePrivateDirectory(root);
const databasePath = join(root, "motion.sqlite3");
const store = new SqliteWorkspaceStore(databasePath);
store.save("workspace", 1, { title: "private" }, 0);

const attachmentsRoot = join(root, "attachments");
const attachments = new ContentAddressedAttachmentStore(attachmentsRoot);
const stored = await attachments.put(new TextEncoder().encode("private attachment"));
await chmod(databasePath, 0o666);
await chmod(attachmentsRoot, 0o777);
await chmod(join(attachmentsRoot, ".staging"), 0o777);
await chmod(join(attachmentsRoot, stored.sha256.slice(0, 2)), 0o777);
await chmod(stored.path, 0o666);
store.save("workspace", 1, { title: "tightened" }, 1);
await attachments.get(stored.sha256);
const staged = await attachments.stage(new TextEncoder().encode("restore staging"));
await attachments.promote(staged);

const targetFile = join(root, "symlink-target-file");
const linkedFile = join(root, "linked-private-file");
await writeFile(targetFile, "target", { mode: 0o666 }); await chmod(targetFile, 0o666); await symlink(targetFile, linkedFile);
let fileSymlinkRejected = false;
try { hardenPrivateFile(linkedFile); } catch { fileSymlinkRejected = true; }
const targetDirectory = join(root, "symlink-target-directory");
const linkedDirectory = join(root, "linked-private-directory");
await mkdir(targetDirectory, { mode: 0o777 }); await chmod(targetDirectory, 0o777); await symlink(targetDirectory, linkedDirectory);
let directorySymlinkRejected = false;
try { ensurePrivateDirectory(linkedDirectory); } catch { directorySymlinkRejected = true; }

const databaseFiles: Record<string, number> = {};
for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
  try { databaseFiles[path.slice(root.length + 1)] = await mode(path); } catch { /* optional SQLite sidecar */ }
}
const result = {
  root: await mode(root), attachmentsRoot: await mode(attachmentsRoot), staging: await mode(join(attachmentsRoot, ".staging")),
  bucket: await mode(join(attachmentsRoot, stored.sha256.slice(0, 2))), attachment: await mode(stored.path), databaseFiles,
  fileSymlinkRejected, directorySymlinkRejected, targetFile: await mode(targetFile), targetDirectory: await mode(targetDirectory)
};
store.close();
process.stdout.write(JSON.stringify(result));
