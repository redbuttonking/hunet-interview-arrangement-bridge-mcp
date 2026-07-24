import type { CaseBundle } from "../db/database.js";
import { defaultHourlySlots } from "./calendar.js";
import type { TimeSlot } from "./types.js";

function minutes(time: string): number {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid time: ${time}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time: ${time}`);
  return hour * 60 + minute;
}

function formatTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function contains(
  intervals: TimeSlot[],
  date: string,
  start: number,
  end: number,
): boolean {
  return intervals.some(
    (slot) =>
      slot.date === date &&
      minutes(slot.start) <= start &&
      minutes(slot.end) >= end,
  );
}

export interface CommonSlotSuggestion extends TimeSlot {
  optionalAvailable: string[];
  optionalUnavailable: string[];
}

export function suggestCommonSlots(bundle: CaseBundle): {
  ready: boolean;
  missingRequiredResponses: string[];
  suggestions: CommonSlotSuggestion[];
  meetingRoomCheck: "DEFERRED";
} {
  const active = bundle.interviewers.filter((person) => person.active);
  const required = active.filter((person) => person.required);
  const optional = active.filter((person) => !person.required);
  const missingRequiredResponses = required
    .filter((person) => person.status !== "SUBMITTED")
    .map((person) => person.displayName);
  if (required.length === 0 || missingRequiredResponses.length > 0) {
    return {
      ready: false,
      missingRequiredResponses:
        required.length === 0 ? ["필수 면접관이 지정되지 않음"] : missingRequiredResponses,
      suggestions: [],
      meetingRoomCheck: "DEFERRED",
    };
  }

  const byInterviewer = new Map<string, TimeSlot[]>();
  for (const slot of bundle.availability) {
    const list = byInterviewer.get(slot.interviewerId) ?? [];
    list.push(slot);
    byInterviewer.set(slot.interviewerId, list);
  }

  const suggestions: CommonSlotSuggestion[] = [];
  for (const date of bundle.interviewCase.proposalDates) {
    const candidateStarts = new Set(
      defaultHourlySlots().map((slot) => minutes(slot.start)),
    );
    for (const slot of bundle.availability) {
      if (slot.date === date) candidateStarts.add(minutes(slot.start));
    }
    for (const start of [...candidateStarts].sort((a, b) => a - b)) {
      const end = start + bundle.interviewCase.durationMinutes;
      if (start < 9 * 60 || end > 18 * 60) continue;
      const allRequiredAvailable = required.every((person) =>
        contains(byInterviewer.get(person.id) ?? [], date, start, end),
      );
      if (!allRequiredAvailable) continue;
      const availableOptionalIds = new Set(
        optional
          .filter((person) =>
            contains(byInterviewer.get(person.id) ?? [], date, start, end),
          )
          .map((person) => person.id),
      );
      suggestions.push({
        date,
        start: formatTime(start),
        end: formatTime(end),
        optionalAvailable: optional
          .filter((person) => availableOptionalIds.has(person.id))
          .map((person) => person.displayName),
        optionalUnavailable: optional
          .filter((person) => !availableOptionalIds.has(person.id))
          .map((person) => person.displayName),
      });
    }
  }
  return {
    ready: true,
    missingRequiredResponses: [],
    suggestions,
    meetingRoomCheck: "DEFERRED",
  };
}
