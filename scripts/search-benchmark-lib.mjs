import { createHash } from "node:crypto";

export const SEARCH_POLICY_MS = 200;

export function representativeWorkspace({ pageCount = 10_000, blocksPerPage = 10, tableCount = 20, rowsPerTable = 50 } = {}) {
  const timestamp = "2026-08-04T00:00:00.000Z";
  const pages = Array.from({ length: pageCount }, (_, page) => ({
    id: `page-${page}`,
    parentId: null,
    title: `Operations page ${page}`,
    blocks: Array.from({ length: blocksPerPage }, (_, block) => ({
      id: `page-${page}-block-${block}`,
      type: "paragraph",
      text: `Block ${block} on page ${page} contains local knowledge marker-${page}-${block}`
    })),
    createdAt: timestamp,
    updatedAt: timestamp
  }));
  const databases = Array.from({ length: tableCount }, (_, table) => ({
    id: `table-${table}`,
    pageId: `page-${table}`,
    name: `Inspection table ${table}`,
    properties: [
      { id: "asset", name: "Asset", type: "text" },
      { id: "reading", name: "Reading", type: "text" }
    ],
    rows: Array.from({ length: rowsPerTable }, (_, row) => ({
      id: `table-${table}-row-${row}`,
      values: { asset: `Pump ${table}-${row}`, reading: `persisted-cell-${table}-${row}` },
      createdAt: timestamp,
      updatedAt: timestamp
    })),
    views: []
  }));
  return {
    schemaVersion: 2,
    id: "benchmark",
    name: "Representative local workspace",
    pages,
    databases,
    attachments: [],
    linkIndex: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function percentile(samples, percentage) {
  if (!samples.length) throw new Error("At least one timing sample is required");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil((percentage / 100) * sorted.length) - 1];
}

export function summarise(samples, thresholdMs = SEARCH_POLICY_MS) {
  const p50Ms = percentile(samples, 50);
  const p95Ms = percentile(samples, 95);
  return {
    count: samples.length,
    minMs: Math.min(...samples),
    p50Ms,
    p95Ms,
    maxMs: Math.max(...samples),
    thresholdMs,
    passed: p50Ms <= thresholdMs && p95Ms <= thresholdMs
  };
}

export function policyVerdict({ cold, warm, resultChecks }) {
  const failures = [];
  if (!cold.passed) failures.push("cold latency percentile exceeds 200 ms");
  if (!warm.passed) failures.push("warm latency percentile exceeds 200 ms");
  for (const [name, passed] of Object.entries(resultChecks)) if (!passed) failures.push(`${name} result check failed`);
  return { passed: failures.length === 0, failures };
}

export function fixtureFingerprint(workspace) {
  return createHash("sha256").update(JSON.stringify(workspace)).digest("hex");
}
