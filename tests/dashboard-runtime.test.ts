// 대시보드 결정 요청의 중복 처리 동작을 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeDatabase } from "../src/db/database.js";
import { createDashboardReviewDecision, resolveDashboardDecision } from "../src/dashboard/runtime.js";

let temporaryDirectory: string | undefined;
let previousDatabasePath: string | undefined;

afterEach(() => {
  if (previousDatabasePath === undefined) {
    delete process.env.BRIDGE_DB_PATH;
  } else {
    process.env.BRIDGE_DB_PATH = previousDatabasePath;
  }
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("dashboard runtime", () => {
  it("treats a repeated submission of the same resolved decision as idempotent", async () => {
    previousDatabasePath = process.env.BRIDGE_DB_PATH;
    temporaryDirectory = mkdtempSync(join(tmpdir(), "interview-bridge-dashboard-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    const db = new BridgeDatabase(databasePath);
    const decision = db.createOrGetPendingInterviewSkillDecision({
      skillKey: "AVAILABILITY_COLLECTION",
      decisionType: "SYNC_INTERVIEWERS",
      fingerprint: "test:dashboard-runtime:idempotent",
      title: "Interviewer lookup",
      prompt: "Refresh interviewers.",
      selectionMode: "SINGLE",
      options: [
        { id: "SYNC_INTERVIEWERS", label: "Refresh", description: "Refresh interviewers." },
        { id: "HOLD", label: "Hold", description: "Keep this work pending." },
      ],
      context: {},
    });
    db.resolveInterviewSkillDecision({
      decisionId: decision.id,
      optionId: "SYNC_INTERVIEWERS",
      resolution: { action: "SYNC_INTERVIEWERS", nextAction: "NONE" },
    });
    db.close();

    process.env.BRIDGE_DB_PATH = databasePath;
    const result = await resolveDashboardDecision({
      decisionId: decision.id,
      optionId: "SYNC_INTERVIEWERS",
    });

    expect(result.decision.status).toBe("RESOLVED");
    expect(result.decision.selectedOptionId).toBe("SYNC_INTERVIEWERS");
  });

  it("creates an additional reminder draft only from the two-reminder follow-up review", async () => {
    previousDatabasePath = process.env.BRIDGE_DB_PATH;
    temporaryDirectory = mkdtempSync(join(tmpdir(), "interview-bridge-dashboard-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    const db = new BridgeDatabase(databasePath);
    const interviewCase = db.createInterviewCase({
      candidateName: "Availability candidate",
      recruitmentRef: "R-AVAILABILITY",
      recruitmentName: "Availability recruitment",
      proposalDates: ["2026-08-25"],
    });
    db.upsertRecruitmentSlackChannel({
      recruitmentId: "R-AVAILABILITY",
      recruitmentName: "Availability recruitment",
      channelId: "C1",
    });
    db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      slackUserId: "U-REMINDER",
      displayName: "Pending interviewer",
      source: "MANUAL",
    });
    db.setCaseStatus(interviewCase.id, "COLLECTING_AVAILABILITY");
    const reviewId = db.createReview({
      caseId: interviewCase.id,
      reviewType: "INTERVIEWER_NO_RESPONSE",
      reason: "Automatic reminders were sent twice.",
    });
    db.close();

    process.env.BRIDGE_DB_PATH = databasePath;
    const pending = await createDashboardReviewDecision(reviewId);
    const result = await resolveDashboardDecision({
      decisionId: pending.decision.id,
      optionId: "CREATE_ADDITIONAL_REMINDER_DRAFT",
    });

    expect(result.followUp).toMatchObject({
      kind: "AVAILABILITY_REMINDER_DRAFT_CREATED",
      draft: {
        messageType: "AVAILABILITY_REMINDER",
        status: "DRAFT",
        workflowReviewId: reviewId,
      },
    });
    const reopened = new BridgeDatabase(databasePath);
    try {
      expect(reopened.getCaseBundle(interviewCase.id)?.drafts).toEqual(expect.arrayContaining([
        expect.objectContaining({ messageType: "AVAILABILITY_REMINDER", status: "DRAFT" }),
      ]));
    } finally {
      reopened.close();
    }
  });

  it("replaces a stale room-selection decision after internal scheduling", async () => {
    previousDatabasePath = process.env.BRIDGE_DB_PATH;
    temporaryDirectory = mkdtempSync(join(tmpdir(), "interview-bridge-dashboard-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    const db = new BridgeDatabase(databasePath);
    const interviewCase = db.createInterviewCase({
      candidateName: "후보자",
      recruitmentName: "테스트 채용",
      proposalDates: ["2026-08-25"],
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    const [roomBlock] = db.syncMeetingRoomBlocks(["2026-08-25"], [{
      sourceKey: "DAOU:stale-decision-test",
      roomId: "ROOM-1",
      roomName: "행복룸",
      reservedBy: "채용 담당자",
      purpose: "인터뷰",
      date: "2026-08-25",
      startTime: "15:00",
      endTime: "16:00",
      sourcePayloadHash: "stale-decision-test",
    }]);
    const allocation = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: roomBlock!.id,
      startTime: "15:00",
      endTime: "16:00",
    });
    db.confirmInternalSchedule(interviewCase.id);
    db.createCandidateScheduleOptions({
      caseId: interviewCase.id,
      allocationIds: [allocation.id],
    });
    const decision = db.createOrGetPendingInterviewSkillDecision({
      skillKey: "INTERVIEW_SCHEDULING",
      decisionType: "CONFIRM_STANDARD_SCHEDULE",
      fingerprint: `test:stale-scheduling:${interviewCase.id}`,
      caseId: interviewCase.id,
      title: "인터뷰 시간과 회의실 선택",
      prompt: "이전 선택 화면입니다.",
      selectionMode: "MULTIPLE",
      options: [{ id: "SLOT_1", label: "2026-08-25 15:00~16:00 · 행복룸", description: "이전 추천" }],
      context: {},
    });
    db.close();

    process.env.BRIDGE_DB_PATH = databasePath;
    const result = await resolveDashboardDecision({
      decisionId: decision.id,
      optionIds: ["SLOT_1"],
    });

    expect(result.outcome).toMatchObject({
      action: "SCHEDULE_ALREADY_CONFIRMED",
      nextAction: "CREATE_CANDIDATE_SCHEDULE_PROPOSAL_DECISION",
    });
    expect(result.decision.decisionType).toBe("CANDIDATE_SCHEDULE_PROPOSAL_SENT");
    const reopened = new BridgeDatabase(databasePath);
    expect(reopened.getInterviewSkillDecision(decision.id)).toBeUndefined();
    reopened.close();
  });

  it("clears a stale room-selection decision after the candidate proposal was sent", async () => {
    previousDatabasePath = process.env.BRIDGE_DB_PATH;
    temporaryDirectory = mkdtempSync(join(tmpdir(), "interview-bridge-dashboard-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    const db = new BridgeDatabase(databasePath);
    const interviewCase = db.createInterviewCase({
      candidateName: "후보자",
      recruitmentName: "테스트 채용",
      proposalDates: ["2026-08-25"],
    });
    db.setCaseStatus(interviewCase.id, "AWAITING_CANDIDATE_CONFIRMATION");
    db.recordCandidateScheduleProposalSent(interviewCase.id);
    const decision = db.createOrGetPendingInterviewSkillDecision({
      skillKey: "INTERVIEW_SCHEDULING",
      decisionType: "CONFIRM_STANDARD_SCHEDULE",
      fingerprint: `test:stale-sent-scheduling:${interviewCase.id}`,
      caseId: interviewCase.id,
      title: "인터뷰 시간과 회의실 선택",
      prompt: "이전 선택 화면입니다.",
      selectionMode: "SINGLE",
      options: [{ id: "SLOT_1", label: "2026-08-25 15:00~16:00 · 행복룸", description: "이전 추천" }],
      context: {},
    });
    db.close();

    process.env.BRIDGE_DB_PATH = databasePath;
    const result = await resolveDashboardDecision({
      decisionId: decision.id,
      optionId: "SLOT_1",
    });

    expect(result.outcome).toMatchObject({
      action: "SCHEDULE_ALREADY_PROPOSED_TO_CANDIDATE",
      nextAction: "NONE",
    });
    const reopened = new BridgeDatabase(databasePath);
    expect(reopened.getInterviewSkillDecision(decision.id)).toBeUndefined();
    reopened.close();
  });
});
