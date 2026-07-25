// 평가표 확인 후 사용자 승인으로 면접 조율 건을 만드는 흐름을 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { BridgeDatabase } from "../src/db/database.js";
import type { NinehireWorkflowAdapter } from "../src/ninehire/adapter.js";
import { WorkflowService } from "../src/services/workflow.js";
import type { ParsedSlackNotification } from "../src/slack/parser.js";

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
    edgeExecutablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  },
  slack: {},
  ninehire: {
    url: "https://example.invalid/mcp",
    authHeader: "Authorization",
    authScheme: "Bearer",
  },
};

function createAwaitingCandidateConfirmationCase(
  database: BridgeDatabase,
  candidateName: string,
): string {
  const interviewCase = database.createInterviewCase({
    candidateName,
    recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
    proposalDates: ["2026-07-27"],
  });
  const [block] = database.syncMeetingRoomBlocks(
    ["2026-07-27"],
    [
      {
        sourceKey: `DAOU:${candidateName}`,
        roomId: "103",
        roomName: "[818호] 행복룸",
        reservedBy: "강해빈",
        purpose: "면접",
        date: "2026-07-27",
        startTime: "15:00",
        endTime: "18:00",
        sourcePayloadHash: `hash:${candidateName}`,
      },
    ],
  );
  database.allocateRoomBlock({
    caseId: interviewCase.id,
    roomBlockId: block!.id,
    startTime: "15:00",
    endTime: "16:00",
  });
  database.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
  database.confirmInternalSchedule(interviewCase.id);
  return interviewCase.id;
}

