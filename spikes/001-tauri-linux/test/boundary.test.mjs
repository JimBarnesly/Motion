import assert from "node:assert/strict";
import test from "node:test";

globalThis.document = { querySelector: () => ({ textContent: "" }) };
const { readRuntimeLabel } = await import("../src/main.js");

test("browser preview remains usable without the native bridge", async () => {
  assert.equal(await readRuntimeLabel(undefined), "Browser preview: native boundary unavailable");
});

test("UI calls a narrow native command boundary", async () => {
  const calls = [];
  const result = await readRuntimeLabel(async (command) => {
    calls.push(command);
    return "Tauri 2 native boundary active";
  });
  assert.equal(result, "Tauri 2 native boundary active");
  assert.deepEqual(calls, ["runtime_label"]);
});
