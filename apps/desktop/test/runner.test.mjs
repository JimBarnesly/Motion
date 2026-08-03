import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

test("one service process handles errors and multiple durable requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-desktop-runner-"));
  const child = spawn(process.execPath, [new URL("../dist/service-bundle.mjs", import.meta.url).pathname, root], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = [];
  lines.on("line", line => replies.push(JSON.parse(line)));
  const send = request => child.stdin.write(`${JSON.stringify(request)}\n`);
  const waitFor = async count => {
    const deadline = Date.now() + 5_000;
    while (replies.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(replies.length, count);
    return replies[count - 1];
  };
  try {
    const pid = child.pid;
    send({ lane: "unsupported", payload: {} });
    assert.equal((await waitFor(1)).error.code, "INVALID_INPUT");
    send({ lane: "ui-save", payload: { schemaVersion: 1, document: { schemaVersion: 1, pages: [{ id: "page-1", parentId: null, order: 0, type: "document", title: "Durable", blocks: [{ id: "block-1", type: "paragraph", text: "same process" }] }], activePageId: "page-1" } } });
    assert.equal((await waitFor(2)).value.saved, true);
    send({ lane: "ui-load", payload: { schemaVersion: 1 } });
    const loaded = await waitFor(3);
    assert.equal(loaded.value.pages[0].blocks[0].text, "same process");
    assert.equal(child.pid, pid);
    assert.equal(child.exitCode, null);
  } finally {
    child.stdin.end();
    await new Promise(resolve => child.once("exit", resolve));
    await rm(root, { recursive: true });
  }
});
