import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsNativeHelperClient } from "../windows-native-helper.js";

const executable = "C:\\Program Files\\Motion\\Motion.exe";
const ok = (result: unknown) => ({ status: 0, stdout: JSON.stringify({ protocol: 1, ok: true, result }) });

test("Windows native helper sends a versioned bounded request without a shell", () => {
  let calls = 0;
  const invoke = createWindowsNativeHelperClient({ executable: () => executable, run: (file, args, options) => {
    calls++;
    assert.equal(file, executable);
    assert.deepEqual(args, ["--motion-native-helper"]);
    assert.deepEqual(JSON.parse(options.input), { protocol: 1, operation: "backup.inspect", path: "C:\\notes\\backup.json" });
    assert.equal(options.timeout, 30_000);
    assert.equal(options.maxBuffer, 64 * 1024 * 1024);
    assert.equal(options.windowsHide, true);
    assert.equal("shell" in options, false);
    return ok({ exists: false });
  } });
  assert.deepEqual(invoke({ operation: "backup.inspect", path: "C:\\notes\\backup.json" }), { exists: false });
  assert.equal(calls, 1);
});

test("Windows native helper rejects missing, relative, remote, script and traversal executables before execution", () => {
  for (const path of [undefined, "Motion.exe", "\\\\server\\Motion.exe", "C:\\Motion.cmd", "C:\\apps\\..\\Motion.exe", "C:\\Motion.exe\0"]) {
    const invoke = createWindowsNativeHelperClient({ executable: () => path, run: () => { assert.fail("invalid helper was executed"); } });
    assert.throws(() => invoke({ operation: "private.directory", path: "C:\\notes" }), /native filesystem/i);
  }
  const extended = createWindowsNativeHelperClient({ executable: () => "\\\\?\\C:\\Motion\\Motion.exe", run: () => ok(null) });
  assert.equal(extended({ operation: "private.file" }), null);
});

test("Windows native helper rejects unsupported operations and protocol overrides", () => {
  const invoke = createWindowsNativeHelperClient({ executable: () => executable, run: () => { assert.fail("invalid request was executed"); } });
  assert.throws(() => invoke({ operation: "filesystem.delete-anything" }), /request is invalid/i);
  assert.throws(() => invoke({ operation: "attachment.read", protocol: 2 }), /request is invalid/i);
});

test("Windows native helper fails closed on malformed, extra, truncated or unsuccessful success envelopes", () => {
  for (const reply of [
    { status: 0, stdout: "not JSON" },
    { status: 0, stdout: '{"protocol":1,"ok":true' },
    { status: 0, stdout: JSON.stringify({ protocol: 2, ok: true, result: {} }) },
    { status: 0, stdout: JSON.stringify({ protocol: 1, ok: true, result: {}, ignored: true }) },
    { status: 0, stdout: JSON.stringify({ protocol: 1, ok: true }) },
    { ...ok({}), status: 1 },
    { ...ok({}), signal: "SIGTERM" },
    { ...ok({}), error: new Error("C:\\secret\\path") }
  ]) {
    const invoke = createWindowsNativeHelperClient({ executable: () => executable, run: () => reply });
    assert.throws(() => invoke({ operation: "attachment.read" }), error => error instanceof Error
      && !error.message.includes("secret") && /native filesystem/i.test(error.message));
  }
});

test("Windows native helper keeps safe error codes and never exposes helper-provided paths", () => {
  const invoke = createWindowsNativeHelperClient({ executable: () => executable, run: () => ({ status: 1,
    stdout: JSON.stringify({ protocol: 1, ok: false, error: { code: "IDENTITY_CHANGED", message: "C:\\private\\workspace was replaced" } }) }) });
  assert.throws(() => invoke({ operation: "attachment.promote" }), error => error instanceof Error
    && (error as NodeJS.ErrnoException).code === "IDENTITY_CHANGED"
    && !error.message.includes("private") && /identity changed/i.test(error.message));
});
