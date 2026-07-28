// 연속 면접의 단계별 면접관 가용시간과 회의실 배정을 추천한다.
import type { BridgeDatabase, SequentialInterviewSession } from "../db/database.js";
import type { TimeSlot } from "../domain/types.js";

function minutes(time: string): number {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid time: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function time(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function contains(slots: TimeSlot[], date: string, start: number, end: number): boolean {
  return slots.some(
    (slot) =>
      slot.date === date &&
      minutes(slot.start) <= start &&
      minutes(slot.end) >= end,
  );
}

function roomPlans(
  db: BridgeDatabase,
  date: string,
  start: number,
  sessions: SequentialInterviewSession[],
): Array<{
  mode: "SAME_ROOM" | "MULTIPLE_ROOMS";
  rooms: Array<{ roomBlockId: string; roomName: string; startTime: string; endTime: string }>;
}> {
  const totalEnd = start + sessions.length * 60;
  const shared = db.findAvailableRoomBlocks(date, time(start), time(totalEnd));
  if (shared.length > 0) {
    return shared.slice(0, 5).map((room) => ({
      mode: "SAME_ROOM" as const,
      rooms: sessions.map((_, index) => ({
        roomBlockId: room.id,
        roomName: room.roomName,
        startTime: time(start + index * 60),
        endTime: time(start + (index + 1) * 60),
      })),
    }));
  }
  const options = sessions.map((_, index) =>
    db
      .findAvailableRoomBlocks(
        date,
        time(start + index * 60),
        time(start + (index + 1) * 60),
      )
      .slice(0, 3),
  );
  if (options.some((items) => items.length === 0)) return [];
  const combinations: Array<{
    roomBlockId: string;
    roomName: string;
    startTime: string;
    endTime: string;
  }> = [];
  const plans: Array<{
    mode: "MULTIPLE_ROOMS";
    rooms: Array<{ roomBlockId: string; roomName: string; startTime: string; endTime: string }>;
  }> = [];
  const visit = (index: number) => {
    if (plans.length >= 10) return;
    if (index === sessions.length) {
      plans.push({ mode: "MULTIPLE_ROOMS", rooms: [...combinations] });
      return;
    }
    for (const room of options[index]!) {
      combinations.push({
        roomBlockId: room.id,
        roomName: room.roomName,
        startTime: time(start + index * 60),
        endTime: time(start + (index + 1) * 60),
      });
      visit(index + 1);
      combinations.pop();
    }
  };
  visit(0);
  return plans;
}

export function suggestSequentialInterviewSlotsWithRooms(
  db: BridgeDatabase,
  caseId: string,
) {
  const bundle = db.getCaseBundle(caseId);
  if (!bundle) throw new Error(`Case not found: ${caseId}`);
  const plan = db.getCaseInterviewPlan(caseId);
  if (!plan || plan.mode !== "SEQUENTIAL" || plan.sessions.length < 2) {
    throw new Error("Configure a sequential interview plan before requesting suggestions.");
  }
  const missingRequiredResponses = bundle.interviewers
    .filter((interviewer) => plan.interviewerIds.includes(interviewer.id))
    .filter((interviewer) => interviewer.status !== "SUBMITTED")
    .map((interviewer) => interviewer.displayName);
  if (missingRequiredResponses.length > 0) {
    return { ready: false, missingRequiredResponses, suggestions: [] };
  }
  const availability = new Map<string, TimeSlot[]>();
  for (const slot of bundle.availability) {
    const items = availability.get(slot.interviewerId) ?? [];
    items.push(slot);
    availability.set(slot.interviewerId, items);
  }
  const names = new Map(bundle.interviewers.map((interviewer) => [interviewer.id, interviewer.displayName]));
  const makeSuggestions = (sessions: SequentialInterviewSession[], order: "NORMAL" | "REVERSED") => {
    const suggestions: Array<Record<string, unknown>> = [];
    for (const date of bundle.interviewCase.proposalDates) {
      for (let start = 9 * 60; start + sessions.length * 60 <= 18 * 60; start += 60) {
        const available = sessions.every((session, index) =>
          session.interviewerIds.every((interviewerId) =>
            contains(availability.get(interviewerId) ?? [], date, start + index * 60, start + (index + 1) * 60),
          ),
        );
        if (!available) continue;
        for (const rooms of roomPlans(db, date, start, sessions)) {
          suggestions.push({
            order,
            date,
            startTime: time(start),
            endTime: time(start + sessions.length * 60),
            roomMode: rooms.mode,
            sessions: sessions.map((session, index) => ({
              stepId: session.stepId,
              stepName: session.stepName,
              startTime: time(start + index * 60),
              endTime: time(start + (index + 1) * 60),
              interviewerNames: session.interviewerIds.map((id) => names.get(id) ?? id),
              room: rooms.rooms[index],
            })),
          });
        }
      }
    }
    return suggestions;
  };
  const normal = makeSuggestions(plan.sessions, "NORMAL");
  return {
    ready: true,
    missingRequiredResponses: [],
    suggestions: normal.length > 0 ? normal : makeSuggestions([...plan.sessions].reverse(), "REVERSED"),
  };
}
