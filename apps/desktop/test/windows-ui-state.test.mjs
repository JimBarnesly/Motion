import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createWindowsUiStateStore } from "../windows-ui-state.mjs";

const path = resolve("private/ui-state.json");
const identity = "a".repeat(64);
const state = { schemaVersion: 1, workspaceId: "workspace", activePageId: "page", expandedPageIds: ["page"], activeViewIds: {} };

test("Windows UI-state reads authenticated native contents and treats only absence as empty", () => {
  const calls = [];
  const store = createWindowsUiStateStore(path, request => {
    calls.push(request);
    return { exists: true, contents: JSON.stringify(state), identity };
  });
  assert.deepEqual(store.read(), state);
  assert.deepEqual(calls, [{ operation: "backup.inspect", path }]);
  assert.deepEqual(createWindowsUiStateStore(path, () => ({ exists: false })).read(), {});
  assert.throws(() => createWindowsUiStateStore(path, () => ({ exists: true, contents: "{", identity })).read());
  assert.throws(() => createWindowsUiStateStore(path, () => { throw new Error("Access denied"); }).read(), /Access denied/);
});

test("Windows UI-state publishes with no-replace for absence and exact prior identity for updates", () => {
  for (const exists of [false, true]) {
    const calls = [];
    const store = createWindowsUiStateStore(path, request => {
      calls.push(request);
      return request.operation === "backup.inspect"
        ? exists ? { exists: true, contents: "{}", identity } : { exists: false }
        : { byteLength: Buffer.byteLength(request.contents) };
    });
    assert.deepEqual(store.write(state), { path, byteLength: Buffer.byteLength(JSON.stringify(state)) });
    assert.deepEqual(calls, [
      { operation: "backup.inspect", path },
      { operation: "backup.save", path, contents: JSON.stringify(state), ...(exists ? { expectedIdentity: identity } : {}) }
    ]);
  }
});

test("Windows UI-state refuses unauthenticated metadata, changed targets, and incomplete publication replies", () => {
  for (const inspection of [null, { exists: false, contents: "injected" }, { exists: true, contents: "{}", identity: "../../outside" }]) {
    let calls = 0;
    const store = createWindowsUiStateStore(path, () => { calls += 1; return inspection; });
    assert.throws(() => store.write(state), /authenticated/);
    assert.equal(calls, 1, "Invalid inspection must never reach publication");
  }
  const conflict = Object.assign(new Error("Identity changed"), { code: "IDENTITY_CHANGED" });
  const store = createWindowsUiStateStore(path, request => {
    if (request.operation === "backup.inspect") return { exists: true, contents: "{}", identity };
    throw conflict;
  });
  assert.throws(() => store.write(state), error => error === conflict);
  for (const result of [{ byteLength: 1 }, { byteLength: Buffer.byteLength(JSON.stringify(state)), extra: true }]) {
    const incomplete = createWindowsUiStateStore(path, request => request.operation === "backup.inspect" ? { exists: false } : result);
    assert.throws(() => incomplete.write(state), /authenticated/);
  }
});
