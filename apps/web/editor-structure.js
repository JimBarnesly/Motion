export function splitBlockCommands({ pageId, block, offset, beforeBlockId = null, createId }) {
  const text = String(block.text ?? "");
  const nextBlockId = createId();
  const beforeReferences = [], afterReferences = [];
  const mentions = [...text.matchAll(/\[\[([^\]]+)\]\]/g)];
  (block.references ?? []).forEach((reference, index) => {
    const explicit = reference.start !== undefined && reference.end !== undefined;
    const start = reference.start ?? mentions[index]?.index;
    const end = reference.end ?? (start === undefined ? undefined : start + mentions[index][0].length);
    if (start !== undefined && end !== undefined && end <= offset) {
      beforeReferences.push(explicit ? structuredClone(reference) : { pageId: reference.pageId });
    } else if (start !== undefined && end !== undefined && start >= offset) {
      afterReferences.push(explicit
        ? { ...structuredClone(reference), start: start - offset, end: end - offset }
        : { pageId: reference.pageId });
    }
  });
  const nextType = block.type === "divider" ? "paragraph" : block.type;
  const nextBlock = {
    id: nextBlockId,
    type: nextType,
    text: text.slice(offset),
    ...(nextType === "task" ? { checked: false } : {}),
    ...(nextType === "code" && block.language ? { language: block.language } : {}),
    children: []
  };
  if (afterReferences.length) nextBlock.references = afterReferences;
  return {
    commands: [
      {
        type: "block.update-content",
        pageId,
        blockId: block.id,
        content: { text: text.slice(0, offset), references: beforeReferences }
      },
      {
        type: "block.create",
        pageId,
        position: { parentBlockId: null, beforeBlockId },
        block: nextBlock
      }
    ],
    focusBlockId: nextBlockId
  };
}
