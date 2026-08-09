// 다우오피스 캘린더에서 최종 확정된 인터뷰 일정을 추출한다.
import { createHash } from "node:crypto";

export interface DaouInterviewCalendarEvent {
  sourceEventId: string;
  title: string;
  candidateName: string;
  recruitmentName: string;
  date: string;
  startTime: string;
  endTime: string;
  rawText: string;
}

export interface DaouInterviewCalendarEntry {
  title: string;
  startDateTime: string;
  endDateTime: string;
  rawText?: string;
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function parseDate(value: string): string | undefined {
  const match = value.match(/(\d{4})\s*(?:년\s*|[./-]\s*)(\d{1,2})\s*(?:월\s*|[./-]\s*)(\d{1,2})\s*(?:일)?/);
  if (!match) return undefined;
  return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`;
}

function parseClock(period: string | undefined, hourText: string, minuteText: string): string {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (period === "오후" && hour < 12) hour += 12;
  if (period === "오전" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTimeRange(value: string): { startTime: string; endTime: string } | undefined {
  const match = value.match(/(?:(오전|오후)\s*)?(\d{1,2}):([0-5]\d)\s*(?:~|～|-|–|—)\s*(?:(오전|오후)\s*)?(\d{1,2}):([0-5]\d)/);
  if (!match) return undefined;
  const endPeriod = match[4] ?? match[1];
  const startTime = parseClock(match[1], match[2]!, match[3]!);
  const endTime = parseClock(endPeriod, match[5]!, match[6]!);
  if (startTime >= endTime) return undefined;
  return { startTime, endTime };
}

function interviewTitle(value: string): { title: string; recruitmentName: string; candidateName: string } | undefined {
  const normalized = normalizeText(value);
  if (!/^\[면접\]/.test(normalized)) return undefined;
  const candidateMatches = [...normalized.matchAll(/\(([^()]+)\)/g)];
  const candidateMatch = candidateMatches.at(-1);
  if (!candidateMatch) return undefined;
  const candidateName = normalizeText(candidateMatch[1]!);
  const title = normalized.slice(0, candidateMatch.index ?? 0).trim();
  const recruitmentName = title.replace(/^\[면접\]\s*/, "").trim();
  if (!recruitmentName || !candidateName) return undefined;
  return { title: normalized, recruitmentName, candidateName };
}

function eventId(title: string, date: string, startTime: string, endTime: string): string {
  return `DAOU_CALENDAR:${createHash("sha256").update(`${title}|${date}|${startTime}|${endTime}`).digest("hex")}`;
}

function parseIsoDateTime(value: string): { date: string; time: string } | undefined {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return undefined;
  return { date: match[1]!, time: match[2]! };
}

function toCalendarEvent(
  title: { title: string; recruitmentName: string; candidateName: string },
  date: string,
  startTime: string,
  endTime: string,
  rawText: string,
): DaouInterviewCalendarEvent {
  return {
    sourceEventId: eventId(title.title, date, startTime, endTime),
    ...title,
    date,
    startTime,
    endTime,
    rawText,
  };
}

/** 다우오피스 일정 API의 제목과 ISO 시간을 최종 확정 인터뷰 일정으로 변환한다. */
export function parseDaouInterviewCalendarEntries(
  entries: DaouInterviewCalendarEntry[],
): DaouInterviewCalendarEvent[] {
  const events = new Map<string, DaouInterviewCalendarEvent>();
  for (const entry of entries) {
    const title = interviewTitle(entry.title);
    const start = parseIsoDateTime(entry.startDateTime);
    const end = parseIsoDateTime(entry.endDateTime);
    if (!title || !start || !end || start.date !== end.date || start.time >= end.time) {
      continue;
    }
    const event = toCalendarEvent(
      title,
      start.date,
      start.time,
      end.time,
      entry.rawText ?? `${entry.title} ${entry.startDateTime} ${entry.endDateTime}`,
    );
    events.set(event.sourceEventId, event);
  }
  return [...events.values()].sort((left, right) =>
    `${left.date}T${left.startTime}${left.candidateName}`.localeCompare(`${right.date}T${right.startTime}${right.candidateName}`),
  );
}

/** 캘린더 본문의 일정 줄과 주변 날짜·시간을 읽어 인터뷰 일정만 반환한다. */
export function parseDaouInterviewCalendarText(text: string): DaouInterviewCalendarEvent[] {
  const lines = text.split(/\r?\n/).map(normalizeText).filter(Boolean);
  const events = new Map<string, DaouInterviewCalendarEvent>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const titleStart = line.indexOf("[면접]");
    const title = interviewTitle(titleStart >= 0 ? line.slice(titleStart) : line);
    if (!title) continue;
    const context = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4)).join(" ");
    const date = parseDate(context);
    const time = parseTimeRange(lines.slice(index, Math.min(lines.length, index + 4)).join(" ")) ?? parseTimeRange(context);
    if (!date || !time) continue;
    const event = toCalendarEvent(title, date, time.startTime, time.endTime, context);
    events.set(event.sourceEventId, event);
  }
  return [...events.values()].sort((left, right) =>
    `${left.date}T${left.startTime}${left.candidateName}`.localeCompare(`${right.date}T${right.startTime}${right.candidateName}`),
  );
}
