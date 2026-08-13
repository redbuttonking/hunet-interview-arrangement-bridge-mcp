// 다우오피스 캘린더 확정 일정의 로컬 상태 반영을 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { BridgeDatabase } from "../src/db/database.js";
import type { DaouInterviewCalendarEvent } from "../src/domain/daou-calendar.js";
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
      proposalDates: ["2099-08-04"],
    });
    const [block] = db.syncMeetingRoomBlocks(["2099-08-04"], [{
      sourceKey: "DAOU:calendar-test",
      roomId: "R1",
      roomName: "[818호] 행복룸",
      reservedBy: "강해빈",
      purpose: "면접",
      date: "2099-08-04",
      startTime: "16:00",
      endTime: "18:00",
      sourcePayloadHash: "calendar-test",
    }]);
    db.allocateRoomBlock({ caseId: interviewCase.id, roomBlockId: block!.id, startTime: "16:00", endTime: "17:00" });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    db.confirmInternalSchedule(interviewCase.id);

    let calendarEvents: DaouInterviewCalendarEvent[] = [{
      sourceEventId: "DAOU_CALENDAR:event-1",
      title: "[면접] 인터뷰 어레인지 자동화 테스트 채용 (테스트 6)",
      recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
      candidateName: "테스트 6",
      date: "2099-08-04",
      startTime: "16:00",
      endTime: "17:00",
      rawText: "calendar",
    }];
    const calendar: DaouOfficeCalendarAdapter = {
      async listInterviewCalendarEvents() {
        return calendarEvents;
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
    expect(db.listExternalConfirmedInterviews()).toMatchObject([{
      candidateName: "테스트 6",
      linkedCaseId: interviewCase.id,
    }]);
    await expect(workflow.reconcileDaouCalendarConfirmedSchedules(calendar)).resolves.toMatchObject({ alreadyConfirmed: 1, confirmedCases: 0 });
    expect(db.listCaseEvents(interviewCase.id).filter((event) => event.eventType === "CANDIDATE_SCHEDULE_CONFIRMED")).toHaveLength(1);

    calendarEvents = [{
      ...calendarEvents[0]!,
      date: "2099-08-05",
      startTime: "10:00",
      endTime: "11:00",
      roomName: "[818호] 행복룸",
    }];
    await expect(workflow.reconcileDaouCalendarConfirmedSchedules(calendar)).resolves.toMatchObject({
      matchedCases: 1,
      confirmedCases: 1,
    });
    expect(db.getCase(interviewCase.id)).toMatchObject({
      scheduledDate: "2099-08-05",
      scheduledStartTime: "10:00",
      scheduledEndTime: "11:00",
      scheduledRoomName: "[818호] 행복룸",
    });
  });

  it("records an unmatched calendar interview without creating a candidate case", async () => {
    db = new BridgeDatabase(":memory:");
    const workflow = new WorkflowService(db, config, {
      async lookupCompletedEvaluation() { return { reason: "Not used in this test." }; },
      async listInterviewers() { return { interviewers: [], unresolvedUserGroups: [] }; },
      async listInProgressRecruitments() { return { count: 0, limit: 100, offset: 0, recruitments: [] }; },
    });
    const calendar: DaouOfficeCalendarAdapter = {
      async listInterviewCalendarEvents() {
        return [{
          sourceEventId: "DAOU_CALENDAR:unmatched-event",
          title: "[면접] 데이터 엔지니어 인터뷰 (테스트 후보자)",
          recruitmentName: "데이터 엔지니어 인터뷰",
          candidateName: "테스트 후보자",
          date: "2099-08-12",
          startTime: "14:00",
          endTime: "15:00",
          rawText: "calendar",
        }];
      },
    };

    await expect(workflow.reconcileDaouCalendarConfirmedSchedules(calendar)).resolves.toMatchObject({
      scannedEvents: 1,
      recordedEvents: 1,
      matchedCases: 0,
    });
    expect(db.listCases()).toHaveLength(0);
    expect(db.listExternalConfirmedInterviews()).toMatchObject([{
      candidateName: "테스트 후보자",
      linkedCaseId: null,
    }]);
  });

  it("과거 다우오피스 일정은 저장하지 않고 기존 과거 기록도 정리한다", async () => {
    db = new BridgeDatabase(":memory:");
    db.syncExternalConfirmedInterviews([{
      sourceEventId: "DAOU_CALENDAR:past-event",
      title: "[면접] 과거 채용 (과거 후보자)",
      recruitmentName: "과거 채용",
      candidateName: "과거 후보자",
      date: "2000-01-01",
      startTime: "10:00",
      endTime: "11:00",
      rawText: "calendar",
    }]);
    const workflow = new WorkflowService(db, config, {
      async lookupCompletedEvaluation() { return { reason: "Not used in this test." }; },
      async listInterviewers() { return { interviewers: [], unresolvedUserGroups: [] }; },
      async listInProgressRecruitments() { return { count: 0, limit: 100, offset: 0, recruitments: [] }; },
    });
    const calendar: DaouOfficeCalendarAdapter = {
      async listInterviewCalendarEvents() {
        return [{
          sourceEventId: "DAOU_CALENDAR:past-only",
          title: "[면접] 과거 채용 (과거 후보자)",
          recruitmentName: "과거 채용",
          candidateName: "과거 후보자",
          date: "2000-01-02",
          startTime: "10:00",
          endTime: "11:00",
          rawText: "calendar",
        }];
      },
    };

    await expect(workflow.reconcileDaouCalendarConfirmedSchedules(calendar)).resolves.toMatchObject({
      scannedEvents: 0,
      recordedEvents: 0,
      skippedPastEvents: 1,
      removedPastRecords: 1,
    });
    expect(db.listExternalConfirmedInterviews()).toHaveLength(0);
  });

  it("confirms an open scheduling review from a calendar event even when its title uses a shortened recruitment name", async () => {
    db = new BridgeDatabase(":memory:");
    const notification = db.insertNotification({
      channelId: "C1",
      messageTs: "calendar-direct.1",
      eventType: "EVALUATION_COMPLETED",
      title: "평가표 제출이 완료되었습니다.",
      payloadHash: "calendar-direct-hash",
      payloadJson: "{}",
    }, "AWAITING_START_APPROVAL");
    const reviewId = db.createReview({
      notificationId: notification.id,
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "CEO 인터뷰 조율 승인이 필요합니다.",
      summary: {
        context: {
          candidateRef: "A-calendar-direct",
          candidateName: "캘린더 직접 확정 지원자",
          recruitmentRef: "R-calendar-direct",
          recruitmentName: "[휴넷] 긴 전체 채용명 [정규직]",
        },
        evaluation: {
          applicantProgressId: "A-calendar-direct",
          recruitmentId: "R-calendar-direct",
          scoreSheets: [],
        },
      },
    });
    const staleRoomReviewId = db.createReview({
      reviewType: "NINEHIRE_CONFIRMED_SCHEDULE_ROOM_SYNC_REQUIRED",
      reason: "회의실 동기화가 필요합니다.",
      summary: {
        reviewId,
        eventId: "NINEHIRE:direct-review",
        candidateRef: "A-calendar-direct",
        candidateName: "캘린더 직접 확정 지원자",
        recruitmentRef: "R-calendar-direct",
        date: "2099-08-18",
        startTime: "16:00",
        endTime: "17:00",
      },
    });
    const staleDecision = db.createOrGetPendingInterviewSkillDecision({
      skillKey: "INTERVIEW_SCHEDULING",
      decisionType: "SELECT_NINEHIRE_CONFIRMED_SCHEDULE_ROOM",
      fingerprint: "calendar-direct-stale-room-selection",
      reviewId,
      title: "기존 회의실 선택",
      prompt: "더 이상 선택할 필요가 없습니다.",
      selectionMode: "SINGLE",
      options: [{ id: "ROOM", label: "열정룸", description: "테스트" }],
      context: {},
    });
    const calendar: DaouOfficeCalendarAdapter = {
      async listInterviewCalendarEvents() {
        return [{
          sourceEventId: "DAOU_CALENDAR:direct-review",
          title: "[면접] 짧은 CEO 인터뷰 제목 (캘린더 직접 확정 지원자)",
          recruitmentName: "짧은 CEO 인터뷰 제목",
          candidateName: "캘린더 직접 확정 지원자",
          date: "2099-08-18",
          startTime: "16:00",
          endTime: "17:00",
          roomName: "[818호] 열정룸",
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
      matchedCases: 1,
      confirmedCases: 1,
    });
    expect(db.getReview(reviewId)?.resolution).toBe("DAOU_OFFICE_CALENDAR_CONFIRMED");
    expect(db.getReview(staleRoomReviewId)?.status).toBe("RESOLVED");
    expect(db.getInterviewSkillDecision(staleDecision.id)).toBeUndefined();
    expect(db.listCases("CONFIRMED")).toMatchObject([{
      candidateName: "캘린더 직접 확정 지원자",
      scheduledDate: "2099-08-18",
      scheduledStartTime: "16:00",
      scheduledEndTime: "17:00",
      scheduledRoomName: "[818호] 열정룸",
    }]);
    expect(db.listExternalConfirmedInterviews()).toMatchObject([{
      sourceEventId: "DAOU_CALENDAR:direct-review",
      linkedCaseId: expect.any(String),
    }]);
  });
});
