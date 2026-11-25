import { findBlockLocation } from "./block-tree.js";

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

function containerHeaderPaste({ pageId, block, text, prefix, suffix, createId, resolveReferences }) {
  if (block.unknownData !== undefined) throw new Error("This container has preserved extension data and cannot be split safely.");
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const header = `${prefix}${lines.shift()}`;
  const children = lines.length ? markdownBlocksFromPlainText(lines.join("\n"), createId, resolveReferences) : [];
  const mentions = [...block.text.matchAll(/\[\[([^\]]+)\]\]|@\[([^\]]+)\]/g)];
  const suffixStart = block.text.length - suffix.length, before = [], after = [];
  (block.references ?? []).forEach((reference, index) => {
    const explicit = reference.start !== undefined && reference.end !== undefined;
    const start = reference.start ?? mentions[index]?.index;
    const end = reference.end ?? (start === undefined ? undefined : start + mentions[index][0].length);
    if (start !== undefined && end !== undefined && end <= prefix.length) before.push(structuredClone(reference));
    else if (start !== undefined && end !== undefined && start >= suffixStart) {
      after.push(explicit ? { ...structuredClone(reference), start: start - suffixStart, end: end - suffixStart } : { pageId: reference.pageId });
    }
  });
  if (!children.length) return [{ type: "block.update-content", pageId, blockId: block.id,
    content: contentFor(header + suffix, resolveReferences, [...before, ...after.map(reference => reference.start === undefined
      ? reference : { ...reference, start: reference.start + header.length, end: reference.end + header.length })]) }];
  if (children.at(-1).type === "divider" && suffix) children.push({ id: createId(), type: "paragraph", text: "", children: [] });
  const last = children.at(-1), insertedLength = last.text.length;
  last.text += suffix;
  if (last.type !== "divider") last.references = contentFor(last.text, resolveReferences, after.map(reference => reference.start === undefined
    ? reference : { ...reference, start: reference.start + insertedLength, end: reference.end + insertedLength })).references;
  if (header.length > MAX_STRING_LENGTH || children.some(child => child.text.length > MAX_STRING_LENGTH)
      || children.length + 1 > MAX_BATCH_COMMANDS) throw new Error("Container paste exceeds block limits");
  return [
    { type: "block.update-content", pageId, blockId: block.id, content: contentFor(header, resolveReferences, before) },
    ...children.map(child => ({ type: "block.create", pageId,
      position: { parentBlockId: block.id, beforeBlockId: block.children[0]?.id ?? null }, block: child }))
  ];
}

export function multilinePasteCommands({ pageId, blocks, activeBlockId, text, prefix = "", suffix = "", createId, resolveReferences }) {
  const location = findBlockLocation(blocks, activeBlockId);
  if (!location) throw new Error("Active paste block was not found");
  const normalizedText = String(text);
  const lineCount = normalizedText.split(/\r\n|\r|\n/).length;
  if (lineCount > MAX_BATCH_COMMANDS - 1) throw new Error("Multiline paste is limited to 9,999 blocks");
  if ([normalizedText, prefix, suffix].some(value => String(value).length > MAX_STRING_LENGTH)) throw new Error("Paste blocks are limited to 10,000,000 characters");
  if (["toggle", "callout"].includes(location.block.type)) {
    return containerHeaderPaste({ pageId, block: location.block, text: normalizedText, prefix: String(prefix), suffix: String(suffix), createId, resolveReferences });
  }
  if (!["paragraph", "heading-1", "heading-2", "heading-3", "bulleted-list", "numbered-list", "task", "quote", "code"].includes(location.block.type)) {
    throw new Error("This block cannot accept multiline paste without changing unsupported content.");
  }

  const parsed = markdownBlocksFromPlainText(normalizedText, createId, resolveReferences);
  const { prefixReferences, suffixReferences } = stableReferencesOutsideSelection(location.block, String(prefix), String(suffix));
  const parentBlockId = location.parent?.id ?? null;
  const beforeBlockId = location.blocks[location.index + 1]?.id ?? null;
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
      position: { parentBlockId, beforeBlockId },
      block
    }))
  ] : [
    { type: "block.transform", pageId, blockId: activeBlockId, transform: transformFor(first) },
    { type: "block.update-content", pageId, blockId: activeBlockId, content: contentFor(first.text, resolveReferences, mergeReferences(prefixReferences, first === last ? suffixReferences : [])) },
    ...parsed.slice(1).map(block => ({
      type: "block.create",
      pageId,
      position: { parentBlockId, beforeBlockId },
      block
    }))
  ];
  if (commands.length > MAX_BATCH_COMMANDS) throw new Error("Multiline paste is limited to 9,999 blocks");
  return commands;
}
