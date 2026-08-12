const MAX_BATCH_COMMANDS = 10_000;
const MAX_STRING_LENGTH = 10_000_000;

const lineParsers = [
  [/^(#{1,3})\s+(.+)$/, match => ({ type: `heading-${match[1].length}`, text: match[2] })],
  [/^- \[([ xX])\]\s+(.+)$/, match => ({ type: "task", text: match[2], checked: match[1].toLowerCase() === "x" })],
  [/^>\s?(.*)$/, match => ({ type: "quote", text: match[1] })],
  [/^(?: {0,3})(?:\*\s*){3,}$/, () => ({ type: "divider", text: "" })],
  [/^(?: {0,3})(?:-\s*){3,}$/, () => ({ type: "divider", text: "" })],
  [/^(?: {0,3})(?:_\s*){3,}$/, () => ({ type: "divider", text: "" })],
  [/^[-*+]\s+(.+)$/, match => ({ type: "bulleted-list", text: match[1] })],
  [/^\d+[.)]\s+(.+)$/, match => ({ type: "numbered-list", text: match[1] })]
];

function withReferences(block, resolveReferences) {
  if (block.type === "divider") return block;
  const references = resolveReferences?.(block.text) ?? [];
  return references.length ? { ...block, references } : block;
}

function blockForLine(line, createId, resolveReferences) {
  for (const [pattern, convert] of lineParsers) {
    const match = line.match(pattern);
    if (match) return withReferences({ id: createId(), ...convert(match), children: [] }, resolveReferences);
  }
  return withReferences({ id: createId(), type: "paragraph", text: line, children: [] }, resolveReferences);
}

export function markdownBlocksFromPlainText(text, createId, resolveReferences) {
  const lines = String(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const fence = lines[index].match(/^```([^`]*)$/);
    if (!fence) {
      blocks.push(blockForLine(lines[index], createId, resolveReferences));
      continue;
    }
    const body = [];
    index += 1;
    while (index < lines.length && lines[index] !== "```") {
      body.push(lines[index]);
      index += 1;
    }
    blocks.push(withReferences({
      id: createId(),
      type: "code",
      text: body.join("\n"),
      ...(fence[1].trim() ? { language: fence[1].trim() } : {}),
      children: []
    }, resolveReferences));
  }
  return blocks;
}

function transformFor(block) {
  const { type } = block;
  return {
    type,
    ...(type === "task" ? { checked: block.checked } : {}),
    ...(type === "code" && block.language ? { language: block.language } : {})
  };
}

function mergeReferences(...groups) {
  const references = [];
  const seen = new Set();
  for (const reference of groups.flat()) {
    const key = `${reference.pageId}:${reference.start ?? ""}:${reference.end ?? ""}`;
    if (!seen.has(key)) { seen.add(key); references.push(reference); }
  }
  return references;
}

function stableReferencesOutsideSelection(block, prefix, suffix) {
  const references = block.references ?? [];
  const mentions = [...block.text.matchAll(/\[\[([^\]]+)\]\]/g)];
  const suffixStart = block.text.length - suffix.length;
  const prefixReferences = [], suffixReferences = [];
  references.forEach((reference, index) => {
    const start = reference.start ?? mentions[index]?.index;
    const end = reference.end ?? (start === undefined ? undefined : start + mentions[index][0].length);
    if (start !== undefined && end !== undefined && end <= prefix.length) prefixReferences.push({ pageId: reference.pageId });
    else if (start !== undefined && end !== undefined && start >= suffixStart) suffixReferences.push({ pageId: reference.pageId });
  });
  return { prefixReferences, suffixReferences };
}

function contentFor(text, resolveReferences, stableReferences = []) {
  return { text, references: mergeReferences(stableReferences, resolveReferences?.(text) ?? []) };
}

export function multilinePasteCommands({ pageId, blocks, activeBlockId, text, prefix = "", suffix = "", createId, resolveReferences }) {
  const activeIndex = blocks.findIndex(block => block.id === activeBlockId);
  if (activeIndex < 0) throw new Error("Active paste block was not found");
  const normalizedText = String(text);
  const lineCount = normalizedText.split(/\r\n|\r|\n/).length;
  if (lineCount > MAX_BATCH_COMMANDS - 1) throw new Error("Multiline paste is limited to 9,999 blocks");
  if ([normalizedText, prefix, suffix].some(value => String(value).length > MAX_STRING_LENGTH)) throw new Error("Paste blocks are limited to 10,000,000 characters");

  const parsed = markdownBlocksFromPlainText(normalizedText, createId, resolveReferences);
  const { prefixReferences, suffixReferences } = stableReferencesOutsideSelection(blocks[activeIndex], String(prefix), String(suffix));
  const beforeBlockId = blocks[activeIndex + 1]?.id ?? null;
  const first = parsed[0];
  let last = parsed.at(-1);
  if (first.type !== "divider") first.text = `${prefix}${first.text}`;
  if (last.type === "divider" && suffix) {
    parsed.push(withReferences({ id: createId(), type: "paragraph", text: suffix, children: [] }, resolveReferences));
    last = parsed.at(-1);
  } else {
    last.text = `${last.text}${suffix}`;
  }
  for (const block of parsed) {
    if (block.type === "divider") continue;
    const references = resolveReferences?.(block.text) ?? [];
    if (references.length) block.references = references;
    else delete block.references;
  }
  if (suffixReferences.length) last.references = mergeReferences(last.references ?? [], suffixReferences);
  if (first.text.length > MAX_STRING_LENGTH || parsed.some(block => block.text.length > MAX_STRING_LENGTH)) throw new Error("Paste blocks are limited to 10,000,000 characters");

  const leadingDivider = first.type === "divider";
  const commands = leadingDivider ? [
    { type: "block.update-content", pageId, blockId: activeBlockId, content: contentFor(prefix, resolveReferences, prefixReferences) },
    ...parsed.map(block => ({
      type: "block.create",
      pageId,
      position: { parentBlockId: null, beforeBlockId },
      block
    }))
  ] : [
    { type: "block.transform", pageId, blockId: activeBlockId, transform: transformFor(first) },
    { type: "block.update-content", pageId, blockId: activeBlockId, content: contentFor(first.text, resolveReferences, mergeReferences(prefixReferences, first === last ? suffixReferences : [])) },
    ...parsed.slice(1).map(block => ({
      type: "block.create",
      pageId,
      position: { parentBlockId: null, beforeBlockId },
      block
    }))
  ];
  if (commands.length > MAX_BATCH_COMMANDS) throw new Error("Multiline paste is limited to 9,999 blocks");
  return commands;
}
