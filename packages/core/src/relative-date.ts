import type { DateRange, PropertyValue } from "./model.js";

/**
 * Canonical relative-date presets. All windows are half-open UTC calendar-day
 * intervals. Rolling windows include the current UTC date: past-week is the
 * current date plus the previous six dates, next-week is the current date plus
 * the following six dates, and month presets use the same rule over 30 dates.
 */
export const RELATIVE_DATE_PRESETS = Object.freeze([
  "today",
  "yesterday",
  "tomorrow",
  "past-week",
  "next-week",
  "past-month",
  "next-month"
] as const);

export type RelativeDatePreset = typeof RELATIVE_DATE_PRESETS[number];
const PRESET_SET: ReadonlySet<string> = new Set(RELATIVE_DATE_PRESETS);
const DAY_MS = 86_400_000;

export function isRelativeDatePreset(value: unknown): value is RelativeDatePreset {
  return typeof value === "string" && PRESET_SET.has(value);
}

export function relativeDateBounds(preset: RelativeDatePreset, now: Date): readonly [Date, Date] {
  if (!isRelativeDatePreset(preset) || !Number.isFinite(now.getTime())) throw new Error("Invalid relative-date preset or clock");
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const offsets: Record<RelativeDatePreset, readonly [number, number]> = {
    today: [0, 1], yesterday: [-1, 0], tomorrow: [1, 2],
    "past-week": [-6, 1], "next-week": [0, 7],
    "past-month": [-29, 1], "next-month": [0, 30]
  };
  const [start, end] = offsets[preset];
  return [new Date(today + start * DAY_MS), new Date(today + end * DAY_MS)];
}

/** Date instants match inside the window; date ranges match when they overlap it. */
export function matchesRelativeDate(value: PropertyValue | undefined, preset: RelativeDatePreset, now: Date): boolean {
  const [windowStart, windowEnd] = relativeDateBounds(preset, now).map(date => date.getTime());
  if (typeof value === "string") {
    const instant = Date.parse(value);
    return Number.isFinite(instant) && instant >= windowStart && instant < windowEnd;
  }
  if (isDateRange(value)) {
    const start = Date.parse(value.start), end = Date.parse(value.end ?? value.start);
    return Number.isFinite(start) && Number.isFinite(end) && start < windowEnd && end >= windowStart;
  }
  return false;
}

function isDateRange(value: PropertyValue | undefined): value is DateRange {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "start" in value;
}
