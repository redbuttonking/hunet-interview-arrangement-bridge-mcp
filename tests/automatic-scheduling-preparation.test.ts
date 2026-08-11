// 면접관 일정 제출 완료 뒤 자동 일정 추천 준비를 검증한다.
import { describe, expect, it } from "vitest";
import { BridgeDatabase } from "../src/db/database.js";
import type { MeetingRoomBlockInput } from "../src/domain/daou-office.js";
import { AutomaticSchedulingPreparationService } from "../src/services/automatic-scheduling-preparation.js";
import { InterviewArrangementSkills } from "../src/skills/interview-arrangement.js";

function createSkills(db: BridgeDatabase) {
  return new InterviewArrangementSkills(db, {} as never, {} as never);
}

function block(date: string): MeetingRoomBlockInput {
  return {
    sourceKey: `DAOU:${date}:1`,
    roomId: "1",
    roomName: "[818호] 행복룸",
    reservedBy: "강해빈",
    purpose: "면접",
    date,
    startTime: "09:00",
    endTime: "18:00",
    sourcePayloadHash: `hash:${date}`,
  };
}

describe("AutomaticSchedulingPreparationService", () => {
  it("전원 제출 후 회의실을 새로 읽고 승인용 일정 추천을 만든다", async () => {
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
      db.createOrGetPendingInterviewSkillDecision({
        skillKey: "AVAILABILITY_COLLECTION",
        decisionType: "WAIT_FOR_AVAILABILITY",
        fingerprint: `case:${interviewCase.id}:waiting`,
        caseId: interviewCase.id,
        title: "일정 제출 대기",
        prompt: "대기",
        selectionMode: "SINGLE",
        options: [{ id: "WAIT", label: "대기", description: "대기" }],
        context: {},
      });
      const service = new AutomaticSchedulingPreparationService(
        db,
        {
          async listMeetingRoomBlocks() {
            return [block("2026-08-18")];
          },
        },
        createSkills(db),
      );

      const results = await service.prepareReadyCases();

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        roomSync: "SYNCED",
        decision: { decisionType: "CONFIRM_STANDARD_SCHEDULE" },
      });
      expect(
        db.listInterviewSkillDecisions({ status: "PENDING" }).some(
          (decision) => decision.skillKey === "AVAILABILITY_COLLECTION",
        ),
      ).toBe(false);
      expect(db.areMeetingRoomDatesSynced(["2026-08-18"])).toBe(true);
    } finally {
      db.close();
    }
  });

  it("회의실을 확인하지 못하면 시간 추천 대신 확인 요청을 만든다", async () => {
    const db = new BridgeDatabase(":memory:");
    try {
      const interviewCase = db.createInterviewCase({
        candidateName: "테스트 후보자",
        proposalDates: ["2026-08-18"],
      });
      db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
      const service = new AutomaticSchedulingPreparationService(
        db,
        {
          async listMeetingRoomBlocks() {
            throw new Error("브라우저 연결 없음");
          },
        },
        createSkills(db),
      );

      const [result] = await service.prepareReadyCases();

      expect(result).toMatchObject({
        roomSync: "UNAVAILABLE",
        decision: { decisionType: "MEETING_ROOM_SYNC_UNAVAILABLE" },
      });
    } finally {
      db.close();
    }
  });
});
