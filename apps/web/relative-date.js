/** See packages/core/src/relative-date.ts for the canonical documented contract. */
export const RELATIVE_DATE_PRESETS = Object.freeze(["today", "yesterday", "tomorrow", "past-week", "next-week", "past-month", "next-month"]);
const presetSet = new Set(RELATIVE_DATE_PRESETS);
const dayMs = 86_400_000;
export const isRelativeDatePreset = value => typeof value === "string" && presetSet.has(value);

export function relativeDateBounds(preset, now) {
  if (!isRelativeDatePreset(preset) || !(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const offsets = { today:[0,1], yesterday:[-1,0], tomorrow:[1,2], "past-week":[-6,1], "next-week":[0,7], "past-month":[-29,1], "next-month":[0,30] };
  const [start,end] = offsets[preset];
  return [new Date(today + start * dayMs), new Date(today + end * dayMs)];
}

export function matchesRelativeDate(value, preset, now) {
  const bounds = relativeDateBounds(preset, now);
  if (!bounds) return false;
  const [windowStart, windowEnd] = bounds.map(date => date.getTime());
  if (typeof value === "string") { const instant = Date.parse(value); return Number.isFinite(instant) && instant >= windowStart && instant < windowEnd; }
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.start === "string") {
    const start = Date.parse(value.start), end = Date.parse(value.end ?? value.start);
    return Number.isFinite(start) && Number.isFinite(end) && start < windowEnd && end >= windowStart;
  }
  return false;
}