describe("evaluation approval workflow", () => {
  it("waits for user approval before creating an interview case", async () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return {
          context: {
            candidateRef: "A123",
            candidateName: "김지원",
            recruitmentRef: "J456",
            recruitmentName: "백엔드 엔지니어",
          },
          summary: {
            applicantProgressId: "A123",
            recruitmentId: "J456",
            scoreSheets: [
              {
                scoreSheetId: "S1",
                title: "서류 평가표",
                participants: ["평가자"],
                evaluators: [],
              },
            ],
          },
        };
      },
      async listInterviewers() {
        return { interviewers: [], unresolvedUserGroups: [] };
      },
      async listInProgressRecruitments() {
        return { count: 0, limit: 100, offset: 0, recruitments: [] };
      },
    };
    const workflow = new WorkflowService(db, config, ninehire);
    const parsed: ParsedSlackNotification = {
      eventType: "EVALUATION_COMPLETED",
      title: "서류 평가가 완료되었습니다.",
      text: "서류 평가가 완료되었습니다.",
      links: [],
      payloadHash: "hash",
      payloadJson: "{}",
      candidateName: "김지원",
      recruitmentName: "백엔드 엔지니어",
    };

    const ingested = await workflow.ingestSlackNotification({
      channelId: "C1",
      messageTs: "1.0",
      parsed,
    });
    expect(ingested.result).toBe("EVALUATION_READY_FOR_APPROVAL");
    expect(db.listCases()).toHaveLength(0);

    const review = db.listOpenReviews()[0];
    expect(review?.reviewType).toBe("INTERVIEW_ARRANGEMENT_START_REQUIRED");
    expect(review?.summary).toMatchObject({
      evaluation: { scoreSheets: [{ title: "서류 평가표" }] },
    });

    const approved = await workflow.approveInterviewArrangement(review!.id);
    expect(approved.result).toBe("INTERVIEW_CASE_CREATED");
    expect(db.getCase(approved.caseId)).toMatchObject({
      candidateRef: "A123",
      recruitmentRef: "J456",
      status: "READY_FOR_DRAFT",
    });
  });

  it("adds direct recruitment participants and flags unresolved user groups", async () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return { reason: "이 테스트에서는 사용하지 않습니다." };
      },
      async listInterviewers() {
        return {
          interviewers: [
            {
              ninehireUserId: "N1",
              displayName: "면접관",
              email: "interviewer@example.com",
              required: true,
            },
          ],
          unresolvedUserGroups: ["개발팀"],
        };
      },
      async listInProgressRecruitments() {
        return { count: 0, limit: 100, offset: 0, recruitments: [] };
      },
    };
    const workflow = new WorkflowService(db, config, ninehire);
    const interviewCase = db.createInterviewCase({
      candidateName: "김지원",
      recruitmentRef: "J456",
      recruitmentName: "백엔드 엔지니어",
      proposalDates: ["2026-07-30"],
    });

    const result = await workflow.syncCaseInterviewers(interviewCase.id);

    expect(result).toMatchObject({
      addedOrUpdated: 1,
      unresolvedUserGroups: ["개발팀"],
    });
    expect(db.listInterviewers(interviewCase.id)).toMatchObject([
      { displayName: "면접관", required: true },
    ]);
    expect(db.listOpenReviews()).toMatchObject([
      { reviewType: "INTERVIEWER_GROUP_MEMBERS_REQUIRED" },
    ]);

    await workflow.syncCaseInterviewers(interviewCase.id);
    expect(db.listOpenReviews()).toHaveLength(1);
  });

  it("creates an internal schedule confirmation draft without sending Slack", () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return { reason: "테스트에서는 사용하지 않습니다." };
      },
      async listInterviewers() {
        return { interviewers: [], unresolvedUserGroups: [] };
      },
      async listInProgressRecruitments() {
        return { count: 0, limit: 100, offset: 0, recruitments: [] };
      },
    };
    const workflow = new WorkflowService(
      db,
      { ...config, slack: { requestChannelId: "C1" } },
      ninehire,
    );
    const interviewCase = db.createInterviewCase({
      candidateName: "지원자 1",
      recruitmentName: "테스트 채용",
      proposalDates: ["2026-07-30"],
    });
    db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "면접관 1",
      slackUserId: "U1",
      source: "MANUAL",
    });
    const [block] = db.syncMeetingRoomBlocks(
      ["2026-07-30"],
      [
        {
          sourceKey: "DAOU:workflow",
          roomId: "103",
          roomName: "[818호] 행복룸",
          reservedBy: "강해빈",
          purpose: "면접",
          date: "2026-07-30",
          startTime: "15:00",
          endTime: "18:00",
          sourcePayloadHash: "workflow-hash",
        },
      ],
    );
    db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: block!.id,
      startTime: "15:00",
      endTime: "16:00",
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    workflow.confirmInternalSchedule(interviewCase.id);

    const draft = workflow.createScheduleConfirmationDraft(interviewCase.id);

    expect(draft).toMatchObject({
      channelId: "C1",
      messageType: "SCHEDULE_CONFIRMATION",
      status: "DRAFT",
    });
    expect(draft.previewText).toContain("내부 일정 확정 안내");
    expect(db.getCase(interviewCase.id)?.status).toBe(
      "AWAITING_CANDIDATE_CONFIRMATION",
    );

    db.approveDraft(draft.id);
    db.markDraftSent(draft.id, "20.0");
    const reopened = workflow.reopenInterviewSchedule({
      caseId: interviewCase.id,
      availabilityPolicy: "RECOLLECT",
      reason: "후보자 일정 변경 요청",
    });
    expect(reopened).toMatchObject({
      interviewCase: { status: "READY_FOR_DRAFT", scheduleRound: 2 },
      scheduleUpdateDraft: {
        messageType: "SCHEDULE_CHANGE",
        status: "DRAFT",
      },
    });
  });

  it("confirms an internally scheduled case from a matching NineHire Slack notification", async () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return { reason: "테스트에서는 사용하지 않습니다." };
      },
      async listInterviewers() {
        return { interviewers: [], unresolvedUserGroups: [] };
      },
      async listInProgressRecruitments() {
        return { count: 0, limit: 100, offset: 0, recruitments: [] };
      },
    };
    const workflow = new WorkflowService(
      db,
      { ...config, slack: { requestChannelId: "C1" } },
      ninehire,
    );
    const caseId = createAwaitingCandidateConfirmationCase(db, "테스트1");

    const processed = await workflow.ingestSlackNotification({
      channelId: "C1",
      messageTs: "10.0",
      parsed: {
        eventType: "SCHEDULE_CONFIRMED",
        title: "일정이 확정되었습니다",
        text: "일정이 확정되었습니다",
        links: [],
        payloadHash: "schedule-confirmed",
        payloadJson: "{}",
        candidateName: "테스트1",
        recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
        scheduledDate: "2026-07-27",
        scheduledStartTime: "15:00",
        scheduledEndTime: "16:00",
        location: "회사 주소",
      },
    });

    expect(processed).toMatchObject({
      result: "INTERVIEW_CONFIRMED",
      caseId,
    });
    expect(db.getCase(caseId)?.status).toBe("CONFIRMED");
    expect(workflow.createScheduleConfirmationDraft(caseId).previewText).toBe(
      "테스트1 지원자 인터뷰 일정 확정 안내",
    );
  });

  it("requires review when a confirmed Slack schedule differs from the internal schedule", async () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return { reason: "테스트에서는 사용하지 않습니다." };
      },
      async listInterviewers() {
        return { interviewers: [], unresolvedUserGroups: [] };
      },
      async listInProgressRecruitments() {
        return { count: 0, limit: 100, offset: 0, recruitments: [] };
      },
    };
    const workflow = new WorkflowService(db, config, ninehire);
    const caseId = createAwaitingCandidateConfirmationCase(db, "테스트2");

    const processed = await workflow.ingestSlackNotification({
      channelId: "C1",
      messageTs: "11.0",
      parsed: {
        eventType: "SCHEDULE_CONFIRMED",
        title: "일정이 확정되었습니다",
        text: "일정이 확정되었습니다",
        links: [],
        payloadHash: "schedule-mismatch",
        payloadJson: "{}",
        candidateName: "테스트2",
        recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
        scheduledDate: "2026-07-27",
        scheduledStartTime: "16:00",
        scheduledEndTime: "17:00",
      },
    });

    expect(processed).toMatchObject({ result: "REVIEW_REQUIRED", caseId });
    expect(db.getCase(caseId)?.status).toBe("REVIEW_REQUIRED");
    expect(db.listOpenReviews()).toMatchObject([
      { reviewType: "SCHEDULE_CONFIRMATION_MISMATCH" },
    ]);
  });

  it("reprocesses a stored schedule confirmation after adding the detection rule", async () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return { reason: "테스트에서는 사용하지 않습니다." };
      },
      async listInterviewers() {
        return { interviewers: [], unresolvedUserGroups: [] };
      },
      async listInProgressRecruitments() {
        return { count: 0, limit: 100, offset: 0, recruitments: [] };
      },
    };
    const workflow = new WorkflowService(db, config, ninehire);
    const caseId = createAwaitingCandidateConfirmationCase(db, "테스트3");
    const text = "일정이 확정되었습니다\n2026. 07. 27. 월요일 15:00 - 16:00";

    await workflow.ingestSlackNotification({
      channelId: "C1",
      messageTs: "12.0",
      parsed: {
        eventType: "OTHER",
        title: "OTHER",
        text,
        links: [],
        payloadHash: "stored-schedule-confirmed",
        payloadJson: JSON.stringify({ text }),
        candidateName: "테스트3",
        recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
      },
    });

    expect(workflow.reprocessScheduleConfirmationNotifications()).toEqual({
      scanned: 1,
      confirmed: 1,
      reviewRequired: 0,
    });
    expect(db.getCase(caseId)?.status).toBe("CONFIRMED");
  });
});
