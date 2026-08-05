import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { connect } from "node:net";
import test from "node:test";

async function start(environment = {}) {
  const child = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: new URL("..", import.meta.url), env: { ...process.env, HOST: "127.0.0.1", PORT: "0", ...environment }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const deadline = Date.now() + 5_000;
  while (!/listening on/.test(stdout) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const port = Number(stdout.match(/:(\d+)\s*$/)?.[1]);
  return { child, port, output: () => `${stdout}${stderr}` };
}
const stop = async child => { if (child.exitCode === null) child.kill("SIGTERM"); await new Promise(resolve => child.exitCode === null ? child.once("exit", resolve) : resolve()); };
const fetch = (port, headers = {}, path = "/index.html") => new Promise((resolve, reject) => { const call = request({ hostname: "127.0.0.1", port, path, headers }, response => { let body = ""; response.on("data", chunk => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body })); }); call.on("error", reject); call.end(); });

test("server binds only loopback and rejects hostile authority, origin, upgrades, and disclosure", async () => {
  const runtime = await start();
  try {
    assert.ok(runtime.port > 0, runtime.output());
    const valid = await fetch(runtime.port, { Host: `127.0.0.1:${runtime.port}` });
    assert.equal(valid.status, 200); assert.match(valid.headers["content-security-policy"], /connect-src 'none'/);
    assert.equal((await fetch(runtime.port, { Host: `evil.invalid:${runtime.port}` })).status, 403);
    assert.equal((await fetch(runtime.port, { Host: `127.0.0.1:${runtime.port}`, Origin: ["https:", "/", "/", "evil", ".", "invalid"].join("") })).status, 403);
    const missing = await fetch(runtime.port, { Host: `127.0.0.1:${runtime.port}` }, "/diagnostics");
    assert.equal(missing.status, 404); assert.equal(missing.body, "Not found"); assert.equal(/[/\\](?:home|Users|tmp)[/\\]/.test(missing.body), false);
    const upgrade = await new Promise((resolve, reject) => { const socket = connect(runtime.port, "127.0.0.1", () => socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${runtime.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`)); let reply = ""; socket.on("data", chunk => { reply += chunk; }); socket.on("end", () => resolve(reply)); socket.on("error", reject); });
    assert.match(upgrade, /^HTTP\/1\.1 426/);
  } finally { await stop(runtime.child); }
});

test("non-loopback configuration fails before listening", async () => {
  const runtime = await start({ HOST: "0.0.0.0" });
  await new Promise(resolve => runtime.child.exitCode === null ? runtime.child.once("exit", resolve) : resolve());
  assert.notEqual(runtime.child.exitCode, 0); assert.equal(Number.isFinite(runtime.port), false); assert.match(runtime.output(), /refuses non-loopback binding/);
});
