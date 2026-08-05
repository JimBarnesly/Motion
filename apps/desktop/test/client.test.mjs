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

test("desktop capability and CSP expose no generic local or remote capability", async () => {
  const { readFile } = await import("node:fs/promises");
  const capability = JSON.parse(await readFile(new URL("../src-tauri/capabilities/main-window.json", import.meta.url), "utf8"));
  const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.deepEqual(capability.windows, ["main"]);
  assert.deepEqual(capability.permissions, []);
  assert.deepEqual(config.app.security.capabilities, ["main-window"]);
  assert.match(config.app.security.csp, /connect-src 'none'/);
  assert.doesNotMatch(JSON.stringify({ capability, config }), /(?:shell|filesystem|dialog|opener|http):(?:allow|default)|https?:\/\/\*/i);
});

test("native boundary rejects unauthorized command and path fields before service dispatch", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(source, /IPC operation is not allowed on this lane/);
  assert.match(source, /IPC payload contains an unsupported field/);
  assert.match(source, /"shell\.execute"/);
  assert.match(source, /"path": "\/etc\/passwd"/);
});
