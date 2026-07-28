// 연속 면접의 단계별 가용시간과 회의실 배정 규칙을 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../src/db/database.js";
import { suggestSequentialInterviewSlotsWithRooms } from "../src/services/sequential-scheduling.js";

let db: BridgeDatabase | undefined;

afterEach(() => db?.close());

function createSequentialCase(input: {
  firstAvailability: { start: string; end: string };
  secondAvailability: { start: string; end: string };
}) {
  const interviewCase = db!.createInterviewCase({
    candidateName: "Candidate",
    recruitmentRef: "R1",
    proposalDates: ["2026-08-10"],
  });
  const first = db!.addOrUpdateInterviewer({
    caseId: interviewCase.id,
    displayName: "First interviewer",
    source: "MANUAL",
  });
  const second = db!.addOrUpdateInterviewer({
    caseId: interviewCase.id,
    displayName: "Second interviewer",
    source: "MANUAL",
  });
  db!.setRequiredInterviewers(interviewCase.id, [first.id, second.id]);
  db!.replaceAvailabilityForInterviewer(interviewCase.id, first.id, [
    { date: "2026-08-10", ...input.firstAvailability },
  ]);
  db!.replaceAvailabilityForInterviewer(interviewCase.id, second.id, [
    { date: "2026-08-10", ...input.secondAvailability },
  ]);
  db!.upsertCaseInterviewPlan({
    caseId: interviewCase.id,
    source: "CANDIDATE_OVERRIDE",
    mode: "SEQUENTIAL",
    stepIds: ["S1", "S2"],
    stepNames: ["First interview", "Second interview"],
    interviewerIds: [first.id, second.id],
    sessions: [
      { stepId: "S1", stepName: "First interview", interviewerIds: [first.id] },
      { stepId: "S2", stepName: "Second interview", interviewerIds: [second.id] },
    ],
    durationMinutes: 120,
  });
  return { interviewCase, first, second };
}

function roomBlock(input: {
  sourceKey: string;
  roomId: string;
  roomName: string;
  startTime: string;
  endTime: string;
}) {
  return {
    ...input,
    reservedBy: "Recruiter",
    purpose: "Interview",
    date: "2026-08-10",
    sourcePayloadHash: `hash:${input.sourceKey}`,
  };
}

describe("sequential interview scheduling", () => {
  it("calculates each stage's interviewer availability separately in normal order", () => {
    db = new BridgeDatabase(":memory:");
    const { interviewCase } = createSequentialCase({
      firstAvailability: { start: "09:00", end: "10:00" },
      secondAvailability: { start: "10:00", end: "11:00" },
    });
    db.syncMeetingRoomBlocks(
      ["2026-08-10"],
      [roomBlock({ sourceKey: "same", roomId: "A", roomName: "Room A", startTime: "09:00", endTime: "11:00" })],
    );

    expect(suggestSequentialInterviewSlotsWithRooms(db, interviewCase.id)).toMatchObject({
      ready: true,
      suggestions: [
        {
          order: "NORMAL",
          startTime: "09:00",
          endTime: "11:00",
          roomMode: "SAME_ROOM",
          sessions: [
            { stepId: "S1", startTime: "09:00", endTime: "10:00", room: { roomName: "Room A" } },
            { stepId: "S2", startTime: "10:00", endTime: "11:00", room: { roomName: "Room A" } },
          ],
        },
      ],
    });
  });

  it("offers reversed order only when normal order has no available combination", () => {
    db = new BridgeDatabase(":memory:");
    const { interviewCase } = createSequentialCase({
      firstAvailability: { start: "10:00", end: "11:00" },
      secondAvailability: { start: "09:00", end: "10:00" },
    });
    db.syncMeetingRoomBlocks(
      ["2026-08-10"],
      [roomBlock({ sourceKey: "reverse", roomId: "A", roomName: "Room A", startTime: "09:00", endTime: "11:00" })],
    );

    expect(suggestSequentialInterviewSlotsWithRooms(db, interviewCase.id)).toMatchObject({
      ready: true,
      suggestions: [
        {
          order: "REVERSED",
          sessions: [{ stepId: "S2" }, { stepId: "S1" }],
        },
      ],
    });
  });

  it("uses different meeting rooms for consecutive stages when one shared room is unavailable", () => {
    db = new BridgeDatabase(":memory:");
    const { interviewCase } = createSequentialCase({
      firstAvailability: { start: "09:00", end: "10:00" },
      secondAvailability: { start: "10:00", end: "11:00" },
    });
    db.syncMeetingRoomBlocks(
      ["2026-08-10"],
      [
        roomBlock({ sourceKey: "first", roomId: "A", roomName: "Room A", startTime: "09:00", endTime: "10:00" }),
        roomBlock({ sourceKey: "second", roomId: "B", roomName: "Room B", startTime: "10:00", endTime: "11:00" }),
      ],
    );

    expect(suggestSequentialInterviewSlotsWithRooms(db, interviewCase.id)).toMatchObject({
      suggestions: [
        {
          order: "NORMAL",
          roomMode: "MULTIPLE_ROOMS",
          sessions: [
            { room: { roomName: "Room A" } },
            { room: { roomName: "Room B" } },
          ],
        },
      ],
    });
  });

  it("keeps both allocations and their stages after sequential internal confirmation", () => {
    db = new BridgeDatabase(":memory:");
    const { interviewCase } = createSequentialCase({
      firstAvailability: { start: "09:00", end: "10:00" },
      secondAvailability: { start: "10:00", end: "11:00" },
    });
    const blocks = db.syncMeetingRoomBlocks(
      ["2026-08-10"],
      [
        roomBlock({ sourceKey: "allocate-first", roomId: "A", roomName: "Room A", startTime: "09:00", endTime: "10:00" }),
        roomBlock({ sourceKey: "allocate-second", roomId: "B", roomName: "Room B", startTime: "10:00", endTime: "11:00" }),
      ],
    );
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");

    const allocations = db.allocateSequentialRoomBlocks({
      caseId: interviewCase.id,
      sessions: [
        { stepId: "S1", roomBlockId: blocks[0]!.id, startTime: "09:00", endTime: "10:00" },
        { stepId: "S2", roomBlockId: blocks[1]!.id, startTime: "10:00", endTime: "11:00" },
      ],
    });
    const confirmed = db.confirmSequentialInternalSchedule(interviewCase.id);

    expect(allocations).toMatchObject([
      { interviewStepId: "S1", sequenceIndex: 0 },
      { interviewStepId: "S2", sequenceIndex: 1 },
    ]);
    expect(confirmed).toMatchObject({
      date: "2026-08-10",
      startTime: "09:00",
      endTime: "11:00",
    });
    expect(confirmed.roomName).toContain("Room A");
    expect(confirmed.roomName).toContain("Room B");
    expect(() => db!.cancelRoomAllocation(interviewCase.id, allocations[1]!.id)).toThrow(
      "internally confirmed schedule",
    );

    db.reopenScheduleForReschedule({
      caseId: interviewCase.id,
      availabilityPolicy: "REUSE",
      reason: "Candidate asked for another date.",
    });
    expect(db.listRoomAllocations(interviewCase.id)).toMatchObject([
      { id: allocations[0]!.id, status: "CANCELLED" },
      { id: allocations[1]!.id, status: "CANCELLED" },
    ]);
  });
});
