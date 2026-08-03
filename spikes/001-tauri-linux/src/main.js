const status = document.querySelector("#status");

export async function readRuntimeLabel(invoke = globalThis.__TAURI_INTERNALS__?.invoke) {
  if (!invoke) return "Browser preview: native boundary unavailable";
  return invoke("runtime_label");
}

status.textContent = await readRuntimeLabel();
