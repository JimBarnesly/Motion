export async function persistBrowserMutation({ snapshot, restore, mutate, touch, save }) {
  const before = snapshot();
  try {
    mutate();
    touch();
    const candidate = snapshot();
    await save(candidate);
    return candidate;
  } catch (error) {
    restore(before);
    throw error;
  }
}
