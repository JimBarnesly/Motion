import { lstat, open as filesystemOpen, readFile, readdir, rename } from "node:fs/promises";

let applied = false;
export { lstat, readFile, readdir };
export async function open(path, ...args) {
  const plan = process.env.MOTION_RELEASE_RACE_PLAN ? JSON.parse(process.env.MOTION_RELEASE_RACE_PLAN) : null;
  if (!applied && plan?.target === String(path)) {
    applied = true;
    await rename(path, plan.originalEvidence);
    try { await rename(plan.replacement, path); }
    catch (error) {
      await rename(plan.originalEvidence, path);
      throw error;
    }
  }
  return filesystemOpen(path, ...args);
}
