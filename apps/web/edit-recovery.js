const publicPending = pending => ({
  status: pending.status,
  saved: false,
  blocked: true,
  key: pending.key,
  label: pending.label,
  candidate: structuredClone(pending.candidate),
  target: structuredClone(pending.target)
});

/**
 * Owns the lifecycle of one canonical edit confirmation without owning the
 * application's confirmed data. Native failures deliberately never enter the
 * public state returned to the UI.
 */
export function createEditRecoveryController({ confirm, onChange = () => {}, acquireEdit = () => true, releaseEdit = () => {} }) {
  if (typeof confirm !== "function") throw new TypeError("confirm must be a function");
  let pending = null;
  let generation = 0;
  let saved = false;
  let inFlightCommit = null;

  const snapshot = () => pending
    ? publicPending(pending)
    : { status: "idle", saved, blocked: false };
  const changed = () => onChange(snapshot());

  function update(edit) {
    if (!edit || typeof edit.key !== "string" || typeof edit.label !== "string") throw new TypeError("edit requires key and label");
    if (pending && pending.key !== edit.key) return false;
    if (!pending && !acquireEdit()) return false;
    const wasSaving = pending?.status === "saving";
    pending = {
      key: edit.key,
      label: edit.label,
      candidate: structuredClone(edit.candidate),
      target: structuredClone(edit.target),
      generation: ++generation,
      status: wasSaving ? "saving" : pending?.status === "failed" ? "failed" : "editing"
    };
    saved = false;
    changed();
    return true;
  }

  function commit() {
    if (!pending) return Promise.resolve(false);
    if (pending.status === "saving") return inFlightCommit ?? Promise.resolve(false);
    const current = pending;
    const attempt = {
      key: current.key,
      label: current.label,
      candidate: structuredClone(current.candidate),
      target: structuredClone(current.target)
    };
    const attemptGeneration = current.generation;
    current.status = "saving";
    changed();
    const operation = (async () => {
      try {
        await confirm(attempt);
        if (!pending) return true;
        if (pending.generation !== attemptGeneration) {
          pending.status = "editing";
          changed();
          return true;
        }
        pending = null;
        saved = true;
        releaseEdit();
        changed();
        return true;
      } catch {
        if (pending) {
          pending.status = "failed";
          saved = false;
          changed();
        }
        return false;
      }
    })();
    inFlightCommit = operation;
    void operation.then(() => { if (inFlightCommit === operation) inFlightCommit = null; });
    return operation;
  }

  function retry() {
    if (!pending || pending.status === "saving") return Promise.resolve(false);
    pending.status = "editing";
    changed();
    return commit();
  }

  function discard() {
    if (!pending || pending.status === "saving") return false;
    const discarded = {
      candidate: structuredClone(pending.candidate),
      target: structuredClone(pending.target),
      label: pending.label
    };
    pending = null;
    saved = false;
    releaseEdit();
    changed();
    return discarded;
  }

  return { snapshot, update, commit, retry, discard };
}
