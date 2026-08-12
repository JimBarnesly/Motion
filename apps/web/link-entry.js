function normalized(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

export function findLinkTrigger(text) {
  const value = String(text ?? "");
  const start = value.lastIndexOf("[[");
  if (start < 0 || value.slice(start + 2).includes("]]")) return null;
  return { start, query: value.slice(start + 2) };
}

export function buildLinkTargetChoices({ pages, databases, currentPageId, query }) {
  const databasePageIds = new Set(databases.map(database => database.pageId));
  const term = normalized(query);
  return pages
    .filter(page => page.id !== currentPageId && !page.deletedAt && (!term || normalized(page.title).includes(term)))
    .map(page => ({
      pageId: page.id,
      title: page.title || "Untitled",
      kind: databasePageIds.has(page.id) ? "database" : "page"
    }));
}

export function reconcileLinkReferences({ previousText = text, text, references = [], pages }) {
  let prefix = 0;
  while (prefix < previousText.length && prefix < text.length && previousText[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (suffix < previousText.length - prefix && suffix < text.length - prefix && previousText[previousText.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
  const oldChangeEnd = previousText.length - suffix, delta = text.length - previousText.length;
  const legacy = references.filter(reference => !Number.isInteger(reference.start) || !Number.isInteger(reference.end));
  const ranged = references.flatMap(reference => {
    if (!Number.isInteger(reference.start) || !Number.isInteger(reference.end)) return [];
    const token = previousText.slice(reference.start, reference.end);
    if (!/^\[\[[\s\S]*\]\]$/.test(token)) return [];
    const start = oldChangeEnd <= reference.start ? reference.start + delta : reference.end <= prefix ? reference.start : reference.start;
    return text.slice(start, start + token.length) === token ? [{ pageId: reference.pageId, start, end: start + token.length }] : [];
  });
  const occupied = new Set(ranged.map(reference => `${reference.start}:${reference.end}`));
  for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const start = match.index, end = start + match[0].length;
    if (occupied.has(`${start}:${end}`)) continue;
    const candidates = pages.filter(page => !page.deletedAt && normalized(page.title) === normalized(match[1]));
    if (candidates.length === 1) ranged.push({ pageId: candidates[0].id, start, end });
  }
  return [...legacy, ...ranged.sort((left, right) => left.start - right.start)];
}

export function applyLinkTarget({ text, trigger, replaceEnd = text.length, target, references = [], pages = [] }) {
  const replacement = `[[${target.title}]]`;
  const nextText = `${text.slice(0, trigger.start)}${replacement}${text.slice(replaceEnd)}`;
  const retained = reconcileLinkReferences({ previousText: text, text: nextText, references, pages }).filter(reference => !Number.isInteger(reference.start) || reference.end <= trigger.start || reference.start >= trigger.start + replacement.length);
  return {
    text: nextText,
    caret: trigger.start + replacement.length,
    references: [...retained, { pageId: target.pageId, start: trigger.start, end: trigger.start + replacement.length }]
  };
}
