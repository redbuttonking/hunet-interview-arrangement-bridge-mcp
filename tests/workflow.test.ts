// 평가표 확인 후 사용자 승인으로 면접 조율 건을 만드는 흐름을 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { BridgeDatabase } from "../src/db/database.js";
import { INTERVIEW_BRIDGE_WORKER_KEY } from "../src/domain/worker-health.js";
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
                evaluators: [
                  {
                    name: "평가자",
                    items: [
                      {
                        title: "최종 평가",
                        finalEvaluation: true,
                        selectedOptions: [{ title: "⭕ 합격" }],
                      },
                    ],
                  },
                ],
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

  it("retries a temporary NineHire evaluation lookup failure from the local queue", async () => {
    db = new BridgeDatabase(":memory:");
    let attempts = 0;
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        attempts += 1;
        if (attempts === 1) throw new Error("나인하이어 일시 오류");
        return {
          context: {
            candidateRef: "A127",
            candidateName: "재시도지원자",
            recruitmentRef: "J456",
            recruitmentName: "백엔드 엔지니어",
          },
          summary: {
            applicantProgressId: "A127",
            recruitmentId: "J456",
            scoreSheets: [
              {
                scoreSheetId: "S4",
                title: "서류 평가표",
                participants: ["평가자"],
                evaluators: [
                  {
                    name: "평가자",
                    items: [
                      {
                        title: "최종 평가",
                        finalEvaluation: true,
                        selectedOptions: [{ title: "⭕ 합격" }],
                      },
                    ],
                  },
                ],
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
      payloadHash: "retry-hash",
      payloadJson: "{}",
      candidateName: "재시도지원자",
      recruitmentName: "백엔드 엔지니어",
    };

    const initial = await workflow.ingestSlackNotification({
      channelId: "C1",
      messageTs: "1.05",
      parsed,
    });
    expect(initial.result).toBe("EVALUATION_RETRY_SCHEDULED");
    const [retry] = db.listIntegrationRetryJobs({ status: "PENDING" });
    expect(retry).toBeDefined();

    await workflow.processIntegrationRetryJob(retry!);
    db.completeIntegrationRetryJob(retry!.id);
    expect(db.getIntegrationRetryJob(retry!.id)?.status).toBe("COMPLETED");
    expect(db.listOpenReviews()).toMatchObject([
      { reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED" },
    ]);
  });

  it("excludes a completed evaluation with only reject and hold decisions", async () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return {
          context: {
            candidateRef: "A124",
            candidateName: "이보류",
            recruitmentRef: "J456",
            recruitmentName: "백엔드 엔지니어",
          },
          summary: {
            applicantProgressId: "A124",
            recruitmentId: "J456",
            scoreSheets: [
              {
                scoreSheetId: "S2",
                title: "서류 평가표",
                participants: ["평가자 1", "평가자 2"],
                evaluators: [
                  {
                    name: "평가자 1",
                    items: [
                      {
                        title: "최종 평가",
                        finalEvaluation: true,
                        selectedOptions: [{ title: "❌ 불합격" }],
                      },
                    ],
                  },
                  {
                    name: "평가자 2",
                    items: [
                      {
                        title: "최종 평가",
                        finalEvaluation: true,
                        selectedOptions: [{ title: "🚫 보류" }],
                      },
                    ],
                  },
                ],
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

    const ingested = await workflow.ingestSlackNotification({
      channelId: "C1",
      messageTs: "1.1",
      parsed: {
        eventType: "EVALUATION_COMPLETED",
        title: "서류 평가가 완료되었습니다.",
        text: "서류 평가가 완료되었습니다.",
        links: [],
        payloadHash: "reject-hold-hash",
        payloadJson: "{}",
        candidateName: "이보류",
        recruitmentName: "백엔드 엔지니어",
      },
    });

    expect(ingested.result).toBe("EVALUATION_NOT_ELIGIBLE");
    expect(db.listOpenReviews()).toHaveLength(0);
    expect(db.listCases()).toHaveLength(0);
  });

  it("keeps an unrecognized final decision for manual review", async () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return {
          context: {
            candidateRef: "A126",
            candidateName: "판단필요",
            recruitmentRef: "J456",
            recruitmentName: "백엔드 엔지니어",
          },
          summary: {
            applicantProgressId: "A126",
            recruitmentId: "J456",
            scoreSheets: [
              {
                scoreSheetId: "S3",
                title: "서류 평가표",
                participants: ["평가자"],
                evaluators: [
                  {
                    name: "평가자",
                    items: [
                      {
                        title: "최종 평가",
                        finalEvaluation: true,
                        selectedOptions: [{ title: "추가 논의 필요" }],
                      },
                    ],
                  },
                ],
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

    const ingested = await workflow.ingestSlackNotification({
      channelId: "C1",
      messageTs: "1.15",
      parsed: {
        eventType: "EVALUATION_COMPLETED",
        title: "서류 평가가 완료되었습니다.",
        text: "서류 평가가 완료되었습니다.",
        links: [],
        payloadHash: "unknown-decision-hash",
        payloadJson: "{}",
        candidateName: "판단필요",
        recruitmentName: "백엔드 엔지니어",
      },
    });

    expect(ingested.result).toBe("EVALUATION_DECISION_REQUIRED");
    expect(db.listOpenReviews()).toMatchObject([
      { reviewType: "EVALUATION_DECISION_REQUIRED" },
    ]);
  });

  it("reprocesses existing reviews using the final evaluation decision", () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return { reason: "이 테스트에서는 사용하지 않습니다." };
      },
      async listInterviewers() {
        return { interviewers: [], unresolvedUserGroups: [] };
      },
      async listInProgressRecruitments() {
        return { count: 0, limit: 100, offset: 0, recruitments: [] };
      },
    };
    const workflow = new WorkflowService(db, config, ninehire);
    const notification = db.insertNotification({
      channelId: "C1",
      messageTs: "1.2",
      eventType: "EVALUATION_COMPLETED",
      title: "서류 평가가 완료되었습니다.",
      payloadHash: "existing-reject-hold-hash",
      payloadJson: "{}",
    }, "AWAITING_START_APPROVAL");
    const reviewId = db.createReview({
      notificationId: notification.id,
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "기존 검토 건",
      summary: {
        context: {
          candidateRef: "A125",
          candidateName: "기존보류",
          recruitmentRef: "J456",
          recruitmentName: "백엔드 엔지니어",
        },
        evaluation: {
          applicantProgressId: "A125",
          recruitmentId: "J456",
          scoreSheets: [
            {
              scoreSheetId: "S3",
              title: "서류 평가표",
              participants: ["평가자"],
              evaluators: [
                {
                  name: "평가자",
                  items: [
                    {
                      title: "최종 평가",
                      finalEvaluation: true,
                      selectedOptions: [{ title: "❌ 불합격" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });

    expect(workflow.reprocessInterviewArrangementEligibilityReviews()).toEqual({
      scanned: 1,
      eligible: 0,
      excluded: 1,
      decisionRequired: 0,
    });
    expect(db.getReview(reviewId)).toMatchObject({
      status: "RESOLVED",
      resolution: "AUTO_EXCLUDED_NO_PASS",
    });
    expect(db.listOpenReviews()).toHaveLength(0);
  });

  it("creates a recovery draft only for pending interviewers after worker downtime", () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return { reason: "이 테스트에서는 사용하지 않습니다." };
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
      displayName: "미제출 면접관",
      slackUserId: "U1",
      source: "MANUAL",
    });
    const submittedInterviewer = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "제출 면접관",
      slackUserId: "U2",
      source: "MANUAL",
    });
    db.replaceAvailabilityForInterviewer(interviewCase.id, submittedInterviewer.id, [
      { date: "2026-07-30", start: "09:00", end: "10:00" },
    ]);
    db.setCaseStatus(interviewCase.id, "COLLECTING_AVAILABILITY");

    db.registerWorkerStart({
      workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
      now: new Date("2026-07-30T00:00:00.000Z"),
      downtimeThresholdMs: 90_000,
    });
    const workerRestart = db.registerWorkerStart({
      workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
      now: new Date("2026-07-30T00:02:00.000Z"),
      downtimeThresholdMs: 90_000,
    });
    expect(workerRestart.downtime).toMatchObject({ durationMs: 120_000 });

    const recovery = workflow.createWorkerDowntimeReviews(workerRestart.downtime!);
    expect(recovery.impactedCaseIds).toEqual([interviewCase.id]);
    const draft = workflow.createAvailabilityRecoveryDraft(recovery.reviewIds[0]!);

    expect(draft).toMatchObject({
      caseId: interviewCase.id,
      messageType: "AVAILABILITY_RECOVERY",
      workflowReviewId: recovery.reviewIds[0],
      status: "DRAFT",
    });
    expect(draft.blocksJson).toContain("<@U1>");
    expect(draft.blocksJson).not.toContain("<@U2>");

    db.approveDraft(draft.id);
    db.markDraftSent(draft.id, "30.0");
    expect(db.getReview(recovery.reviewIds[0]!)).toMatchObject({
      status: "RESOLVED",
      resolution: "AVAILABILITY_RECOVERY_SENT",
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

  it("confirms a schedule and requires review for a candidate absence message", async () => {
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

    const absence = await workflow.ingestSlackNotification({
      channelId: "C1",
      messageTs: "10.1",
      parsed: {
        eventType: "CANDIDATE_INTERVIEW_ABSENCE",
        title: "지원자로부터 메시지가 도착했습니다.",
        text: "테스트1 지원자 일정에 불참합니다.",
        links: [],
        payloadHash: "candidate-absence",
        payloadJson: "{}",
        candidateName: "테스트1",
        recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
      },
    });

    expect(absence).toMatchObject({
      result: "CANDIDATE_ATTENDANCE_REVIEW_REQUIRED",
      caseId,
    });
    expect(db.getCase(caseId)?.status).toBe("REVIEW_REQUIRED");
    expect(db.listRoomAllocations(caseId)[0]?.status).toBe("ACTIVE");
    const review = db.listOpenReviews().find(
      (item) => item.reviewType === "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED",
    );
    expect(review).toBeDefined();

    expect(
      workflow.resolveCandidateInterviewAbsenceReview({
        reviewId: review!.id,
        action: "HOLD",
      }),
    ).toMatchObject({ reviewOpen: true, caseId });
    expect(db.getReview(review!.id)?.status).toBe("OPEN");

    expect(
      workflow.resolveCandidateInterviewAbsenceReview({
        reviewId: review!.id,
        action: "RESCHEDULE_USING_EXISTING_AVAILABILITY",
      }),
    ).toMatchObject({
      reviewOpen: false,
      outcome: { interviewCase: { status: "READY_TO_SCHEDULE" } },
    });
    expect(db.getReview(review!.id)?.status).toBe("RESOLVED");
    expect(db.listRoomAllocations(caseId)[0]?.status).toBe("CANCELLED");
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

  it("reprocesses stored schedule confirmation and candidate absence notifications", async () => {
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

    const confirmedCase = db.getCase(caseId)!;

    const absenceText =
      "지원자로부터 메시지가 도착했습니다.\n테스트1 지원자 일정에 불참합니다.";
    await workflow.ingestSlackNotification({
      channelId: "C1",
      messageTs: "12.1",
      parsed: {
        eventType: "CANDIDATE_MESSAGE",
        title: "지원자로부터 메시지가 도착했습니다.",
        text: absenceText,
        links: [],
        payloadHash: "stored-candidate-absence",
        payloadJson: JSON.stringify({ text: absenceText }),
        candidateName: confirmedCase.candidateName!,
        recruitmentName: confirmedCase.recruitmentName!,
      },
    });

    expect(workflow.reprocessCandidateInterviewAbsenceNotifications()).toEqual({
      scanned: 1,
      reviewRequired: 1,
    });
    expect(db.getCase(caseId)?.status).toBe("REVIEW_REQUIRED");
  });

  it("replaces one text field in a pending Slack draft without sending it", () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return { reason: "Not used in this test." };
      },
      async listInterviewers() {
        return { interviewers: [], unresolvedUserGroups: [] };
      },
      async listInProgressRecruitments() {
        return { count: 0, limit: 100, offset: 0, recruitments: [] };
      },
    };
    const workflow = new WorkflowService(db, config, ninehire);
    const interviewCase = db.createInterviewCase({
      candidateName: "테스트1",
      recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
      proposalDates: ["2026-07-27"],
    });
    const draft = db.createDraft({
      caseId: interviewCase.id,
      channelId: "C1",
      previewText: "테스트1 지원자 인터뷰 일정 취소 안내",
      blocksJson: JSON.stringify([
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "인터뷰가 취소되었습니다. 기존 일정에 참석하지 않아도 됩니다.",
            },
          ],
        },
      ]),
      payloadHash: "before-revision",
      messageType: "SCHEDULE_CANCELLATION",
    });

    const revised = workflow.replacePendingDraftText({
      draftId: draft.id,
      textToReplace: "인터뷰가 취소되었습니다. 기존 일정에 참석하지 않아도 됩니다.",
      replacementText: "인터뷰가 취소되었습니다. 일정에 참조 부탁드립니다.",
    });

    expect(revised.status).toBe("DRAFT");
    expect(revised.payloadHash).not.toBe("before-revision");
    expect(revised.blocksJson).toContain("일정에 참조 부탁드립니다.");
  });

  it("creates external follow-ups when an interview is cancelled", () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return { reason: "Not used in this test." };
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
      candidateName: "테스트1",
      recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
      proposalDates: ["2026-07-27"],
    });

    const cancelled = workflow.cancelInterviewArrangement({
      caseId: interviewCase.id,
      reason: "후보자 불참으로 취소합니다.",
    });

    expect(cancelled).toMatchObject({
      interviewCase: { status: "CANCELLED" },
      cancellationExternalFollowUps: [
        { followUpType: "NINEHIRE_CANDIDATE_SCHEDULE", status: "PENDING" },
      ],
    });
  });
});
