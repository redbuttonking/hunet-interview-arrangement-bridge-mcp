// 인터뷰 업무 스킬의 공통 선택 흐름과 기존 서비스 연결을 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../src/db/database.js";
import { InterviewArrangementSkills } from "../src/skills/interview-arrangement.js";
import type { OperationalReadinessService } from "../src/services/operational-readiness.js";
import type { WorkflowService } from "../src/services/workflow.js";

let db: BridgeDatabase | undefined;

afterEach(() => db?.close());

function createSkills(input: {
  approveInterviewArrangement?: (input: {
    reviewId: string;
    routeTriggerStepId: string;
  }) => Promise<unknown>;
  syncCaseInterviewers?: (caseId: string) => Promise<unknown>;
  createRequestDraft?: (caseId: string) => Promise<unknown>;
  recordManualConfirmedInterview?: (input: Record<string, unknown>) => unknown;
  resolveCandidateInterviewAbsenceReview?: (input: Record<string, unknown>) => unknown;
  createAvailabilityRecoveryDraft?: (reviewId: string) => unknown;
} = {}) {
  const workflow = {
    approveInterviewArrangement:
      input.approveInterviewArrangement ?? (async () => ({ caseId: "created-case" })),
    syncCaseInterviewers:
      input.syncCaseInterviewers ?? (async () => ({ addedOrUpdated: 1 })),
    createRequestDraft:
      input.createRequestDraft ?? (async () => ({ id: "draft-id", status: "DRAFT" })),
    recordManualConfirmedInterview:
      input.recordManualConfirmedInterview ?? (() => ({ case: { id: "manual-case" } })),
    resolveCandidateInterviewAbsenceReview:
      input.resolveCandidateInterviewAbsenceReview ?? (() => ({ action: "HOLD" })),
    createAvailabilityRecoveryDraft:
      input.createAvailabilityRecoveryDraft ?? (() => ({ id: "recovery-draft", status: "DRAFT" })),
  } as unknown as WorkflowService;
  const readiness = {
    async inspect() {
      return { overallStatus: "READY" };
    },
  } as unknown as OperationalReadinessService;
  return new InterviewArrangementSkills(db!, workflow, readiness);
}

