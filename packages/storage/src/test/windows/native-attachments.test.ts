import assert from "node:assert/strict";
import { before, test } from "node:test";
import { access, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentAddressedAttachmentStore, ensurePrivateDirectory, invokeWindowsNativeHelper } from "../../index.js";

before(async () => {
  assert.equal(process.platform, "win32", "This is actual Windows filesystem acceptance; another OS must not report a pass");
  assert.ok(process.env.MOTION_NATIVE_HELPER, "MOTION_NATIVE_HELPER must point to the built or installed Motion executable");
  await access(process.env.MOTION_NATIVE_HELPER!);
});

async function fixture(run: (container: string, root: string, store: ContentAddressedAttachmentStore) => Promise<void>) {
  const container = await mkdtemp(join(tmpdir(), "motion-native-storage-"));
  const root = join(container, "attachments");
  try { await run(container, root, new ContentAddressedAttachmentStore(root)); }
  finally { await rm(container, { recursive: true, force: true }); }
}

test("Windows native attachments publish immutable bytes, deduplicate and survive reopening", async () => {
  await fixture(async (_container, root, store) => {
    const bytes = Buffer.from("Windows native attachment — offline restart");
    const first = await store.put(bytes);
    const reopened = new ContentAddressedAttachmentStore(root);
    const copies = await Promise.all(Array.from({ length: 8 }, () => reopened.put(bytes)));
    assert.equal(first.newlyCreated, true);
    assert.ok(copies.every(copy => copy.path === first.path && copy.newlyCreated === false));
    assert.deepEqual(Buffer.from(await reopened.get(first.sha256)), bytes);
    assert.equal((await stat(first.path)).nlink, 1);
    assert.deepEqual(await readdir(join(root, ".staging")), []);
  });
});

test("Windows native attachments enforce the 3 MiB boundary and detect corrupt published bytes", async () => {
  await fixture(async (_container, root, store) => {
    const boundary = await store.put(new Uint8Array(3 * 1024 * 1024));
    assert.equal((await store.get(boundary.sha256)).byteLength, 3 * 1024 * 1024);
    await assert.rejects(store.stage(new Uint8Array(3 * 1024 * 1024 + 1)), /3 MiB/);
    assert.deepEqual(await readdir(join(root, ".staging")), []);
    const stored = await store.put(Buffer.from("trusted published attachment"));
    await writeFile(stored.path, "changed bytes");
    await assert.rejects(store.get(stored.sha256), error => (error as NodeJS.ErrnoException).code === "INTEGRITY");
    const report = await store.recover([stored.sha256]);
    assert.ok(report.corruptBlobs.includes(stored.sha256));
    assert.ok(report.missingReferenced.includes(stored.sha256));
    assert.equal(await readFile(stored.path, "utf8"), "changed bytes", "recovery must not delete final corrupt blobs");
  });
});

test("Windows native publication refuses a replaced staging pathname and retains the authenticated original", async () => {
  await fixture(async (_container, root, store) => {
    const bytes = Buffer.from("authenticated staged bytes"), capability = await store.stage(bytes);
    const replacement = await store.stage(Buffer.from("pathname substitution"));
    const staging = join(root, ".staging"), names = await readdir(staging);
    const name = names.find(value => value.startsWith(`${capability.sha256}.`))!;
    const replacementName = names.find(value => value.startsWith(`${replacement.sha256}.`))!;
    const original = join(staging, `${name}.original`);
    await rename(join(staging, name), original);
    await rename(join(staging, replacementName), join(staging, name));
    await assert.rejects(store.promote(capability), error => (error as NodeJS.ErrnoException).code === "IDENTITY_CHANGED");
    assert.deepEqual(await readFile(original), bytes);
    assert.equal(await readFile(join(staging, name), "utf8"), "pathname substitution");
    await assert.rejects(access(capability.path));
  });
});

test("Windows native reads reject externally hardlinked blobs without changing either name", async () => {
  await fixture(async (container, _root, store) => {
    const bytes = Buffer.from("private inode must have one name"), stored = await store.put(bytes);
    const outside = join(container, "external-copy.txt");
    await link(stored.path, outside);
    await assert.rejects(store.get(stored.sha256));
    await assert.rejects(store.put(bytes));
    assert.deepEqual(await readFile(outside), bytes);
    assert.deepEqual(await readFile(stored.path), bytes);
    assert.equal((await stat(stored.path)).nlink, 2);
  });
});

test("Windows native staging rejects a junction and an identity-replaced root", async () => {
  await fixture(async (container, root, store) => {
    const staging = join(root, ".staging"), saved = join(root, ".original-staging"), outside = join(container, "outside");
    await mkdir(outside);
    await rename(staging, saved);
    await symlink(outside, staging, "junction");
    await assert.rejects(store.stage(Buffer.from("must not escape")));
    assert.deepEqual(await readdir(outside), []);
    await rm(staging, { force: true });
    await rename(saved, staging);
    await rename(root, join(container, "original-attachments"));
    ensurePrivateDirectory(root);
    await assert.rejects(store.stage(Buffer.from("must not enter replaced root")), error => (error as NodeJS.ErrnoException).code === "IDENTITY_CHANGED");
  });
});

test("Windows native recovery finishes interrupted link publication and removes only abandoned staging", async () => {
  await fixture(async (_container, root, store) => {
    const committed = await store.stage(Buffer.from("metadata committed"));
    const interrupted = await store.stage(Buffer.from("linked before process exit"));
    await store.stage(Buffer.from("abandoned uncommitted bytes"));
    const staging = join(root, ".staging");
    const interruptedName = (await readdir(staging)).find(name => name.startsWith(`${interrupted.sha256}.`))!;
    ensurePrivateDirectory(join(root, interrupted.sha256.slice(0, 2)));
    await link(join(staging, interruptedName), interrupted.path);
    assert.equal((await stat(interrupted.path)).nlink, 2);
    const reopened = new ContentAddressedAttachmentStore(root);
    const report = await reopened.recover([committed.sha256, interrupted.sha256]);
    assert.deepEqual(report.promoted.sort(), [committed.sha256, interrupted.sha256].sort());
    assert.deepEqual(report.missingReferenced, []);
    assert.equal(report.removedStaging.length, 1);
    assert.deepEqual(await readdir(staging), []);
    assert.equal((await stat(interrupted.path)).nlink, 1);
    assert.equal(Buffer.from(await reopened.get(interrupted.sha256)).toString(), "linked before process exit");
  });
});

test("Windows helper rejects forged traversal receipts before filesystem mutation", async () => {
  await fixture(async (_container, root, _store) => {
    const identities = invokeWindowsNativeHelper<{ rootIdentity: string; stagingIdentity: string }>({ operation: "attachment.initialize", root });
    assert.throws(() => invokeWindowsNativeHelper({ operation: "attachment.discard", root,
      expectedRootIdentity: identities.rootIdentity, expectedStagingIdentity: identities.stagingIdentity,
      receipt: { stagingName: "../../outside.txt", fileIdentity: "f".repeat(64), sha256: "a".repeat(64), byteLength: 1 } }),
    error => (error as NodeJS.ErrnoException).code === "INVALID_INPUT");
    assert.deepEqual(await readdir(join(root, ".staging")), []);
  });
});
