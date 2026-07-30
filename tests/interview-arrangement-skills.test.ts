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
  resolveCandidateInterviewAbsenceReview?: (input: Record<string, unknown>) => unknown;
} = {}) {
  const workflow = {
    approveInterviewArrangement:
      input.approveInterviewArrangement ?? (async () => ({ caseId: "created-case" })),
    syncCaseInterviewers:
      input.syncCaseInterviewers ?? (async () => ({ addedOrUpdated: 1 })),
    createRequestDraft:
      input.createRequestDraft ?? (async () => ({ id: "draft-id", status: "DRAFT" })),
    resolveCandidateInterviewAbsenceReview:
      input.resolveCandidateInterviewAbsenceReview ?? (() => ({ action: "HOLD" })),
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
