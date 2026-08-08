import { afterEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../src/db/database.js";

let db: BridgeDatabase | undefined;
afterEach(() => db?.close());

describe("BridgeDatabase", () => {
  it("applies every schema migration when the database opens", () => {
    db = new BridgeDatabase(":memory:");

    expect(db.getLatestSchemaVersion()).toBe(16);
  });

  it("does not recreate a resolved case review as an active duplicate", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    const reviewType = "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED";
    const first = db.createReview({
      caseId: interviewCase.id,
      reviewType,
      reason: "First interruption.",
    });
    db.resolveReview(first, "RESOLVED");
    const second = db.createReview({
      caseId: interviewCase.id,
      reviewType,
      reason: "Second interruption.",
    });

    expect(second).not.toBe(first);
    expect(db.hasCaseReview(interviewCase.id, reviewType)).toBe(true);
    expect(db.listOpenReviews()).toHaveLength(1);
  });

  it("rejects a new interviewer request draft after scheduling has started", () => {
    const database = (db = new BridgeDatabase(":memory:"));
    const interviewCase = database.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    database.setCaseStatus(interviewCase.id, "COLLECTING_AVAILABILITY");

    expect(() =>
      database.createDraft({
        caseId: interviewCase.id,
        channelId: "C1",
        previewText: "Availability request",
        blocksJson: "[]",
        payloadHash: "request-after-start",
        messageType: "INTERVIEWER_REQUEST",
      }),
    ).toThrow("ready to start scheduling");
  });

  it("updates the canonical preview text when a draft is revised", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    const draft = db.createDraft({
      caseId: interviewCase.id,
      channelId: "C1",
      previewText: "old preview",
      blocksJson: "[]",
      payloadHash: "preview-before",
      messageType: "SCHEDULE_CANCELLATION",
    });

    const revised = db.replacePendingDraftText({
      draftId: draft.id,
      previewText: "new preview",
      blocksJson: "[]",
      payloadHash: "preview-after",
    });

    expect(revised.previewText).toBe("new preview");
    expect(revised.payloadHash).toBe("preview-after");
  });

  it("leases an approved draft so concurrent send attempts cannot duplicate Slack messages", () => {
    const database = (db = new BridgeDatabase(":memory:"));
    const interviewCase = database.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    const draft = database.createDraft({
      caseId: interviewCase.id,
      channelId: "C1",
      previewText: "Availability request",
      blocksJson: "[]",
      payloadHash: "draft-hash",
      messageType: "INTERVIEWER_REQUEST",
    });
    const approved = database.approveDraft(draft.id);
    const startedAt = new Date();
    const claimed = database.claimDraftForSending(approved.id, startedAt);

    expect(claimed).toMatchObject({ status: "SENDING", sendingStartedAt: startedAt.toISOString() });
    expect(database.claimDraftForSending(approved.id, new Date(startedAt.getTime() + 60_000))).toBeUndefined();
    expect(() => database.approveDraft(approved.id)).toThrow("currently being sent");

    const recovered = database.claimDraftForSending(
      approved.id,
      new Date(startedAt.getTime() + 3 * 60_000),
    );
    expect(recovered).toMatchObject({ status: "SENDING" });
  });

  it("stores one pending interview skill decision and records the selected option", () => {
    db = new BridgeDatabase(":memory:");
    const input = {
      skillKey: "CANDIDATE_TRIAGE" as const,
      decisionType: "START_INTERVIEW_ARRANGEMENT",
      fingerprint: "review:R1:start",
      title: "Start interview arrangement",
      prompt: "Choose the next action.",
      selectionMode: "SINGLE" as const,
      options: [
        { id: "START", label: "Start", description: "Create a case." },
        { id: "HOLD", label: "Hold", description: "Keep the review open." },
      ],
      context: { reviewId: "R1" },
    };

    const first = db.createOrGetPendingInterviewSkillDecision(input);
    const duplicate = db.createOrGetPendingInterviewSkillDecision(input);

    expect(duplicate.id).toBe(first.id);
    expect(db.listInterviewSkillDecisions({ status: "PENDING" })).toHaveLength(1);

    const resolved = db.resolveInterviewSkillDecision({
      decisionId: first.id,
      optionId: "START",
      resolution: { caseId: "C1" },
    });

    expect(resolved).toMatchObject({
      status: "RESOLVED",
      selectedOptionId: "START",
      resolution: { caseId: "C1" },
    });
    expect(db.listInterviewSkillDecisions({ status: "PENDING" })).toEqual([]);

    const reopened = db.reopenResolvedInterviewSkillDecision(
      first.id,
      "대시보드 후속 작업 생성 실패",
    );
    expect(reopened).toMatchObject({
      status: "PENDING",
      selectedOptionId: null,
      resolution: null,
    });
  });

  it("discards a pending decision when the user closes an unsubmitted selection", () => {
    db = new BridgeDatabase(":memory:");
    const decision = db.createOrGetPendingInterviewSkillDecision({
      skillKey: "CANDIDATE_TRIAGE",
      decisionType: "START_INTERVIEW_ARRANGEMENT",
      fingerprint: "review:R2:start",
      title: "조율 시작 여부",
      prompt: "선택하세요.",
      selectionMode: "SINGLE",
      options: [{ id: "START", label: "시작", description: "조율을 시작합니다." }],
      context: { reviewId: "R2" },
    });

    expect(db.discardPendingInterviewSkillDecision(decision.id)).toBe(true);
    expect(db.getInterviewSkillDecision(decision.id)).toBeUndefined();
    expect(db.discardPendingInterviewSkillDecision(decision.id)).toBe(false);
  });

  it("removes a held case from operations and restores its previous local status", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Held candidate",
      proposalDates: ["2026-08-10"],
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");

    db.holdInterviewCase({ caseId: interviewCase.id, reviewId: "review-1" });

    expect(db.getCase(interviewCase.id)).toMatchObject({ status: "ON_HOLD" });
    expect(db.listOperationalCases()).toEqual([]);
    expect(db.getOperationsDashboard()).toMatchObject({
      summary: { caseCountsByStatus: { ON_HOLD: 1 } },
    });

    const resumed = db.resumeHeldInterviewCase(interviewCase.id);

    expect(resumed).toMatchObject({
      heldReviewId: "review-1",
      interviewCase: { status: "READY_TO_SCHEDULE" },
    });
    expect(db.listOperationalCases()).toMatchObject([
      { id: interviewCase.id, status: "READY_TO_SCHEDULE" },
    ]);
    expect(db.listCaseEvents(interviewCase.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "INTERVIEW_ARRANGEMENT_HELD" }),
      expect.objectContaining({ eventType: "INTERVIEW_ARRANGEMENT_RESUMED" }),
    ]));
  });

  it("stores a recruitment template and a candidate-specific combined plan", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      recruitmentRef: "R1",
      proposalDates: ["2026-07-30"],
    });
    const first = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "First interviewer",
      source: "MANUAL",
    });
    const second = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "Second interviewer",
      source: "MANUAL",
    });
    db.upsertRecruitmentInterviewTemplate({
      recruitmentId: "R1",
      recruitmentName: "Recruitment",
      pipelineHash: "pipeline-hash",
      steps: [
        {
          stepId: "S1",
          title: "First interview",
          name: "First interview",
          order: 1,
          mode: "STANDARD",
          durationMinutes: 60,
        },
        {
          stepId: "S2",
          title: "Second interview",
          name: "Second interview",
          order: 2,
          mode: "STANDARD",
          durationMinutes: 60,
        },
      ],
      routes: [
        { triggerStepId: "S1", mode: "SEQUENTIAL", stepIds: ["S1", "S2"] },
      ],
    });
    db.setRequiredInterviewers(interviewCase.id, [first.id]);
    const plan = db.upsertCaseInterviewPlan({
      caseId: interviewCase.id,
      source: "CANDIDATE_OVERRIDE",
      mode: "COMBINED",
      stepIds: ["S1", "S2"],
      stepNames: ["First interview", "Second interview"],
      interviewerIds: [first.id, second.id],
      durationMinutes: 60,
    });

    expect(db.getRecruitmentInterviewTemplate("R1")?.steps).toHaveLength(2);
    expect(db.getRecruitmentInterviewTemplate("R1")?.routes).toEqual([
      { triggerStepId: "S1", mode: "SEQUENTIAL", stepIds: ["S1", "S2"] },
    ]);
    expect(plan).toMatchObject({
      mode: "COMBINED",
      durationMinutes: 60,
      interviewerIds: [first.id, second.id],
    });
    expect(db.getCase(interviewCase.id)?.durationMinutes).toBe(60);
  });

  it("deduplicates Slack messages and preserves excluded interviewer history", () => {
    db = new BridgeDatabase(":memory:");
    const input = {
      channelId: "C1",
      messageTs: "1.0",
      eventType: "EVALUATION_COMPLETED",
      title: "서류 평가가 완료되었습니다.",
      payloadHash: "hash",
      payloadJson: "{}",
    };
    const first = db.insertNotification(input, "EVALUATION_LOOKUP_PENDING");
    const second = db.insertNotification(input, "EVALUATION_LOOKUP_PENDING");
    expect(first.inserted).toBe(true);
    expect(second).toEqual({ id: first.id, inserted: false });

    const interviewCase = db.createInterviewCase({
      notificationId: first.id,
      candidateName: "홍길동",
      proposalDates: ["2026-07-30"],
    });
    const interviewer = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "김면접",
      slackUserId: "U1",
      ninehireUserId: "N1",
      source: "NINEHIRE",
    });
    db.excludeInterviewer(interviewCase.id, interviewer.id);
    db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "김면접",
      slackUserId: "U1",
      ninehireUserId: "N1",
      source: "NINEHIRE",
    });

    expect(db.listInterviewers(interviewCase.id)).toHaveLength(0);
    expect(db.listInterviewers(interviewCase.id, false)[0]?.active).toBe(false);
    expect(db.listInterviewers(interviewCase.id, false)[0]?.status).toBe(
      "EXCLUDED_BY_USER",
    );
  });

  it("persists integration retries with exponential backoff", () => {
    db = new BridgeDatabase(":memory:");
    const startedAt = new Date("2026-07-30T00:00:00.000Z");
    const queued = db.enqueueIntegrationRetry({
      jobType: "NINEHIRE_EVALUATION_LOOKUP",
      dedupeKey: "notification-1",
      payload: { notificationId: "notification-1" },
      now: startedAt,
    });
    const duplicate = db.enqueueIntegrationRetry({
      jobType: "NINEHIRE_EVALUATION_LOOKUP",
      dedupeKey: "notification-1",
      payload: { notificationId: "notification-1" },
      now: startedAt,
    });

    expect(duplicate.id).toBe(queued.id);
    expect(
      db.listIntegrationRetryJobs({
        status: "PENDING",
        dueBefore: new Date("2026-07-30T00:00:59.999Z"),
      }),
    ).toHaveLength(0);

    const firstFailure = db.failIntegrationRetryJob(
      queued.id,
      "일시 오류",
      new Date("2026-07-30T00:01:00.000Z"),
    );
    expect(firstFailure).toMatchObject({
      status: "PENDING",
      attemptCount: 1,
      nextAttemptAt: "2026-07-30T00:03:00.000Z",
    });

    const secondFailure = db.failIntegrationRetryJob(
      queued.id,
      "일시 오류",
      new Date("2026-07-30T00:03:00.000Z"),
    );
    expect(secondFailure).toMatchObject({
      status: "PENDING",
      attemptCount: 2,
      nextAttemptAt: "2026-07-30T00:07:00.000Z",
    });

    const exhausted = db.failIntegrationRetryJob(
      queued.id,
      "일시 오류",
      new Date("2026-07-30T00:07:00.000Z"),
    );
    expect(exhausted).toMatchObject({ status: "FAILED", attemptCount: 3 });
  });

  it("redacts credentials and keeps only the first error line in retry history", () => {
    db = new BridgeDatabase(":memory:");
    const queued = db.enqueueIntegrationRetry({
      jobType: "SLACK_NOTIFICATION_RECONCILIATION",
      dedupeKey: "source-channel",
      payload: {},
      now: new Date("2026-07-30T00:00:00.000Z"),
    });

    const failed = db.failIntegrationRetryJob(
      queued.id,
      "Authorization: Bearer xoxb-test\nsecret details should not persist",
      new Date("2026-07-30T00:01:00.000Z"),
    );

    expect(failed.lastError).toContain("[REDACTED_SECRET]");
    expect(failed.lastError).toContain("[REDACTED_SLACK_TOKEN]");
    expect(failed.lastError).not.toContain("xoxb-");
    expect(failed.lastError).not.toContain("secret details");
  });

  it("rejects empty or malformed interviewer availability", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    const interviewer = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "Interviewer",
      slackUserId: "U1",
      source: "MANUAL",
    });

    expect(() =>
      db!.replaceAvailabilityForInterviewer(interviewCase.id, interviewer.id, []),
    ).toThrow("At least one interviewer availability slot");
    expect(() =>
      db!.replaceAvailabilityForInterviewer(interviewCase.id, interviewer.id, [
        { date: "2026-08-10", start: "18:00", end: "17:00" },
      ]),
    ).toThrow("end time after");
  });

  it("stores internal room allocations without overlapping a pre-booked block", () => {
    db = new BridgeDatabase(":memory:");
    const firstCase = db.createInterviewCase({
      candidateName: "지원자 1",
      proposalDates: ["2026-07-30"],
    });
    const secondCase = db.createInterviewCase({
      candidateName: "지원자 2",
      proposalDates: ["2026-07-30"],
    });
    const [block] = db.syncMeetingRoomBlocks(
      ["2026-07-30"],
      [
        {
          sourceKey: "DAOU:1",
          roomId: "103",
          roomName: "[818호] 행복룸",
          reservedBy: "강해빈",
          purpose: "면접",
          date: "2026-07-30",
          startTime: "15:00",
          endTime: "18:00",
          sourcePayloadHash: "hash",
        },
      ],
    );
    expect(block).toBeDefined();
    const first = db.allocateRoomBlock({
      caseId: firstCase.id,
      roomBlockId: block!.id,
      startTime: "15:00",
      endTime: "16:00",
    });
    expect(first.status).toBe("ACTIVE");
    expect(() =>
      db!.allocateRoomBlock({
        caseId: secondCase.id,
        roomBlockId: block!.id,
        startTime: "15:30",
        endTime: "16:30",
      }),
    ).toThrow("already allocated");
    expect(
      db.allocateRoomBlock({
        caseId: secondCase.id,
        roomBlockId: block!.id,
        startTime: "16:00",
        endTime: "17:00",
      }),
    ).toMatchObject({ status: "ACTIVE", startTime: "16:00" });
  });

  it("does not allocate a room over an already confirmed manual interview", () => {
    db = new BridgeDatabase(":memory:");
    const confirmedCase = db.createInterviewCase({
      candidateName: "Confirmed candidate",
      proposalDates: ["2026-07-30"],
    });
    db.recordManualConfirmedSchedule({
      caseId: confirmedCase.id,
      date: "2026-07-30",
      startTime: "15:00",
      endTime: "16:00",
      roomName: "Room A",
    });
    const competingCase = db.createInterviewCase({
      candidateName: "Competing candidate",
      proposalDates: ["2026-07-30"],
    });
    const [block] = db.syncMeetingRoomBlocks(["2026-07-30"], [
      {
        sourceKey: "DAOU:confirmed-conflict",
        roomId: "A",
        roomName: "Room A",
        reservedBy: "Recruiter",
        purpose: "Interview",
        date: "2026-07-30",
        startTime: "15:00",
        endTime: "18:00",
        sourcePayloadHash: "confirmed-conflict",
      },
    ]);

    expect(() =>
      db!.allocateRoomBlock({
        caseId: competingCase.id,
        roomBlockId: block!.id,
        startTime: "15:00",
        endTime: "16:00",
      }),
    ).toThrow("already uses this room and time");
  });

  it("treats the same external confirmation as idempotent", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "External candidate",
      proposalDates: ["2026-07-30"],
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    const first = db.recordExternallyConfirmedSchedule({
      caseId: interviewCase.id,
      notificationId: "notification-1",
      source: "NINEHIRE_SLACK",
      date: "2026-07-30",
      startTime: "15:00",
      endTime: "16:00",
    });
    const second = db.recordExternallyConfirmedSchedule({
      caseId: interviewCase.id,
      notificationId: "notification-1",
      source: "NINEHIRE_SLACK",
      date: "2026-07-30",
      startTime: "15:00",
      endTime: "16:00",
    });

    expect(second).toMatchObject({ status: "CONFIRMED", id: first.id });
    expect(db.listCaseEvents(interviewCase.id)).toHaveLength(2);
  });

  it("confirms an allocated room slot while preserving the candidate confirmation boundary", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "지원자 1",
      proposalDates: ["2026-07-30"],
    });
    const [block] = db.syncMeetingRoomBlocks(
      ["2026-07-30"],
      [
        {
          sourceKey: "DAOU:confirmed",
          roomId: "103",
          roomName: "[818호] 행복룸",
          reservedBy: "강해빈",
          purpose: "면접",
          date: "2026-07-30",
          startTime: "15:00",
          endTime: "18:00",
          sourcePayloadHash: "confirmed-hash",
        },
      ],
    );
    const allocation = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: block!.id,
      startTime: "15:00",
      endTime: "16:00",
    });
    db!.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");

    const confirmed = db!.confirmInternalSchedule(interviewCase.id);

    expect(confirmed).toMatchObject({
      roomAllocationId: allocation.id,
      date: "2026-07-30",
      startTime: "15:00",
      endTime: "16:00",
      roomName: "[818호] 행복룸",
    });
    expect(db!.getCase(interviewCase.id)).toMatchObject({
      status: "AWAITING_CANDIDATE_CONFIRMATION",
      scheduledRoomAllocationId: allocation.id,
    });
    expect(() =>
      db!.cancelRoomAllocation(interviewCase.id, allocation.id),
    ).toThrow("internally confirmed schedule");
  });

  it("reopens a confirmed schedule without reusing stale availability", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "지원자 1",
      proposalDates: ["2026-07-30"],
    });
    const interviewer = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "면접관 1",
      slackUserId: "U1",
      source: "MANUAL",
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    db.replaceAvailabilityForInterviewer(interviewCase.id, interviewer.id, [
      { date: "2026-07-30", start: "15:00", end: "16:00" },
    ]);
    const [block] = db.syncMeetingRoomBlocks(
      ["2026-07-30"],
      [
        {
          sourceKey: "DAOU:reschedule",
          roomId: "103",
          roomName: "[818호] 행복룸",
          reservedBy: "강해빈",
          purpose: "면접",
          date: "2026-07-30",
          startTime: "15:00",
          endTime: "18:00",
          sourcePayloadHash: "reschedule-hash",
        },
      ],
    );
    const allocation = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: block!.id,
      startTime: "15:00",
      endTime: "16:00",
    });
    db.confirmInternalSchedule(interviewCase.id);
    const sentDraft = db.createDraft({
      caseId: interviewCase.id,
      channelId: "C1",
      previewText: "기존 일정 안내",
      blocksJson: "[]",
      payloadHash: "sent-schedule-confirmation",
      messageType: "SCHEDULE_CONFIRMATION",
    });
    db.approveDraft(sentDraft.id);
    db.markDraftSent(sentDraft.id, "100.0");

    const reopened = db.reopenScheduleForReschedule({
      caseId: interviewCase.id,
      availabilityPolicy: "RECOLLECT",
      reason: "후보자가 일정 변경을 요청했습니다.",
    });

    expect(reopened).toMatchObject({
      previousSchedule: { roomAllocationId: allocation.id },
      hadSentScheduleConfirmation: true,
      interviewCase: { status: "READY_FOR_DRAFT", scheduleRound: 2 },
    });
    expect(db.listRoomAllocations(interviewCase.id)).toMatchObject([
      { id: allocation.id, status: "CANCELLED" },
    ]);
    expect(db.getCaseBundle(interviewCase.id)?.availability).toEqual([]);
    expect(db.listInterviewers(interviewCase.id)[0]?.status).toBe("PENDING");

    const cancelled = db.cancelInterviewArrangement({
      caseId: interviewCase.id,
      reason: "재조율 중 후보자가 인터뷰를 취소했습니다.",
    });
    expect(cancelled).toMatchObject({
      previousSchedule: { roomAllocationId: allocation.id },
      interviewCase: { status: "CANCELLED" },
    });
  });

  it("cancels an arrangement and releases its local room allocation", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "지원자 2",
      proposalDates: ["2026-07-30"],
    });
    const [block] = db.syncMeetingRoomBlocks(
      ["2026-07-30"],
      [
        {
          sourceKey: "DAOU:cancel",
          roomId: "103",
          roomName: "[818호] 행복룸",
          reservedBy: "강해빈",
          purpose: "면접",
          date: "2026-07-30",
          startTime: "15:00",
          endTime: "18:00",
          sourcePayloadHash: "cancel-hash",
        },
      ],
    );
    const allocation = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: block!.id,
      startTime: "15:00",
      endTime: "16:00",
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    db.confirmInternalSchedule(interviewCase.id);

    const cancelled = db.cancelInterviewArrangement({
      caseId: interviewCase.id,
      reason: "후보자가 인터뷰를 취소했습니다.",
    });

    expect(cancelled.interviewCase.status).toBe("CANCELLED");
    expect(db.listRoomAllocations(interviewCase.id)).toMatchObject([
      { id: allocation.id, status: "CANCELLED" },
    ]);
    expect(db.getStatus()).toMatchObject({ activeCases: 0 });
  });

  it("tracks and resolves external follow-ups for a cancelled arrangement", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "테스트1",
      recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
      proposalDates: ["2026-07-30"],
    });
    db.cancelInterviewArrangement({
      caseId: interviewCase.id,
      reason: "후보자 불참으로 취소합니다.",
    });

    const followUps = db.createCancellationExternalFollowUps(interviewCase.id);
    expect(followUps).toMatchObject([
      { followUpType: "NINEHIRE_CANDIDATE_SCHEDULE", status: "PENDING" },
    ]);
    expect(db.backfillCancellationExternalFollowUps()).toEqual({
      cancelledCases: 1,
      followUpsCreated: 0,
    });

    const ninehireFollowUp = followUps.find(
      (item) => item.followUpType === "NINEHIRE_CANDIDATE_SCHEDULE",
    )!;
    expect(
      db.resolveCancellationExternalFollowUp({
        followUpId: ninehireFollowUp.id,
        status: "CONFIRMED",
        resolutionNote: "나인하이어 후보자 일정을 취소했습니다.",
      }),
    ).toMatchObject({ status: "CONFIRMED" });

    db.connection
      .prepare(`
        INSERT INTO cancellation_external_follow_ups(
          id, case_id, follow_up_type, status, created_at
        ) VALUES (?, ?, 'DAOU_ROOM_RESERVATION', 'NOT_REQUIRED', ?)
      `)
      .run("legacy-daou-follow-up", interviewCase.id, new Date().toISOString());
    expect(db.listCancellationExternalFollowUps({ caseId: interviewCase.id })).toEqual([
      expect.objectContaining({
        followUpType: "NINEHIRE_CANDIDATE_SCHEDULE",
        status: "CONFIRMED",
      }),
    ]);
    expect(db.getOperationsDashboard()).toMatchObject({
      summary: {
        caseCountsByStatus: { CANCELLED: 0 },
        pendingCancellationExternalFollowUps: 0,
      },
      cases: [],
    });
    expect(db.listOperationalCases()).toEqual([]);
    expect(db.listCases("CANCELLED")).toMatchObject([
      { candidateName: "테스트1", status: "CANCELLED" },
    ]);
  });

  it("returns recruitment, interview-plan, and meeting-room metrics for a future dashboard", () => {
    db = new BridgeDatabase(":memory:");
    const standard = db.createInterviewCase({
      candidateName: "Candidate 1",
      recruitmentRef: "R1",
      recruitmentName: "Recruitment",
      proposalDates: ["2026-08-10"],
    });
    const sequential = db.createInterviewCase({
      candidateName: "Candidate 2",
      recruitmentRef: "R1",
      recruitmentName: "Recruitment",
      proposalDates: ["2026-08-10"],
    });
    db.upsertCaseInterviewPlan({
      caseId: standard.id,
      source: "TEMPLATE",
      mode: "STANDARD",
      stepIds: ["S1"],
      stepNames: ["First"],
      durationMinutes: 60,
    });
    db.upsertCaseInterviewPlan({
      caseId: sequential.id,
      source: "TEMPLATE",
      mode: "SEQUENTIAL",
      stepIds: ["S1", "S2"],
      stepNames: ["First", "Second"],
      sessions: [
        { stepId: "S1", stepName: "First", interviewerIds: [] },
        { stepId: "S2", stepName: "Second", interviewerIds: [] },
      ],
      durationMinutes: 120,
    });
    const [block] = db.syncMeetingRoomBlocks(
      ["2026-08-10"],
      [
        {
          sourceKey: "DAOU:dashboard",
          roomId: "A",
          roomName: "Room A",
          reservedBy: "Recruiter",
          purpose: "Interview",
          date: "2026-08-10",
          startTime: "09:00",
          endTime: "12:00",
          sourcePayloadHash: "dashboard-hash",
        },
      ],
    );
    db.allocateRoomBlock({
      caseId: standard.id,
      roomBlockId: block!.id,
      startTime: "09:00",
      endTime: "10:00",
    });

    expect(db.getOperationsDashboard()).toMatchObject({
      metrics: {
        interviewPlans: {
          caseCountsByMode: { STANDARD: 1, SEQUENTIAL: 1 },
          sequentialPlansNeedingInterviewerAssignment: 1,
        },
        recruitments: [
          {
            recruitmentRef: "R1",
            caseCount: 2,
            planCounts: { STANDARD: 1, SEQUENTIAL: 1 },
          },
        ],
        meetingRooms: {
          activeAllocations: [
            { roomName: "Room A", activeAllocationCount: 1, allocatedMinutes: 60 },
          ],
        },
      },
    });
  });
});
