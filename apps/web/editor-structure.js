export function markdownShortcutCommand({ pageId, block }) {
  if (block?.type !== "paragraph") return null;
  if (block.text === "---" && (block.children?.length ?? 0) > 0) return null;
  const transform = new Map([
    ["# ", { type: "heading-1" }],
    ["## ", { type: "heading-2" }],
    ["### ", { type: "heading-3" }],
    ["- ", { type: "bulleted-list" }],
    ["1. ", { type: "numbered-list" }],
    ["[] ", { type: "task", checked: false }],
    ["[ ] ", { type: "task", checked: false }],
    ["> ", { type: "quote" }],
    ["``` ", { type: "code" }],
    ["---", { type: "divider" }]
  ]).get(block.text);
  if (!transform) return null;
  return {
    type: "block.batch",
    commands: [
      { type: "block.transform", pageId, blockId: block.id, transform },
      { type: "block.update-content", pageId, blockId: block.id, content: { text: "", references: [] } }
    ]
  };
}

export function mergeAdjacentBlockCommands({ pageId, previousBlock, currentBlock }) {
  const mergeable = new Set(["paragraph", "heading-1", "heading-2", "heading-3", "bulleted-list", "numbered-list", "task", "quote", "code"]);
  if (!mergeable.has(previousBlock?.type) || !mergeable.has(currentBlock?.type)) return null;
  if (previousBlock.unknownData !== undefined || currentBlock.unknownData !== undefined) return null;
  if ((previousBlock.children?.length ?? 0) || (currentBlock.children?.length ?? 0)) return null;
  const previousText = String(previousBlock.text ?? "");
  const currentText = String(currentBlock.text ?? "");
  const references = [
    ...(previousBlock.references ?? []).map(reference => structuredClone(reference)),
    ...(currentBlock.references ?? []).map(reference => reference.start === undefined || reference.end === undefined
      ? structuredClone(reference)
      : { ...structuredClone(reference), start: reference.start + previousText.length, end: reference.end + previousText.length })
  ];
  return {
    commands: [
      {
        type: "block.update-content",
        pageId,
        blockId: previousBlock.id,
        content: { text: previousText + currentText, references }
      },
      { type: "block.delete", pageId, blockId: currentBlock.id }
    ],
    focusBlockId: previousBlock.id,
    focusOffset: previousText.length
  };
}

export function splitBlockCommands({ pageId, block, offset, beforeBlockId = null, createId }) {
  const text = String(block.text ?? "");
  if (block.type === "code") {
    return {
      commands: [{
        type: "block.update-content",
        pageId,
        blockId: block.id,
        content: { text: `${text.slice(0, offset)}\n${text.slice(offset)}`, references: [] }
      }],
      focusBlockId: block.id,
      focusOffset: offset + 1
    };
  }
  if (offset === 0 && text.length === 0 && ["bulleted-list", "numbered-list", "task"].includes(block.type)) {
    return {
      commands: [
        { type: "block.transform", pageId, blockId: block.id, transform: { type: "paragraph" } }
      ],
      focusBlockId: block.id,
      focusOffset: 0
    };
  }
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
  const nextType = block.type === "divider" || (["heading-1", "heading-2", "heading-3"].includes(block.type) && offset === text.length)
    ? "paragraph"
    : block.type;
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
