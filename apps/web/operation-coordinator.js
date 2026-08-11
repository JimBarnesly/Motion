export function createOperationCoordinator() {
  let canonicalOperation = null;
  let editActive = false;

  const snapshot = () => ({ canonicalOperation, editActive });

  function beginEdit() {
    if (canonicalOperation || editActive) return false;
    editActive = true;
    return true;
  }

  function endEdit() {
    editActive = false;
  }

  async function runCanonical(name, operation) {
    if (canonicalOperation || editActive) return { started: false };
    canonicalOperation = name;
    try {
      return { started: true, value: await operation() };
    } finally {
      canonicalOperation = null;
    }
  }

  return { snapshot, beginEdit, endEdit, runCanonical };
}
