import type { TimeSlot } from "./types.js";

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function parseDateOnly(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date: ${date}`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${date}`);
  return parsed;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return formatDateOnly(new Date(parseDateOnly(date).getTime() + days * DAY_MS));
}

function weekday(date: string): number {
  return parseDateOnly(date).getUTCDay();
}

function nextBusinessDate(date: string): string {
  let next = addDays(date, 1);
  while ([0, 6].includes(weekday(next))) next = addDays(next, 1);
  return next;
}

/**
 * PDF rule:
 * - Monday request: this Thursday + next Monday through Thursday.
 * - Other request days: next Monday through Thursday.
 */
export function proposalDates(requestDate: string): string[] {
  const day = weekday(requestDate);
  if (day === 1) {
    const thisThursday = addDays(requestDate, 3);
    return [
      thisThursday,
      addDays(requestDate, 7),
      addDays(requestDate, 8),
      addDays(requestDate, 9),
      addDays(requestDate, 10),
    ];
  }

  const daysUntilNextMonday = (8 - day) % 7 || 7;
  const monday = addDays(requestDate, daysUntilNextMonday);
  return [monday, addDays(monday, 1), addDays(monday, 2), addDays(monday, 3)];
}

export function nextProposalWeekDates(
  dates: string[],
  notBefore?: string,
): string[] {
  if (dates.length === 0) {
    throw new Error("At least one proposal date is required.");
  }
  if (notBefore) parseDateOnly(notBefore);
  let next = [...new Set(dates.map((date) => addDays(date, 7)))].sort();
  while (notBefore && next.some((date) => date < notBefore)) {
    next = next.map((date) => addDays(date, 7));
  }
  return next;
}

export function defaultHourlySlots(): Array<{ start: string; end: string }> {
  return Array.from({ length: 9 }, (_, index) => {
    const startHour = index + 9;
    return {
      start: `${String(startHour).padStart(2, "0")}:00`,
      end: `${String(startHour + 1).padStart(2, "0")}:00`,
    };
  });
}

export function normalizeSlots(slots: TimeSlot[]): TimeSlot[] {
  const unique = new Map<string, TimeSlot>();
  for (const slot of slots) {
    unique.set(`${slot.date}|${slot.start}|${slot.end}`, slot);
  }

  const ordered = [...unique.values()].sort((a, b) =>
    `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`),
  );
  const merged: TimeSlot[] = [];
  for (const slot of ordered) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.date === slot.date &&
      previous.end === slot.start
    ) {
      previous.end = slot.end;
    } else {
      merged.push({ ...slot });
    }
  }
  return merged;
}

interface KstParts {
  date: string;
  hour: number;
  minute: number;
}

function toKstParts(instant: Date): KstParts {
  const shifted = new Date(instant.getTime() + KST_OFFSET_MS);
  return {
    date: formatDateOnly(shifted),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function fromKst(date: string, hour: number, minute: number): Date {
  const base = parseDateOnly(date).getTime();
  return new Date(base + (hour * 60 + minute) * 60_000 - KST_OFFSET_MS);
}

function isBusinessDate(date: string): boolean {
  return ![0, 6].includes(weekday(date));
}

function alignToBusinessTime(instant: Date): Date {
  let parts = toKstParts(instant);
  while (!isBusinessDate(parts.date)) {
    parts = { date: nextBusinessDate(parts.date), hour: 9, minute: 0 };
  }
  if (parts.hour < 9) return fromKst(parts.date, 9, 0);
  if (parts.hour >= 18) {
    return fromKst(nextBusinessDate(parts.date), 9, 0);
  }
  return instant;
}

export function firstReminderAt(sentAt: Date): Date {
  let cursor = alignToBusinessTime(sentAt);
  let remaining = 120;

  while (remaining > 0) {
    const parts = toKstParts(cursor);
    const minuteOfDay = parts.hour * 60 + parts.minute;
    const available = 18 * 60 - minuteOfDay;
    if (remaining <= available) {
      return new Date(cursor.getTime() + remaining * 60_000);
    }
    remaining -= available;
    cursor = fromKst(nextBusinessDate(parts.date), 9, 0);
  }
  return cursor;
}

export function secondReminderAt(sentAt: Date, firstAt: Date): Date {
  const sentParts = toKstParts(sentAt);
  let candidate = fromKst(nextBusinessDate(sentParts.date), 10, 0);
  if (candidate.getTime() <= firstAt.getTime()) {
    candidate = fromKst(nextBusinessDate(toKstParts(firstAt).date), 10, 0);
  }
  return candidate;
}