describe("interview arrangement skills", () => {
  it("creates and resolves a candidate triage decision without sending a message", async () => {
    db = new BridgeDatabase(":memory:");
    db.upsertRecruitmentInterviewTemplate({
      recruitmentId: "R1",
      recruitmentName: "Recruitment",
      pipelineHash: "pipeline-hash",
      steps: [
        {
          stepId: "S1",
          title: "1차 인터뷰",
          name: "1차 인터뷰",
          order: 2,
          mode: "STANDARD",
          durationMinutes: 60,
        },
      ],
      routes: [{ triggerStepId: "S1", mode: "STANDARD", stepIds: ["S1"] }],
    });
    const reviewId = db.createReview({
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "Completed evaluation requires approval.",
      summary: {
        context: {
          candidateName: "Candidate",
          recruitmentName: "Recruitment",
          recruitmentRef: "R1",
        },
      },
    });
    const calls: Array<{ reviewId: string; routeTriggerStepId: string }> = [];
    const skills = createSkills({
      async approveInterviewArrangement(input) {
        calls.push(input);
        return { caseId: "created-case" };
      },
    });

    const decision = skills.createCandidateTriageDecision(reviewId);
    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "START",
    });

    expect(calls).toEqual([{ reviewId, routeTriggerStepId: "S1" }]);
    expect(resolved).toMatchObject({
      decision: { status: "RESOLVED", selectedOptionId: "START" },
      outcome: { result: { caseId: "created-case" } },
    });
  });

  it("requires an explicit route selection when a recruitment has multiple interview routes", () => {
    db = new BridgeDatabase(":memory:");
    db.upsertRecruitmentInterviewTemplate({
      recruitmentId: "R1",
      recruitmentName: "Recruitment",
      pipelineHash: "pipeline-hash",
      steps: [
        { stepId: "S1", title: "1차", name: "1차 인터뷰", order: 2, mode: "STANDARD", durationMinutes: 60 },
        { stepId: "S2", title: "2차", name: "2차 인터뷰", order: 3, mode: "STANDARD", durationMinutes: 60 },
      ],
      routes: [
        { triggerStepId: "S1", mode: "STANDARD", stepIds: ["S1"] },
        { triggerStepId: "S2", mode: "STANDARD", stepIds: ["S2"] },
      ],
    });
    const reviewId = db.createReview({
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "Completed evaluation requires approval.",
      summary: { context: { recruitmentRef: "R1", recruitmentName: "Recruitment" } },
    });
    const skills = createSkills();

    const decision = skills.createCandidateTriageDecision(reviewId);

    expect(decision.decisionType).toBe("SELECT_INTERVIEW_ROUTE");
    expect(decision.options.map((option) => option.id)).toEqual([
      "ROUTE:S1",
      "ROUTE:S2",
      "HOLD",
    ]);
  });

  it("records a candidate triage hold without changing an external system", async () => {
    db = new BridgeDatabase(":memory:");
    db.upsertRecruitmentInterviewTemplate({
      recruitmentId: "R1",
      recruitmentName: "Recruitment",
      pipelineHash: "pipeline-hash",
      steps: [{ stepId: "S1", title: "First interview", name: "First interview", order: 2, mode: "STANDARD", durationMinutes: 60 }],
      routes: [{ triggerStepId: "S1", mode: "STANDARD", stepIds: ["S1"] }],
    });
    const reviewId = db.createReview({
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "Completed evaluation requires approval.",
      summary: { context: { candidateName: "Candidate", recruitmentRef: "R1" } },
    });
    const skills = createSkills();

    const decision = skills.createCandidateTriageDecision(reviewId);
    const resolved = await skills.resolveDecision({ decisionId: decision.id, optionId: "HOLD" });

    expect(resolved).toMatchObject({
      decision: { status: "RESOLVED", selectedOptionId: "HOLD" },
      outcome: { action: "HOLD", nextAction: "NONE" },
    });
    expect(db.getReview(reviewId)).toMatchObject({ status: "RESOLVED", resolution: "HOLD" });
    expect(db.listOpenReviews()).toEqual([]);
    expect(db.listHeldReviews()).toMatchObject([{ id: reviewId }]);
  });

  it("pauses an in-progress case when the user selects hold", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    const skills = createSkills();

    const decision = skills.createAvailabilityCollectionDecision(interviewCase.id);
    const resolved = await skills.resolveDecision({ decisionId: decision.id, optionId: "HOLD" });

    expect(resolved.outcome).toMatchObject({ action: "HOLD", case: { status: "ON_HOLD" } });
    expect(db.getCase(interviewCase.id)).toMatchObject({ status: "ON_HOLD" });
  });

  it("uses a decision to request interviewer synchronization before availability collection", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    const calls: string[] = [];
    const skills = createSkills({
      async syncCaseInterviewers(caseId) {
        calls.push(caseId);
        return { addedOrUpdated: 2 };
      },
    });

    const decision = skills.createAvailabilityCollectionDecision(interviewCase.id);
    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "SYNC_INTERVIEWERS",
    });

    expect(decision.decisionType).toBe("SYNC_INTERVIEWERS");
    expect(calls).toEqual([interviewCase.id]);
    expect(resolved.decision.status).toBe("RESOLVED");
  });

  it("confirms a selected standard interview slot without sending Slack messages", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    const interviewer = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      slackUserId: "U1",
      displayName: "Interviewer",
      source: "MANUAL",
    });
    db.setCaseStatus(interviewCase.id, "REQUEST_SENT");
    db.replaceAvailabilityForInterviewer(interviewCase.id, interviewer.id, [
      { date: "2026-08-10", start: "10:00", end: "11:00" },
    ]);
    db.syncMeetingRoomBlocks(["2026-08-10"], [
      {
        sourceKey: "DAOU:skills-test",
        roomId: "R1",
        roomName: "행복룸",
        reservedBy: "Recruiter",
        purpose: "면접",
        date: "2026-08-10",
        startTime: "09:00",
        endTime: "12:00",
        sourcePayloadHash: "skills-test",
      },
    ]);
    const skills = createSkills();

    const decision = skills.createInterviewSchedulingDecision(interviewCase.id);
    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: decision.options[0]!.id,
    });

    expect(decision.decisionType).toBe("CONFIRM_STANDARD_SCHEDULE");
    expect(resolved).toMatchObject({
      outcome: {
        schedule: {
          caseId: interviewCase.id,
          roomName: "행복룸",
          startTime: "10:00",
          endTime: "11:00",
        },
        nextAction: "CREATE_INTERVIEWER_SCHEDULE_CONFIRMATION_DRAFT",
      },
    });
    expect(db.getCase(interviewCase.id)?.status).toBe("AWAITING_CANDIDATE_CONFIRMATION");
  });

  it("records the user-selected room for a confirmed external schedule", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-12"],
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    db.recordExternallyConfirmedSchedule({
      caseId: interviewCase.id,
      notificationId: "notification-1",
      date: "2026-08-12",
      startTime: "10:00",
      endTime: "11:00",
    });
    const blocks = db.syncMeetingRoomBlocks(["2026-08-12"], [
      {
        sourceKey: "DAOU:confirmed-room:one",
        roomId: "R1",
        roomName: "열정룸",
        reservedBy: "Recruiter",
        purpose: "면접",
        date: "2026-08-12",
        startTime: "09:00",
        endTime: "12:00",
        sourcePayloadHash: "confirmed-room-one",
      },
      {
        sourceKey: "DAOU:confirmed-room:two",
        roomId: "R2",
        roomName: "행복룸",
        reservedBy: "Recruiter",
        purpose: "면접",
        date: "2026-08-12",
        startTime: "09:00",
        endTime: "12:00",
        sourcePayloadHash: "confirmed-room-two",
      },
    ]);
    const decision = db.createOrGetPendingInterviewSkillDecision({
      skillKey: "INTERVIEW_SCHEDULING",
      decisionType: "SELECT_CONFIRMED_SCHEDULE_ROOM",
      fingerprint: `case:${interviewCase.id}:confirmed-room-test`,
      caseId: interviewCase.id,
      title: "확정된 인터뷰 회의실 선택",
      prompt: "회의실을 선택하세요.",
      selectionMode: "SINGLE",
      options: [
        { id: "CONFIRMED_ROOM_0", label: "열정룸", description: "열정룸으로 기록합니다." },
        { id: "CONFIRMED_ROOM_1", label: "행복룸", description: "행복룸으로 기록합니다." },
      ],
      context: {
        choices: [
          {
            optionId: "CONFIRMED_ROOM_0",
            roomBlockId: blocks.find((block) => block.roomName === "열정룸")!.id,
            roomName: "열정룸",
            date: "2026-08-12",
            startTime: "10:00",
            endTime: "11:00",
          },
          {
            optionId: "CONFIRMED_ROOM_1",
            roomBlockId: blocks.find((block) => block.roomName === "행복룸")!.id,
            roomName: "행복룸",
            date: "2026-08-12",
            startTime: "10:00",
            endTime: "11:00",
          },
        ],
      },
    });
    const skills = createSkills();

    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "CONFIRMED_ROOM_1",
    });

    expect(resolved).toMatchObject({
      decision: { status: "RESOLVED", selectedOptionId: "CONFIRMED_ROOM_1" },
      outcome: {
        schedule: { roomName: "행복룸", startTime: "10:00", endTime: "11:00" },
        nextAction: "NONE",
      },
    });
    expect(db.getCase(interviewCase.id)?.scheduledRoomName).toBe("행복룸");
  });

  it("records a selected room for a directly confirmed NineHire schedule", async () => {
    db = new BridgeDatabase(":memory:");
    const calls: Array<Record<string, unknown>> = [];
    const skills = createSkills({
      recordManualConfirmedInterview(input) {
        calls.push(input);
        return { case: { id: "manual-case" }, schedule: { roomName: input.roomName } };
      },
    });
    const reviewId = db.createReview({
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "직접 확정된 일정을 기록합니다.",
    });
    const decision = db.createOrGetPendingInterviewSkillDecision({
      skillKey: "INTERVIEW_SCHEDULING",
      decisionType: "SELECT_NINEHIRE_CONFIRMED_SCHEDULE_ROOM",
      fingerprint: "review:direct-event:E1",
      reviewId,
      title: "직접 확정된 인터뷰 회의실 선택",
      prompt: "회의실을 선택하세요.",
      selectionMode: "SINGLE",
      options: [{ id: "NINEHIRE_CONFIRMED_ROOM_0", label: "행복룸", description: "기록" }],
      context: {
        eventId: "E1",
        date: "2099-08-05",
        startTime: "16:00",
        endTime: "17:00",
        choices: [{ optionId: "NINEHIRE_CONFIRMED_ROOM_0", roomName: "행복룸" }],
      },
    });

    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "NINEHIRE_CONFIRMED_ROOM_0",
    });

    expect(calls).toEqual([
      {
        reviewId,
        date: "2099-08-05",
        startTime: "16:00",
        endTime: "17:00",
        roomName: "행복룸",
        note: "나인하이어 직접 확정 일정 E1에서 사용자 선택으로 기록",
      },
    ]);
    expect(resolved.decision).toMatchObject({
      status: "RESOLVED",
      selectedOptionId: "NINEHIRE_CONFIRMED_ROOM_0",
    });
  });

  it("confirms a selected sequential interview plan with one continuous room block", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-11"],
    });
    const first = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      slackUserId: "U1",
      displayName: "First interviewer",
      source: "MANUAL",
    });
    const second = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      slackUserId: "U2",
      displayName: "Second interviewer",
      source: "MANUAL",
    });
    db.upsertCaseInterviewPlan({
      caseId: interviewCase.id,
      source: "CANDIDATE_OVERRIDE",
      mode: "SEQUENTIAL",
      stepIds: ["S1", "S2"],
      stepNames: ["1차 인터뷰", "2차 인터뷰"],
      interviewerIds: [first.id, second.id],
      sessions: [
        { stepId: "S1", stepName: "1차 인터뷰", interviewerIds: [first.id] },
        { stepId: "S2", stepName: "2차 인터뷰", interviewerIds: [second.id] },
      ],
      durationMinutes: 120,
    });
    db.setCaseStatus(interviewCase.id, "REQUEST_SENT");
    db.replaceAvailabilityForInterviewer(interviewCase.id, first.id, [
      { date: "2026-08-11", start: "13:00", end: "15:00" },
    ]);
    db.replaceAvailabilityForInterviewer(interviewCase.id, second.id, [
      { date: "2026-08-11", start: "13:00", end: "15:00" },
    ]);
    db.syncMeetingRoomBlocks(["2026-08-11"], [
      {
        sourceKey: "DAOU:skills-sequential",
        roomId: "R1",
        roomName: "행복룸",
        reservedBy: "Recruiter",
        purpose: "면접",
        date: "2026-08-11",
        startTime: "13:00",
        endTime: "15:00",
        sourcePayloadHash: "skills-sequential",
      },
    ]);
    const skills = createSkills();

    const decision = skills.createInterviewSchedulingDecision(interviewCase.id);
    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: decision.options[0]!.id,
    });

    expect(decision.decisionType).toBe("CONFIRM_SEQUENTIAL_SCHEDULE");
    expect(resolved).toMatchObject({
      outcome: {
        order: "NORMAL",
        allocations: [{ interviewStepId: "S1" }, { interviewStepId: "S2" }],
      },
    });
    expect(db.getCase(interviewCase.id)?.status).toBe("AWAITING_CANDIDATE_CONFIRMATION");
  });

  it("turns a candidate absence review into one recorded response decision", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    const reviewId = db.createReview({
      caseId: interviewCase.id,
      reviewType: "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED",
      reason: "Candidate reported absence.",
    });
    const actions: string[] = [];
    const skills = createSkills({
      resolveCandidateInterviewAbsenceReview(input) {
        actions.push(String(input.action));
        return { action: input.action };
      },
    });

    const decision = skills.createCandidateScheduleResponseDecision(reviewId);
    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "CANCEL",
      note: "Candidate requested cancellation.",
    });

    expect(actions).toEqual(["CANCEL"]);
    expect(resolved.decision.selectedOptionId).toBe("CANCEL");
  });

  it("records a candidate schedule proposal only after explicit user confirmation", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    db.setCaseStatus(interviewCase.id, "AWAITING_CANDIDATE_CONFIRMATION");
    const skills = createSkills();

    const decision = skills.createCandidateScheduleProposalDecision(interviewCase.id);
    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "MARK_PROPOSAL_SENT",
    });

    expect(resolved).toMatchObject({
      decision: { status: "RESOLVED", selectedOptionId: "MARK_PROPOSAL_SENT" },
      outcome: { nextAction: "NONE" },
    });
    expect(db.hasCandidateScheduleProposalSent(interviewCase.id)).toBe(true);
  });

  it("creates a recovery draft decision without sending a Slack message", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    const reviewId = db.createReview({
      caseId: interviewCase.id,
      reviewType: "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED",
      reason: "Worker downtime requires an availability check.",
    });
    const calls: string[] = [];
    const skills = createSkills({
      createAvailabilityRecoveryDraft(id) {
        calls.push(id);
        return { id: "recovery-draft", status: "DRAFT" };
      },
    });

    const decision = skills.createAvailabilityRecoveryDecision(reviewId);
    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "CREATE_RECOVERY_DRAFT",
    });

    expect(calls).toEqual([reviewId]);
    expect(resolved.outcome).toMatchObject({
      draft: { id: "recovery-draft", status: "DRAFT" },
      nextAction: "REVIEW_AND_APPROVE_AVAILABILITY_RECOVERY",
    });
  });

  it("returns one operations control payload for MCP and a future dashboard", async () => {
    db = new BridgeDatabase(":memory:");
    const skills = createSkills();

    await expect(skills.getOperationsControl()).resolves.toMatchObject({
      skillKey: "OPERATIONS_CONTROL",
      readiness: { overallStatus: "READY" },
      pendingDecisions: [],
    });
  });
});
