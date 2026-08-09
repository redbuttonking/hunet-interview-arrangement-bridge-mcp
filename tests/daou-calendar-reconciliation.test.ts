// 다우오피스 캘린더 확정 일정의 로컬 상태 반영을 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { BridgeDatabase } from "../src/db/database.js";
import type { DaouOfficeCalendarAdapter } from "../src/domain/daou-office.js";
import { WorkflowService } from "../src/services/workflow.js";

let db: BridgeDatabase | undefined;
afterEach(() => db?.close());

const config: AppConfig = {
  dbPath: ":memory:",
  pollIntervalMs: 300_000,
  timeZone: "Asia/Seoul",
  daouOffice: {
    url: "https://hug.hunet.co.kr/app/asset",
    browserProfileDir: "C:/temp/daou-profile",
    remoteDebugPort: 9222,
    chromeExecutablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  },
  slack: {},
  ninehire: { url: "https://example.invalid/mcp", authHeader: "Authorization", authScheme: "Bearer", timeoutMs: 30_000 },
};

describe("DaouOffice calendar reconciliation", () => {
  it("confirms a matching candidate proposal and remains idempotent", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "테스트 6",
      recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
      proposalDates: ["2026-08-04"],
    });
    const [block] = db.syncMeetingRoomBlocks(["2026-08-04"], [{
      sourceKey: "DAOU:calendar-test",
      roomId: "R1",
      roomName: "[818호] 행복룸",
      reservedBy: "강해빈",
      purpose: "면접",
      date: "2026-08-04",
      startTime: "16:00",
      endTime: "18:00",
      sourcePayloadHash: "calendar-test",
    }]);
    db.allocateRoomBlock({ caseId: interviewCase.id, roomBlockId: block!.id, startTime: "16:00", endTime: "17:00" });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    db.confirmInternalSchedule(interviewCase.id);

    const calendar: DaouOfficeCalendarAdapter = {
      async listInterviewCalendarEvents() {
        return [{
          sourceEventId: "DAOU_CALENDAR:event-1",
          title: "[면접] 인터뷰 어레인지 자동화 테스트 채용 (테스트 6)",
          recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
          candidateName: "테스트 6",
          date: "2026-08-04",
          startTime: "16:00",
          endTime: "17:00",
          rawText: "calendar",
        }];
      },
    };
    const workflow = new WorkflowService(db, config, {
      async lookupCompletedEvaluation() { return { reason: "Not used in this test." }; },
      async listInterviewers() { return { interviewers: [], unresolvedUserGroups: [] }; },
      async listInProgressRecruitments() { return { count: 0, limit: 100, offset: 0, recruitments: [] }; },
    });

    await expect(workflow.reconcileDaouCalendarConfirmedSchedules(calendar)).resolves.toMatchObject({
      scannedEvents: 1,
      matchedCases: 1,
      confirmedCases: 1,
    });
    expect(db.getCase(interviewCase.id)?.status).toBe("CONFIRMED");
    await expect(workflow.reconcileDaouCalendarConfirmedSchedules(calendar)).resolves.toMatchObject({ alreadyConfirmed: 1, confirmedCases: 0 });
    expect(db.listCaseEvents(interviewCase.id).filter((event) => event.eventType === "CANDIDATE_SCHEDULE_CONFIRMED")).toHaveLength(1);
  });
});
