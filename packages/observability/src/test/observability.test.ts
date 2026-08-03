import assert from "node:assert/strict";
import test from "node:test";
import { buildSupportBundle, LocalLogger, LocalPerformanceTracer, previewSupportBundle, serializeCrashReport } from "../index.js";

test("logger filters levels, bounds records, and redacts content and secrets", () => {
  const logger = new LocalLogger({ level: "info", capacity: 2, now: () => new Date("2026-08-04T00:00:00Z") });
  logger.debug("ignored", { value: 1 });
  logger.info("first", { documentText: "private prose", nested: { apiKey: "abc" } });
  logger.warn("second", { message: "token=top-secret" });
  logger.error("third", { safe: "visible" });
  const records = logger.list();
  assert.deepEqual(records.map((record) => record.event), ["second", "third"]);
  assert.equal((records[0]?.context.message), "[REDACTED]");
  logger.clear();
  logger.info("redaction", { pageBody: "private", password: "secret" });
  assert.deepEqual(logger.list()[0]?.context, { pageBody: "[REDACTED]", password: "[REDACTED]" });
});

test("support bundle is explicitly previewable and contains no transport", () => {
  const logger = new LocalLogger(); logger.info("ready");
  const input = { appVersion: "0.1.0", generatedAt: new Date("2026-08-04T00:00:00Z"), logs: logger.list(), database: { integrity: "ok" as const, schemaVersion: 1, migrationState: "idle" as const, issues: [] } };
  const preview = previewSupportBundle(input);
  assert.deepEqual(preview.files.map((file) => file.path), ["logs.json", "diagnostics/database.json"]);
  assert.ok(preview.exclusions.includes("network transmission"));
  const bundle = buildSupportBundle(input);
  assert.deepEqual(Object.keys(bundle.files), ["manifest.json", "logs.json", "diagnostics/database.json"]);
});

test("crashes are serialised with redaction and spans require explicit enablement", () => {
  const crash = serializeCrashReport(new Error("token=secret"), { applicationVersion: "0.1.0", platform: "linux", context: { documentContent: "private" }, occurredAt: new Date("2026-08-04T00:00:00Z") });
  assert.doesNotMatch(crash, /secret|private/);
  const disabled = new LocalPerformanceTracer(false);
  assert.equal(disabled.start("load")(), undefined);
  let tick = 10;
  const enabled = new LocalPerformanceTracer(true, 2, () => (tick += 5), () => new Date("2026-08-04T00:00:00Z"));
  const finish = enabled.start("load", { token: "hidden", route: "/home" });
  const span = finish();
  assert.equal(span?.durationMs, 5);
  assert.deepEqual(span?.attributes, { token: "[REDACTED]", route: "/home" });
});
