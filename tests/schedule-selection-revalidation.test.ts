// 일정 선택 직전 회의실 재확인 동작을 검증한다.
import { describe, expect, it } from "vitest";
import { BridgeDatabase } from "../src/db/database.js";
import type { MeetingRoomBlockInput } from "../src/domain/daou-office.js";
import { ScheduleSelectionRevalidationService } from "../src/services/schedule-selection-revalidation.js";
import { InterviewArrangementSkills } from "../src/skills/interview-arrangement.js";

function createSkills(db: BridgeDatabase) {
  return new InterviewArrangementSkills(db, {} as never, {} as never);
}

function block(roomName: string): MeetingRoomBlockInput {
  return {
    sourceKey: `DAOU:${roomName}`,
    roomId: roomName,
    roomName,
    reservedBy: "강해빈",
    purpose: "면접",
    date: "2026-08-18",
    startTime: "09:00",
    endTime: "18:00",
    sourcePayloadHash: `hash:${roomName}`,
  };
}

describe("ScheduleSelectionRevalidationService", () => {
  it("회의실 예약이 바뀌면 기존 선택 대신 최신 추천을 돌려준다", async () => {
    const db = new BridgeDatabase(":memory:");
    try {
      const interviewCase = db.createInterviewCase({
        candidateName: "테스트 후보자",
        proposalDates: ["2026-08-18"],
      });
      const interviewer = db.addOrUpdateInterviewer({
        caseId: interviewCase.id,
        slackUserId: "U1",
        displayName: "면접관",
        source: "MANUAL",
      });
      db.setCaseStatus(interviewCase.id, "REQUEST_SENT");
      db.replaceAvailabilityForInterviewer(interviewCase.id, interviewer.id, [
        { date: "2026-08-18", start: "10:00", end: "11:00" },
      ]);
      db.syncMeetingRoomBlocks(["2026-08-18"], [block("[818호] 행복룸")]);
      const skills = createSkills(db);
      const previous = skills.createInterviewSchedulingDecision(interviewCase.id);
      const service = new ScheduleSelectionRevalidationService(
        db,
        {
          async listMeetingRoomBlocks() {
            return [block("[807호] 게임체인저")];
          },
        },
        skills,
      );

      const refreshed = await service.refreshIfNeeded(previous);

      expect(refreshed).toBeDefined();
      expect(refreshed?.id).not.toBe(previous.id);
      expect(refreshed?.options[0]?.label).toContain("[807호] 게임체인저");
      expect(db.getInterviewSkillDecision(previous.id)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
