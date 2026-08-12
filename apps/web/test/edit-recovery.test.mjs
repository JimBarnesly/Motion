import assert from "node:assert/strict";
import test from "node:test";

import { createEditRecoveryController } from "../edit-recovery.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function edit(candidate = "candidate") {
  return { key: "page:title:page-1", label: "Page title", candidate, target: { kind: "page-title", pageId: "page-1" } };
}

test("failed canonical confirmation retains the exact candidate as visibly unsaved", async () => {
  const attempts = [];
  const controller = createEditRecoveryController({
    confirm: async pending => { attempts.push(pending.candidate); throw new Error("SQLITE_IOERR /private/workspace.db secret-canary"); }
  });

  controller.update(edit("  Māori 😀 <tag>\n\tsecond line  "));
  assert.equal(controller.snapshot().status, "editing");
  assert.equal(controller.snapshot().saved, false);

  assert.equal(await controller.commit(), false);
  assert.deepEqual(attempts, ["  Māori 😀 <tag>\n\tsecond line  "]);
  assert.deepEqual(controller.snapshot(), {
    status: "failed",
    saved: false,
    blocked: true,
    key: "page:title:page-1",
    label: "Page title",
    candidate: "  Māori 😀 <tag>\n\tsecond line  ",
    target: { kind: "page-title", pageId: "page-1" }
  });
  assert.equal("error" in controller.snapshot(), false, "native details must not enter presentation state");
});

test("retry confirms the same candidate and only then clears the unresolved edit", async () => {
  const attempts = [];
  const controller = createEditRecoveryController({
    confirm: async pending => {
      attempts.push(pending.candidate);
      if (attempts.length === 1) throw new Error("native path must stay private");
    }
  });
  controller.update(edit("exact candidate"));
  assert.equal(await controller.commit(), false);
  assert.equal(controller.snapshot().saved, false);

  assert.equal(await controller.retry(), true);
  assert.deepEqual(attempts, ["exact candidate", "exact candidate"]);
  assert.deepEqual(controller.snapshot(), { status: "idle", saved: true, blocked: false });
});

test("discard clears the unresolved candidate without changing confirmed application state", async () => {
  const confirmed = { title: "Durable title" };
  const controller = createEditRecoveryController({ confirm: async () => { throw new Error("failure"); } });
  const target = edit("Unsaved title").target;
  controller.update(edit("Unsaved title"));
  await controller.commit();

  assert.deepEqual(controller.discard(), { candidate: "Unsaved title", target, label: "Page title" });
  assert.equal(confirmed.title, "Durable title");
  assert.deepEqual(controller.snapshot(), { status: "idle", saved: false, blocked: false });
});

test("a stale save completion cannot clear or overwrite a newer candidate", async () => {
  const first = deferred();
  const attempts = [];
  const controller = createEditRecoveryController({
    confirm: pending => { attempts.push(pending.candidate); return attempts.length === 1 ? first.promise : Promise.resolve(); }
  });
  controller.update(edit("first"));
  const saving = controller.commit();
  controller.update(edit("newer exact candidate"));
  first.resolve();

  assert.equal(await saving, true);
  assert.deepEqual(controller.snapshot(), {
    status: "editing",
    saved: false,
    blocked: true,
    key: "page:title:page-1",
    label: "Page title",
    candidate: "newer exact candidate",
    target: { kind: "page-title", pageId: "page-1" }
  });
  assert.equal(await controller.commit(), true);
  assert.deepEqual(attempts, ["first", "newer exact candidate"]);
  assert.deepEqual(controller.snapshot(), { status: "idle", saved: true, blocked: false });
});

test("a different edit is rejected while an unresolved candidate exists", () => {
  const controller = createEditRecoveryController({ confirm: async () => {} });
  controller.update(edit("pending"));
  assert.equal(controller.update({ ...edit("other"), key: "block:text:block-1" }), false);
  assert.equal(controller.snapshot().candidate, "pending");
});

test("an edit rejected by a canonical operation never enters recovery state", () => {
  const controller = createEditRecoveryController({ confirm: async () => {}, acquireEdit: () => false });

  assert.equal(controller.update(edit("must not leak")), false);
  assert.deepEqual(controller.snapshot(), { status: "idle", saved: false, blocked: false });
});

test("the edit lease spans failure and retry and releases only after resolution", async () => {
  let releases = 0;
  let attempts = 0;
  const controller = createEditRecoveryController({
    confirm: async () => { if (++attempts === 1) throw new Error("failure"); },
    acquireEdit: () => true,
    releaseEdit: () => { releases += 1; }
  });

  assert.equal(controller.update(edit("exact candidate")), true);
  assert.equal(await controller.commit(), false);
  assert.equal(releases, 0);
  assert.equal(await controller.retry(), true);
  assert.equal(releases, 1);

  assert.equal(controller.update(edit("discard me")), true);
  controller.discard();
  assert.equal(releases, 2);
});

test("a keyboard action can join the in-flight canonical save before continuing", async () => {
  const saving = deferred();
  const controller = createEditRecoveryController({ confirm: () => saving.promise });
  controller.update(edit("draft before Enter"));

  const debounceCommit = controller.commit();
  const keyboardCommit = controller.commit();
  saving.resolve();

  assert.equal(await debounceCommit, true);
  assert.equal(await keyboardCommit, true);
  assert.deepEqual(controller.snapshot(), { status: "idle", saved: true, blocked: false });
});
