export const SLASH_BLOCK_COMMANDS = Object.freeze([
  { type: "paragraph", label: "Text", keywords: ["plain", "paragraph"] },
  { type: "heading-1", label: "Heading 1", keywords: ["h1", "title"] },
  { type: "heading-2", label: "Heading 2", keywords: ["h2", "subtitle"] },
  { type: "heading-3", label: "Heading 3", keywords: ["h3"] },
  { type: "bulleted-list", label: "Bulleted list", keywords: ["bullet", "unordered", "list"] },
  { type: "numbered-list", label: "Numbered list", keywords: ["number", "ordered", "list"] },
  { type: "task", label: "To-do list", keywords: ["todo", "checkbox", "task", "list"] },
  { type: "quote", label: "Quote", keywords: ["blockquote"] },
  { type: "code", label: "Code", keywords: ["snippet"] },
  { type: "divider", label: "Divider", keywords: ["line", "separator"] }
]);

export function activeSlashQuery(text, caret) {
  const prefix = String(text ?? "").slice(0, caret);
  const match = prefix.match(/(?:^|\s)\/([\p{L}\p{N} _-]*)$/u);
  if (!match) return null;
  const start = prefix.length - match[1].length - 1;
  return { start, end: caret, query: match[1] };
}

export function slashCommandChoices(query, commands = SLASH_BLOCK_COMMANDS) {
  const needle = String(query ?? "").trim().toLocaleLowerCase();
  if (!needle) return [...commands];
  return commands.filter(command => [command.label, ...(command.keywords ?? [])]
    .some(value => String(value).toLocaleLowerCase().includes(needle)));
}

function adjustedReferences(references, start, end) {
  const delta = start - end;
  return (references ?? []).flatMap(reference => {
    if (!Number.isInteger(reference.start) || !Number.isInteger(reference.end)) return [structuredClone(reference)];
    if (reference.end <= start) return [structuredClone(reference)];
    if (reference.start >= end) return [{ ...structuredClone(reference), start: reference.start + delta, end: reference.end + delta }];
    return [];
  });
}

export function applySlashCommand({ pageId, block, slash, type }) {
  if (!pageId || !block?.id || !slash || !SLASH_BLOCK_COMMANDS.some(command => command.type === type)) {
    throw new TypeError("A supported slash command requires page, block and query identities");
  }
  const text = String(block.text ?? "");
  if (slash.start < 0 || slash.end < slash.start || slash.end > text.length) throw new RangeError("Slash query range is invalid");
  const nextText = `${text.slice(0, slash.start)}${text.slice(slash.end)}`;
  const references = adjustedReferences(block.references, slash.start, slash.end);
  const transform = { type, ...(type === "task" ? { checked: false } : {}) };
  return {
    text: nextText,
    references,
    commands: [
      { type: "block.transform", pageId, blockId: block.id, transform },
      { type: "block.update-content", pageId, blockId: block.id, content: { text: nextText, references } }
    ]
  };
}
