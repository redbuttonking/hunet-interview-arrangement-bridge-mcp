// 면접관 가용 시간과 동기화된 회의실 블록을 함께 추천하는 흐름을 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../src/db/database.js";
import { suggestInterviewSlotsWithRooms } from "../src/services/room-scheduling.js";

let db: BridgeDatabase | undefined;
afterEach(() => db?.close());

describe("room scheduling", () => {
  it("offers only room slots inside a synced meeting room block", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "지원자",
      durationMinutes: 60,
      proposalDates: ["2026-07-30"],
    });
    const interviewer = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "면접관",
      source: "MANUAL",
    });
    db.replaceAvailabilityForInterviewer(interviewCase.id, interviewer.id, [
      { date: "2026-07-30", start: "09:00", end: "12:00" },
    ]);
    db.syncMeetingRoomBlocks(
      ["2026-07-30"],
      [
        {
          sourceKey: "DAOU:1",
          roomId: "103",
          roomName: "[818호] 행복룸",
          reservedBy: "강해빈",
          purpose: "면접",
          date: "2026-07-30",
          startTime: "10:00",
          endTime: "12:00",
          sourcePayloadHash: "hash",
        },
      ],
    );

    expect(suggestInterviewSlotsWithRooms(db, interviewCase.id)).toMatchObject({
      ready: true,
      roomSync: "SYNCED",
      meetingRoomCheck: "AVAILABLE",
      suggestions: [
        {
          date: "2026-07-30",
          start: "10:00",
          end: "11:00",
          rooms: [{ roomName: "[818호] 행복룸" }],
        },
        {
          date: "2026-07-30",
          start: "11:00",
          end: "12:00",
          rooms: [{ roomName: "[818호] 행복룸" }],
        },
      ],
    });
  });
});
