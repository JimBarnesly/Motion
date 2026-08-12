function mentions(text) {
  return [...String(text).matchAll(/\[\[([^\]]+)\]\]/g)].map(match => ({
    token: match[0],
    title: match[1],
    start: match.index,
    end: match.index + match[0].length
  }));
}

function unchangedEdges(previousText, nextText) {
  let prefix = 0;
  while (prefix < previousText.length && prefix < nextText.length && previousText[prefix] === nextText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previousText.length - prefix && suffix < nextText.length - prefix && previousText.at(-1 - suffix) === nextText.at(-1 - suffix)) suffix += 1;
  return { prefix, suffix };
}

export function reconcileTextReferences({ previousText = "", previousReferences = [], nextText = "", pages = [] }) {
  const before = mentions(previousText);
  const after = mentions(nextText);
  const stableByRange = new Map();

  if (before.length === previousReferences.length) {
    const { prefix, suffix } = unchangedEdges(previousText, nextText);
    const previousSuffixStart = previousText.length - suffix;
    before.forEach((mention, index) => {
      let nextStart;
      if (mention.end <= prefix) nextStart = mention.start;
      else if (mention.end > previousSuffixStart) {
        const nextEnd = nextText.length - (previousText.length - mention.end);
        nextStart = nextEnd - mention.token.length;
      }
      if (nextStart !== undefined && nextText.slice(nextStart, nextStart + mention.token.length) === mention.token) {
        stableByRange.set(`${nextStart}:${mention.token}`, previousReferences[index].pageId);
      }
    });
  }

  return after.flatMap(mention => {
    const stableId = stableByRange.get(`${mention.start}:${mention.token}`);
    const title = mention.title.trim().toLowerCase();
    const target = pages.find(page => page.title.toLowerCase() === title);
    const stablePage = pages.find(page => page.id === stableId);
    if (target && stablePage && stablePage.title.toLowerCase() !== title) return [{ pageId: target.id }];
    if (stableId) return [{ pageId: stableId }];
    return target ? [{ pageId: target.id }] : [];
  });
}
