import assert from "node:assert/strict";
import test from "node:test";

import { createOperationCoordinator } from "../operation-coordinator.js";

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

test("canonical operation excludes edits for its complete asynchronous duration", async () => {
  const coordinator = createOperationCoordinator();
  const gate = deferred();
  const running = coordinator.runCanonical("restore", async () => {
    assert.equal(coordinator.beginEdit(), false);
    await gate.promise;
    assert.equal(coordinator.beginEdit(), false);
    return "restored";
  });

  assert.deepEqual(coordinator.snapshot(), { canonicalOperation: "restore", editActive: false });
  gate.resolve();
  assert.deepEqual(await running, { started: true, value: "restored" });
  assert.equal(coordinator.beginEdit(), true);
});

test("an active edit prevents canonical reads and restores from starting", async () => {
  const coordinator = createOperationCoordinator();
  let calls = 0;
  assert.equal(coordinator.beginEdit(), true);

  assert.deepEqual(await coordinator.runCanonical("export", async () => { calls += 1; }), { started: false });
  assert.deepEqual(await coordinator.runCanonical("restore", async () => { calls += 1; }), { started: false });
  assert.equal(calls, 0);

  coordinator.endEdit();
  assert.deepEqual(await coordinator.runCanonical("export", async () => { calls += 1; return 1; }), { started: true, value: 1 });
  assert.equal(calls, 1);
});

test("canonical lease is released when an operation throws", async () => {
  const coordinator = createOperationCoordinator();
  await assert.rejects(coordinator.runCanonical("backup", async () => { throw new Error("failed"); }), /failed/);
  assert.equal(coordinator.beginEdit(), true);
});
