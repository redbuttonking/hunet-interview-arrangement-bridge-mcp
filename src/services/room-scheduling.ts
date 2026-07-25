// 면접관 공통 가능 시간에 로컬 회의실 블록과 내부 배정을 반영한다.
import type { BridgeDatabase } from "../db/database.js";
import { suggestCommonSlots } from "../domain/availability.js";

export function suggestInterviewSlotsWithRooms(
  db: BridgeDatabase,
  caseId: string,
): {
  ready: boolean;
  missingRequiredResponses: string[];
  roomSync: "NOT_SYNCED" | "SYNCED";
  meetingRoomCheck: "NOT_READY" | "NOT_SYNCED" | "NO_AVAILABLE_ROOM" | "AVAILABLE";
  suggestions: Array<{
    date: string;
    start: string;
    end: string;
    optionalAvailable: string[];
    optionalUnavailable: string[];
    rooms: Array<{ roomBlockId: string; roomName: string }>;
  }>;
} {
  const bundle = db.getCaseBundle(caseId);
  if (!bundle) throw new Error(`Case not found: ${caseId}`);
  const common = suggestCommonSlots(bundle);
  if (!common.ready) {
    return {
      ready: false,
      missingRequiredResponses: common.missingRequiredResponses,
      roomSync: "NOT_SYNCED",
      meetingRoomCheck: "NOT_READY",
      suggestions: [],
    };
  }
  const synced = db.areMeetingRoomDatesSynced(bundle.interviewCase.proposalDates);
  if (!synced) {
    return {
      ready: true,
      missingRequiredResponses: [],
      roomSync: "NOT_SYNCED",
      meetingRoomCheck: "NOT_SYNCED",
      suggestions: [],
    };
  }
  const suggestions = common.suggestions
    .map((slot) => ({
      ...slot,
      rooms: db
        .findAvailableRoomBlocks(slot.date, slot.start, slot.end)
        .map((room) => ({ roomBlockId: room.id, roomName: room.roomName })),
    }))
    .filter((slot) => slot.rooms.length > 0);
  return {
    ready: true,
    missingRequiredResponses: [],
    roomSync: "SYNCED",
    meetingRoomCheck: suggestions.length > 0 ? "AVAILABLE" : "NO_AVAILABLE_ROOM",
    suggestions,
  };
}
