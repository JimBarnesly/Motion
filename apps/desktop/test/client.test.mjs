import assert from "node:assert/strict";
import test from "node:test";
import { createTauriMotionClient } from "../dist-ts/client.js";

test("client exposes only the allowlisted application dispatch command", async () => {
  const calls = [];
  const client = createTauriMotionClient(async (name, args) => { calls.push([name, args]); return []; });
  await client.query({ type: "workspace.list" });
  assert.deepEqual(calls, [["app_dispatch", { request: { protocolVersion: 1, lane: "query", payload: { type: "workspace.list" } } }]]);
});

test("binary content crosses IPC in an explicit byte envelope", async () => {
  let request;
  const client = createTauriMotionClient(async (_name, args) => { request = args.request; return {}; });
  await client.executeAsync({ type: "attachment.put", workspaceId: "w", expectedRevision: 1, fileName: "a", mediaType: "x", sha256: "0".repeat(64), bytes: Uint8Array.of(0, 127, 255) });
  assert.deepEqual(request.payload.bytes, { $motionBytes: [0, 127, 255] });
});

test("desktop shell declares the UI compatibility commands used by the web client", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(source, /motion_ui_load/);
  assert.match(source, /motion_ui_save/);
});
