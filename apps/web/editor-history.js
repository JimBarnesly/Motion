function activePage(document) {
  return document?.workspace?.pages?.find(page => page.id === document.activePageId);
}

function nonEditorState(document) {
  const copy = structuredClone(document);
  delete copy.revision;
  if (copy.workspace) {
    delete copy.workspace.updatedAt;
    delete copy.workspace.linkIndex;
  }
  const page = activePage(copy);
  if (page) {
    delete page.blocks;
    delete page.updatedAt;
  }
  return copy;
}

export function editorHistoryCommand(current, target) {
  if (!current?.activePageId || current.activePageId !== target?.activePageId) {
    throw new Error("Editor history requires the same active page");
  }
  const targetPage = activePage(target);
  if (!targetPage || !activePage(current)) throw new Error("Editor history page was not found");
  if (JSON.stringify(nonEditorState(current)) !== JSON.stringify(nonEditorState(target))) {
    throw new Error("Editor history can restore only block changes");
  }
  return {
    type: "page.replace-blocks",
    payload: { pageId: targetPage.id, blocks: structuredClone(targetPage.blocks ?? []) }
  };
}

export async function confirmEditorHistory({ current, target, execute }) {
  const inverse = JSON.stringify(current);
  const command = editorHistoryCommand(current, target);
  await execute(command.type, command.payload);
  return inverse;
}
