#!/usr/bin/env node
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { openDirectRegularFile, verifyReleaseStructure } from "./release-structure.mjs";

const readArg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const directory = resolve(readArg("--directory") ?? "artifacts/release");
const expectedCommit = readArg("--commit"); const expectedVersion = readArg("--version"); const expectedRepository = readArg("--repository");
const exactIdentity = readArg("--certificate-identity"); const identityRegexp = readArg("--certificate-identity-regexp");
const issuer = readArg("--certificate-oidc-issuer") ?? "https://token.actions.githubusercontent.com";
const cosign = readArg("--cosign") ?? "cosign"; const gh = readArg("--gh") ?? "gh";
const fail = message => { process.stderr.write(`Release verification failed: ${message}\n`); process.exit(1); };
if (Boolean(exactIdentity) === Boolean(identityRegexp)) fail("exactly one trusted certificate identity or identity regular expression is required");
let structure;
try { structure = await verifyReleaseStructure({ directory, expectedVersion, expectedCommit, expectedRepository, signed: true }); }
catch (error) { fail(error.message); }
const signaturePath = join(directory, "release-manifest.sigstore.json"); const provenancePath = join(directory, "release-provenance.jsonl");
let manifestHandle; let signatureHandle; let provenanceHandle;
try {
  manifestHandle = await openDirectRegularFile(structure.manifestPath, "release manifest");
  signatureHandle = await openDirectRegularFile(signaturePath, "signed manifest bundle");
  provenanceHandle = await openDirectRegularFile(provenancePath, "keyless provenance bundle");
  const manifestState = await manifestHandle.stat();
  if (manifestState.size > 1024 * 1024) throw new Error("release manifest is unreasonably large");
  const manifestBytes = Buffer.alloc(manifestState.size); let offset = 0;
  while (offset < manifestBytes.byteLength) {
    const { bytesRead } = await manifestHandle.read(manifestBytes, offset, manifestBytes.byteLength - offset, offset);
    if (!bytesRead) throw new Error("release manifest changed while being authenticated");
    offset += bytesRead;
  }
  if (createHash("sha256").update(manifestBytes).digest("hex") !== structure.manifestSha256) throw new Error("release manifest changed before trust verification");
} catch (error) { fail(error.message); }
const run = (command, args, label, descriptors) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", ...descriptors.map(handle => handle.fd)] });
  if (result.error || result.status !== 0) fail(`${label} verification failed`);
};
const identityArgs = exactIdentity ? ["--certificate-identity", exactIdentity] : ["--certificate-identity-regexp", identityRegexp];
try {
  run(cosign, ["verify-blob", "--bundle", "/proc/self/fd/4", ...identityArgs, "--certificate-oidc-issuer", issuer, "/proc/self/fd/3"], "manifest signature", [manifestHandle, signatureHandle]);
  for (const name of structure.names) run(gh, ["attestation", "verify", join(directory, name), "--repo", structure.manifest.repository, "--bundle", "/proc/self/fd/3"], `provenance for ${name}`, [provenanceHandle]);
} finally { await Promise.all([manifestHandle.close(), signatureHandle.close(), provenanceHandle.close()]); }
process.stdout.write(`Verified four Motion ${expectedVersion} release artifacts for commit ${expectedCommit}.\n`);
