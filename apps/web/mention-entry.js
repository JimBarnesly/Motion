export function activeMentionQuery(text, caret) {
  const prefix = String(text).slice(0, caret);
  const wiki = prefix.match(/(?:^|\s)\[\[([^\]\n]*)$/);
  if (wiki) {
    const start = prefix.length - wiki[1].length - 2;
    return { start, end: caret, query: wiki[1], kind: "wiki" };
  }
  const match = prefix.match(/(?:^|\s)@([^\s@\[\]]*)$/);
  if (!match) return null;
  const start = prefix.length - match[1].length - 1;
  return { start, end: caret, query: match[1] };
}

export const MAX_WIKI_PAGE_TITLE_LENGTH = 200;

export function missingWikiPageTitle({ mention, pages, maxLength = MAX_WIKI_PAGE_TITLE_LENGTH }) {
  if (mention?.kind !== "wiki") return null;
  const title = String(mention.query ?? "");
  if (!title.trim() || title.length > maxLength) return null;
  return pages.some(page => page.title === title) ? null : title;
}

export function applyMentionSelection({ text, mention, page, previousReferences = [] }) {
  const title = String(page.title).replaceAll("\\", "\\\\").replaceAll("]", "\\]");
  const token = mention.kind === "wiki" ? `[[${title}]]` : `@[${title}]`;
  const delta = token.length - (mention.end - mention.start);
  const references = previousReferences.flatMap(reference => {
    if (!Number.isInteger(reference.start) || !Number.isInteger(reference.end)) return [reference];
    if (reference.end <= mention.start) return [reference];
    if (reference.start >= mention.end) return [{ ...reference, start: reference.start + delta, end: reference.end + delta }];
    return [];
  });
  references.push({ pageId: page.id, start: mention.start, end: mention.start + token.length });
  return {
    text: `${text.slice(0, mention.start)}${token}${text.slice(mention.end)}`,
    references
  };
}
