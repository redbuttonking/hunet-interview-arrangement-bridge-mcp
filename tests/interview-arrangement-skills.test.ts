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
  createAvailabilityReminderDraft?: (caseId: string) => unknown;
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
    createAvailabilityReminderDraft:
      input.createAvailabilityReminderDraft ?? (() => ({ id: "reminder-draft", status: "DRAFT" })),
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

  it("uses only the route that matches the candidate's current interview stage", async () => {
    db = new BridgeDatabase(":memory:");
    db.upsertRecruitmentInterviewTemplate({
      recruitmentId: "R1",
      recruitmentName: "Recruitment",
      pipelineHash: "pipeline-hash",
      steps: [
        { stepId: "S1", title: "Combined interview", name: "Combined interview", order: 2, mode: "COMBINED", durationMinutes: 60 },
        { stepId: "S2", title: "CEO interview", name: "CEO interview", order: 3, mode: "STANDARD", durationMinutes: 60 },
      ],
      routes: [
        { triggerStepId: "S1", mode: "COMBINED", stepIds: ["S1"] },
        { triggerStepId: "S2", mode: "STANDARD", stepIds: ["S2"] },
      ],
    });
    const reviewId = db.createReview({
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "Completed evaluation requires approval.",
      summary: {
        context: { candidateName: "Candidate", recruitmentRef: "R1", recruitmentName: "Recruitment" },
        evaluation: {
          applicantProgressId: "A1",
          recruitmentId: "R1",
          scoreSheets: [],
          currentStep: { stepId: "S2", name: "CEO interview", order: 3 },
        },
      },
    });
    const calls: Array<{ reviewId: string; routeTriggerStepId: string }> = [];
    const skills = createSkills({
      async approveInterviewArrangement(input) {
        calls.push(input);
        return { caseId: "ceo-case" };
      },
    });

    const decision = skills.createCandidateTriageDecision(reviewId);
    expect(decision.decisionType).toBe("START_INTERVIEW_ARRANGEMENT");
    expect(decision.options.map((option) => option.id)).toEqual(["START", "HOLD"]);

    await skills.resolveDecision({ decisionId: decision.id, optionId: "START" });
    expect(calls).toEqual([{ reviewId, routeTriggerStepId: "S2" }]);
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

  it("waits for the automatic reminder policy before offering an additional request", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      slackUserId: "U1",
      displayName: "Interviewer",
      source: "MANUAL",
    });
    db.setCaseStatus(interviewCase.id, "REQUEST_SENT");
    const skills = createSkills();

    const decision = skills.createAvailabilityCollectionDecision(interviewCase.id);
    expect(decision.decisionType).toBe("WAIT_FOR_AVAILABILITY");
    expect(decision.options.map((option) => option.id)).toEqual(["WAIT"]);
  });

  it("offers an additional reminder draft only after two automatic reminders", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      slackUserId: "U1",
      displayName: "Interviewer",
      source: "MANUAL",
    });
    db.setCaseStatus(interviewCase.id, "COLLECTING_AVAILABILITY");
    const reviewId = db.createReview({
      caseId: interviewCase.id,
      reviewType: "INTERVIEWER_NO_RESPONSE",
      reason: "Automatic reminders were sent twice.",
    });
    const skills = createSkills();

    const decision = skills.createInterviewerNoResponseDecision(reviewId);
    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "CREATE_ADDITIONAL_REMINDER_DRAFT",
    });

    expect(decision.decisionType).toBe("INTERVIEWER_NO_RESPONSE_ACTION");
    expect(resolved.outcome).toMatchObject({
      action: "CREATE_ADDITIONAL_REMINDER_DRAFT",
      nextAction: "CREATE_AVAILABILITY_REMINDER_DRAFT",
    });
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
    expect(decision).toMatchObject({
      prompt: "모든 면접관이 일정을 제출하였습니다. 인터뷰 진행할 일정을 선택해주세요.",
      context: {
        interviewerAvailability: [{ displayName: "Interviewer", submitted: true }],
        commonSlots: [{ date: "2026-08-10", startTime: "10:00", endTime: "11:00" }],
        roomMatchedSlots: [{ date: "2026-08-10", roomName: "행복룸" }],
      },
    });
    expect(resolved).toMatchObject({
      outcome: {
        schedule: {
          caseId: interviewCase.id,
          roomName: "행복룸",
          startTime: "10:00",
          endTime: "11:00",
        },
        nextAction: "CREATE_CANDIDATE_SCHEDULE_PROPOSAL_DECISION",
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

  it("keeps candidate rescheduling in two user-selected steps", async () => {
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
    expect(decision.options.map((option) => option.id)).toEqual(["RESCHEDULE", "CANCEL", "HOLD"]);

    const selectedReschedule = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "RESCHEDULE",
    });
    expect(actions).toEqual([]);
    expect(selectedReschedule.outcome).toMatchObject({
      action: "RESCHEDULE",
      nextAction: "CHOOSE_CANDIDATE_RESCHEDULE_METHOD",
    });

    const methodDecision = skills.createCandidateRescheduleMethodDecision(reviewId);
    const resolved = await skills.resolveDecision({
      decisionId: methodDecision.id,
      optionId: "RESCHEDULE_REUSE",
    });

    expect(actions).toEqual(["RESCHEDULE_USING_EXISTING_AVAILABILITY"]);
    expect(resolved.decision.selectedOptionId).toBe("RESCHEDULE_REUSE");
    expect(resolved.outcome).toMatchObject({ nextAction: "CREATE_INTERVIEW_SCHEDULING_DECISION" });
  });

  it("hands candidate schedule proposal to the external sender before recording it locally", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      recruitmentName: "Recruitment",
      proposalDates: ["2026-08-10"],
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    const [block] = db.syncMeetingRoomBlocks(
      ["2026-08-10"],
      [{
        sourceKey: "DAOU:proposal",
        roomId: "ROOM-1",
        roomName: "Interview room",
        reservedBy: "Recruiter",
        purpose: "Interview",
        date: "2026-08-10",
        startTime: "10:00",
        endTime: "12:00",
        sourcePayloadHash: "proposal-hash",
      }],
    );
    const allocation = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: block!.id,
      startTime: "10:00",
      endTime: "11:00",
    });
    db.confirmInternalSchedule(interviewCase.id);
    db.createCandidateScheduleOptions({
      caseId: interviewCase.id,
      allocationIds: [allocation.id],
    });
    const skills = createSkills();

    const decision = skills.createCandidateScheduleProposalDecision(interviewCase.id);
    expect(decision.options.map((option) => option.id)).toEqual([
      "SEND_NINEHIRE_SCHEDULE_PROPOSAL",
      "MARK_MANUAL_CANDIDATE_SCHEDULE_PROPOSAL_SENT",
    ]);
    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "SEND_NINEHIRE_SCHEDULE_PROPOSAL",
    });

    expect(resolved).toMatchObject({
      decision: { status: "RESOLVED", selectedOptionId: "SEND_NINEHIRE_SCHEDULE_PROPOSAL" },
      outcome: { nextAction: "SEND_NINEHIRE_CANDIDATE_SCHEDULE_PROPOSAL" },
    });
    expect(db.hasCandidateScheduleProposalSent(interviewCase.id)).toBe(false);

    db.recordCandidateScheduleProposalSent(interviewCase.id);
    expect(db.hasCandidateScheduleProposalSent(interviewCase.id)).toBe(true);
  });

  it("keeps different-room candidate options in one proposal decision", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      recruitmentName: "Recruitment",
      proposalDates: ["2026-08-10", "2026-08-11"],
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    const blocks = db.syncMeetingRoomBlocks(
      ["2026-08-10", "2026-08-11"],
      [
        {
          sourceKey: "DAOU:proposal-location-7f",
          roomId: "ROOM-7F",
          roomName: "[710호] 疑問堂(의문당)",
          reservedBy: "Recruiter",
          purpose: "Interview",
          date: "2026-08-10",
          startTime: "10:00",
          endTime: "11:00",
          sourcePayloadHash: "proposal-location-7f",
        },
        {
          sourceKey: "DAOU:proposal-location-8f",
          roomId: "ROOM-8F",
          roomName: "[818호] 열정룸",
          reservedBy: "Recruiter",
          purpose: "Interview",
          date: "2026-08-11",
          startTime: "10:00",
          endTime: "11:00",
          sourcePayloadHash: "proposal-location-8f",
        },
      ],
    );
    const first = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: blocks.find((block) => block.roomName.includes("의문당"))!.id,
      startTime: "10:00",
      endTime: "11:00",
    });
    const second = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: blocks.find((block) => block.roomName.includes("열정룸"))!.id,
      startTime: "10:00",
      endTime: "11:00",
      allowAdditionalForCase: true,
    });
    db.confirmInternalSchedule(interviewCase.id);
    db.createCandidateScheduleOptions({
      caseId: interviewCase.id,
      allocationIds: [first.id, second.id],
    });
    const skills = createSkills();

    const decision = skills.createCandidateScheduleProposalDecision(interviewCase.id);
    expect(decision.decisionType).toBe("CANDIDATE_SCHEDULE_PROPOSAL_SENT");
    expect(decision.options).toHaveLength(2);
    expect(db.listCurrentCandidateScheduleOptions(interviewCase.id)).toMatchObject([
      { roomName: "[710호] 疑問堂(의문당)" },
      { roomName: "[818호] 열정룸" },
    ]);
    expect(db.listRoomAllocations(interviewCase.id).find((allocation) => allocation.id === second.id)?.status).toBe("ACTIVE");
  });

  it("records a manually sent candidate schedule proposal without sending a second email", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      recruitmentName: "Recruitment",
      proposalDates: ["2026-08-10"],
    });
    db.setCaseStatus(interviewCase.id, "AWAITING_CANDIDATE_CONFIRMATION");
    const decision = db.createOrGetPendingInterviewSkillDecision({
      skillKey: "CANDIDATE_SCHEDULE_PROPOSAL",
      decisionType: "CANDIDATE_SCHEDULE_PROPOSAL_SENT",
      fingerprint: `case:${interviewCase.id}:candidate-schedule-proposal`,
      caseId: interviewCase.id,
      title: "나인하이어 일정 제안 발송",
      prompt: "후보자 일정 제안을 발송하세요.",
      selectionMode: "SINGLE",
      options: [{
        id: "SEND_NINEHIRE_SCHEDULE_PROPOSAL",
        label: "나인하이어 메일 자동 발송",
        description: "자동 발송합니다.",
      }],
      context: {},
    });
    const skills = createSkills();

    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "MARK_MANUAL_CANDIDATE_SCHEDULE_PROPOSAL_SENT",
    });

    expect(resolved).toMatchObject({
      decision: { status: "RESOLVED", selectedOptionId: "MARK_MANUAL_CANDIDATE_SCHEDULE_PROPOSAL_SENT" },
      outcome: { nextAction: "NONE" },
    });
    expect(db.hasCandidateScheduleProposalSent(interviewCase.id)).toBe(true);
  });

  it("requires a manual result check when the external schedule proposal dispatch is uncertain", async () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      recruitmentName: "Recruitment",
      proposalDates: ["2026-08-10"],
    });
    db.setCaseStatus(interviewCase.id, "AWAITING_CANDIDATE_CONFIRMATION");
    const reviewId = db.createReview({
      caseId: interviewCase.id,
      reviewType: "NINEHIRE_SCHEDULE_PROPOSAL_CONFIRMATION_REQUIRED",
      reason: "External dispatch could not be verified.",
    });
    const skills = createSkills();

    const decision = skills.createCandidateScheduleProposalReconciliationDecision(reviewId);
    const resolved = await skills.resolveDecision({
      decisionId: decision.id,
      optionId: "MARK_SENT",
    });

    expect(resolved).toMatchObject({
      decision: { status: "RESOLVED", selectedOptionId: "MARK_SENT" },
      outcome: { nextAction: "NONE" },
    });
    expect(db.getReview(reviewId)).toMatchObject({
      status: "RESOLVED",
      resolution: "NINEHIRE_SCHEDULE_PROPOSAL_SENT_CONFIRMED",
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

  it("clears a recovery warning without sending a Slack message when the current state is confirmed", async () => {
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
      optionId: "CONFIRM_NO_RECOVERY_NEEDED",
    });

    expect(calls).toEqual([]);
    expect(resolved.outcome).toMatchObject({
      nextAction: "WAIT_FOR_AVAILABILITY",
    });
    expect(db.getReview(reviewId)).toMatchObject({
      status: "RESOLVED",
      resolution: "AVAILABILITY_RECOVERY_NOT_NEEDED",
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
