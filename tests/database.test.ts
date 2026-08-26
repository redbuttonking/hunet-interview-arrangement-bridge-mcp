import { afterEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../src/db/database.js";
import { INTERVIEW_BRIDGE_WORKER_KEY } from "../src/domain/worker-health.js";

let db: BridgeDatabase | undefined;
afterEach(() => db?.close());

describe("BridgeDatabase", () => {
  it("applies every schema migration when the database opens", () => {
    db = new BridgeDatabase(":memory:");

    expect(db.getLatestSchemaVersion()).toBe(25);
  });

  it("stores a Slack request channel per recruitment and resolves it for a case", () => {
    db = new BridgeDatabase(":memory:");
    db.upsertRecruitmentSlackChannel({
      recruitmentId: "R1",
      recruitmentName: "Sales recruitment",
      channelId: "C123",
    });
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      recruitmentRef: "R1",
      recruitmentName: "Sales recruitment",
      proposalDates: ["2026-08-10"],
    });

    expect(db.getRequestChannelForCase(interviewCase.id)).toBe("C123");
    expect(db.listRecruitmentSlackChannels()).toMatchObject([
      { recruitmentId: "R1", channelId: "C123" },
    ]);
  });

  it("finds the latest stored NineHire stage for a candidate", () => {
    db = new BridgeDatabase(":memory:");
    db.createReview({
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "평가 완료",
      summary: {
        context: { candidateRef: "C1", recruitmentRef: "R1" },
        evaluation: { currentStep: { stepId: "S1", name: "1차 인터뷰" } },
      },
    });
    db.createReview({
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "평가 완료",
      summary: {
        context: { candidateRef: "C1", recruitmentRef: "R1" },
        evaluation: { currentStep: { stepId: "S2", name: "CEO 인터뷰" } },
      },
    });

    const reviews = db.listCandidateArrangementReviews({
      candidateRef: "C1",
      recruitmentRef: "R1",
    });

    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.summary).toMatchObject({
      evaluation: { currentStep: { stepId: "S2", name: "CEO 인터뷰" } },
    });
  });

  it("clears candidate and room operation data while retaining Slack read positions and setup", () => {
    db = new BridgeDatabase(":memory:");
    const notification = db.insertNotification({
      channelId: "C1",
      messageTs: "1.0",
      eventType: "EVALUATION_COMPLETED",
      title: "평가 완료",
      candidateName: "테스트 후보자",
      recruitmentName: "테스트 채용",
      payloadHash: "notification-hash",
      payloadJson: "{}",
    }, "PROCESSED");
    const interviewCase = db.createInterviewCase({
      notificationId: notification.id,
      candidateName: "테스트 후보자",
      recruitmentName: "테스트 채용",
      proposalDates: ["2026-08-10"],
    });
    db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "면접관",
      source: "MANUAL",
    });
    db.createReview({
      caseId: interviewCase.id,
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "테스트 검토",
    });
    db.syncMeetingRoomBlocks(["2026-08-10"], [{
      sourceKey: "DAOU:reset-test",
      roomId: "R1",
      roomName: "행복룸",
      reservedBy: "담당자",
      purpose: "면접",
      date: "2026-08-10",
      startTime: "10:00",
      endTime: "13:00",
      sourcePayloadHash: "room-hash",
    }]);
    db.setCursor("slack:C1:latest_ts", "1.0");
    db.setCursor("sync:slack:last_success", "2026-08-10T00:00:00.000Z");
    db.connection.prepare(`
      INSERT INTO identity_mappings(id, ninehire_user_id, slack_user_id, created_at, updated_at)
      VALUES ('identity-1', 'N1', 'U1', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')
    `).run();
    db.connection.prepare(`
      INSERT INTO recruitment_interview_templates(
        recruitment_id, recruitment_name, pipeline_hash, steps_json, routes_json, approved_at, updated_at
      ) VALUES ('R1', '테스트 채용', 'hash', '[]', '[]', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')
    `).run();

    const result = db.clearOperationalData();

    expect(result.deleted["인터뷰 조율 건"]).toBe(1);
    expect(result.deleted["회의실 예약 블록"]).toBe(1);
    expect(result.deleted["Slack 원본 알림"]).toBe(1);
    expect(result.retainedSlackCursorCount).toBe(1);
    expect(db.getStatus()).toMatchObject({
      notifications: 0,
      openReviews: 0,
      activeCases: 0,
      activeMeetingRoomBlocks: 0,
    });
    expect(db.getCursor("slack:C1:latest_ts")).toBe("1.0");
    expect(db.getCursor("sync:slack:last_success")).toBeUndefined();
    expect(Number((db.connection.prepare("SELECT COUNT(*) AS count FROM identity_mappings").get() as { count: number }).count)).toBe(1);
    expect(Number((db.connection.prepare("SELECT COUNT(*) AS count FROM recruitment_interview_templates").get() as { count: number }).count)).toBe(1);
  });

  it("prevents a second worker from acquiring an active processing lease", () => {
    db = new BridgeDatabase(":memory:");
    const startedAt = new Date("2026-08-09T00:00:00.000Z");
    const first = db.acquireWorkerLease({
      workerKey: "worker",
      ownerToken: "owner-a",
      leaseDurationMs: 75_000,
      now: startedAt,
    });
    const second = db.acquireWorkerLease({
      workerKey: "worker",
      ownerToken: "owner-b",
      leaseDurationMs: 75_000,
      now: new Date("2026-08-09T00:00:30.000Z"),
    });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.health.leaseExpiresAt).toBe("2026-08-09T00:01:15.000Z");
    expect(
      db.renewWorkerLease({
        workerKey: "worker",
        ownerToken: "owner-b",
        leaseDurationMs: 75_000,
        now: new Date("2026-08-09T00:00:30.000Z"),
      }),
    ).toBe(false);
  });

  it("allows a replacement worker only after the previous lease expires", () => {
    db = new BridgeDatabase(":memory:");
    db.acquireWorkerLease({
      workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
      ownerToken: "owner-a",
      leaseDurationMs: 75_000,
      now: new Date("2026-08-09T00:00:00.000Z"),
    });

    const replacement = db.acquireWorkerLease({
      workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
      ownerToken: "owner-b",
      leaseDurationMs: 75_000,
      now: new Date("2026-08-09T00:01:31.000Z"),
      downtimeThresholdMs: 90_000,
    });

    expect(replacement.acquired).toBe(true);
    expect(replacement.downtime).toMatchObject({
      workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
      startedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(
      db.renewWorkerLease({
        workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
        ownerToken: "owner-b",
        leaseDurationMs: 75_000,
        now: new Date("2026-08-09T00:01:32.000Z"),
      }),
    ).toBe(true);

    db.releaseWorkerLease(INTERVIEW_BRIDGE_WORKER_KEY, "owner-b");
    expect(
      (db.getOperationsDashboard().summary as { worker: { status: string } }).worker.status,
    ).toBe("STALE");
  });

  it("ignores cycle results written by a worker that lost its lease", () => {
    db = new BridgeDatabase(":memory:");
    const startedAt = new Date("2026-08-09T00:00:00.000Z");
    db.acquireWorkerLease({
      workerKey: "worker",
      ownerToken: "owner-a",
      leaseDurationMs: 75_000,
      now: startedAt,
    });
    db.acquireWorkerLease({
      workerKey: "worker",
      ownerToken: "owner-b",
      leaseDurationMs: 75_000,
      now: new Date("2026-08-09T00:01:31.000Z"),
    });

    expect(
      db.recordWorkerCycleSuccess(
        "worker",
        new Date("2026-08-09T00:01:32.000Z"),
        "owner-a",
      ),
    ).toBe(false);
    expect(
      db.recordWorkerCycleFailure(
        "worker",
        "authorization=secret-value",
        new Date("2026-08-09T00:01:32.000Z"),
        "owner-a",
      ),
    ).toBe(false);
    expect(db.getWorkerHealth("worker")).toMatchObject({
      lastSuccessfulCycleAt: null,
      lastErrorMessage: null,
    });
  });

  it("claims reminders before sending and resolves a second reminder only once", () => {
    const database = (db = new BridgeDatabase(":memory:"));
    const interviewCase = database.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    database.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "Interviewer",
      slackUserId: "U1",
      source: "MANUAL",
    });
    const draft = database.createDraft({
      caseId: interviewCase.id,
      channelId: "C1",
      previewText: "Availability request",
      blocksJson: "[]",
      payloadHash: "reminder-claim",
      messageType: "INTERVIEWER_REQUEST",
    });
    database.approveDraft(draft.id);
    database.markDraftSent(
      draft.id,
      "100.0",
      new Date("2026-08-03T00:00:00.000Z"),
    );

    const reminders = database.listDueReminders(new Date("2026-08-06T03:00:00.000Z"));
    expect(reminders).toHaveLength(2);
    const first = reminders.find((reminder) => reminder.reminderNumber === 1)!;
    expect(database.claimReminder(first.id, new Date("2026-08-06T03:00:00.000Z"))).toBe(true);
    expect(database.claimReminder(first.id, new Date("2026-08-06T03:00:30.000Z"))).toBe(false);
    expect(database.claimReminder(first.id, new Date("2026-08-06T03:03:00.000Z"))).toBe(true);
    database.releaseReminder(first.id);

    const second = reminders.find((reminder) => reminder.reminderNumber === 2)!;
    expect(database.claimReminder(second.id, new Date("2026-08-06T03:00:00.000Z"))).toBe(true);
    database.markReminderSent(second.id);
    database.markReminderSent(second.id);
    expect(database.listCaseEvents(interviewCase.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "AVAILABILITY_REMINDER_SENT",
        actor: "SYSTEM",
        detail: expect.objectContaining({
          reminderNumber: 2,
          interviewerName: "Interviewer",
        }),
      }),
    ]));
    expect(
      database.listOpenReviews().filter((review) => review.reviewType === "INTERVIEWER_NO_RESPONSE"),
    ).toHaveLength(1);
    expect(database.getCase(interviewCase.id)).toMatchObject({
      status: "COLLECTING_AVAILABILITY",
    });
    expect(
      database.listOpenReviews().find((review) => review.reviewType === "INTERVIEWER_NO_RESPONSE")?.reason,
    ).toBe("Interviewer 면접관이 리마인드 2회 후에도 가능 일정을 제출하지 않았습니다.");
  });

  it("refreshes expired dates only for unsent interviewer request drafts", () => {
    const database = (db = new BridgeDatabase(":memory:"));
    const interviewCase = database.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"],
    });
    const staleDraft = database.createDraft({
      caseId: interviewCase.id,
      channelId: "C1",
      previewText: "Expired availability request",
      blocksJson: "[]",
      payloadHash: "expired-request",
      messageType: "INTERVIEWER_REQUEST",
    });

    const refreshed = database.refreshExpiredProposalDatesForUnsentRequest({
      caseId: interviewCase.id,
      proposalDates: ["2026-08-21", "2026-08-24", "2026-08-25", "2026-08-26"],
      referenceDate: "2026-08-20",
    });

    expect(refreshed).toMatchObject({
      interviewCase: {
        proposalDates: ["2026-08-21", "2026-08-24", "2026-08-25", "2026-08-26"],
      },
      cancelledDraftIds: [staleDraft.id],
    });
    expect(database.getDraft(staleDraft.id)?.status).toBe("CANCELLED");
    expect(database.listCaseEvents(interviewCase.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "PROPOSAL_DATES_AUTO_REFRESHED" }),
    ]));
  });

  it("restores historic no-response cases to availability collection without hiding other reviews", () => {
    const database = (db = new BridgeDatabase(":memory:"));
    const interviewCase = database.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    database.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "Interviewer",
      slackUserId: "U1",
      source: "MANUAL",
    });
    database.setCaseStatus(interviewCase.id, "REVIEW_REQUIRED");
    database.createReview({
      caseId: interviewCase.id,
      reviewType: "INTERVIEWER_NO_RESPONSE",
      reason: "Legacy reminder follow-up.",
    });

    expect(database.restoreAvailabilityCollectionAfterNoResponseReview()).toBe(1);
    expect(database.getCase(interviewCase.id)).toMatchObject({
      status: "COLLECTING_AVAILABILITY",
    });

    database.setCaseStatus(interviewCase.id, "REVIEW_REQUIRED");
    database.createReview({
      caseId: interviewCase.id,
      reviewType: "INTERVIEWER_DECLINED",
      reason: "Separate review.",
    });
    expect(database.restoreAvailabilityCollectionAfterNoResponseReview()).toBe(0);
    expect(database.getCase(interviewCase.id)).toMatchObject({
      status: "REVIEW_REQUIRED",
    });
  });

  it("closes an unscheduled arrangement without creating an external cancellation follow-up", () => {
    const database = (db = new BridgeDatabase(":memory:"));
    const interviewCase = database.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-08-10"],
    });
    const interviewer = database.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "Interviewer",
      slackUserId: "U1",
      source: "MANUAL",
    });
    database.setCaseStatus(interviewCase.id, "COLLECTING_AVAILABILITY");
    database.replaceAvailabilityForInterviewer(interviewCase.id, interviewer.id, [
      { date: "2026-08-10", start: "09:00", end: "10:00" },
    ]);
    database.createReview({
      caseId: interviewCase.id,
      reviewType: "INTERVIEWER_NO_RESPONSE",
      reason: "Reminder completed.",
    });

    const closed = database.closeInterviewArrangement({
      caseId: interviewCase.id,
      reason: "팀 TO 부재로 불합격 처리 요청.",
    });

    expect(closed.status).toBe("CLOSED");
    expect(database.listOperationalCases()).toEqual([]);
    expect(database.listCancellationExternalFollowUps({ caseId: interviewCase.id })).toEqual([]);
    expect(database.getCaseBundle(interviewCase.id)?.availability).toEqual([]);
    expect(database.listOpenReviews()).toEqual([]);
    expect(database.listCaseEvents(interviewCase.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "INTERVIEW_ARRANGEMENT_CLOSED" }),
    ]));
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
      "Authorization: Bearer xoxb-test xapp-test\nsecret details should not persist",
      new Date("2026-07-30T00:01:00.000Z"),
    );

    expect(failed.lastError).toContain("[REDACTED_SECRET]");
    expect(failed.lastError).toContain("[REDACTED_SLACK_TOKEN]");
    expect(failed.lastError).not.toContain("xoxb-");
    expect(failed.lastError).not.toContain("xapp-");
    expect(failed.lastError).not.toContain("secret details");
  });

  it("redacts candidate contact details from retry errors", () => {
    db = new BridgeDatabase(":memory:");
    const queued = db.enqueueIntegrationRetry({
      jobType: "SLACK_NOTIFICATION_RECONCILIATION",
      dedupeKey: "contact-redaction",
      payload: {},
      now: new Date("2026-08-09T00:00:00.000Z"),
    });

    const failed = db.failIntegrationRetryJob(
      queued.id,
      "Candidate test@example.com requested a callback at 010-1234-5678?access_token=private-value",
      new Date("2026-08-09T00:01:00.000Z"),
    );

    expect(failed.lastError).toContain("[REDACTED_EMAIL]");
    expect(failed.lastError).toContain("[REDACTED_PHONE]");
    expect(failed.lastError).toContain("access_token=[REDACTED]");
    expect(failed.lastError).not.toContain("test@example.com");
    expect(failed.lastError).not.toContain("010-1234-5678");
    expect(failed.lastError).not.toContain("private-value");
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

  it("finds only an interviewer's previous availability on the same proposal dates", () => {
    db = new BridgeDatabase(":memory:");
    const previousCase = db.createInterviewCase({
      candidateName: "이전 지원자",
      proposalDates: ["2026-08-18", "2026-08-19"],
    });
    const previousInterviewer = db.addOrUpdateInterviewer({
      caseId: previousCase.id,
      displayName: "면접관",
      slackUserId: "U1",
      source: "MANUAL",
    });
    db.replaceAvailabilityForInterviewer(previousCase.id, previousInterviewer.id, [
      { date: "2026-08-18", start: "10:00", end: "11:00" },
      { date: "2026-08-19", start: "14:00", end: "15:00" },
    ]);
    const currentCase = db.createInterviewCase({
      candidateName: "새 지원자",
      proposalDates: ["2026-08-19", "2026-08-20"],
    });

    expect(db.findReusablePreviousAvailability({
      caseId: currentCase.id,
      slackUserId: "U1",
      proposalDates: currentCase.proposalDates,
    })).toEqual([
      { date: "2026-08-19", start: "14:00", end: "15:00" },
    ]);
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

  it("merges adjacent shared interview room blocks before suggesting and allocating a room", () => {
    db = new BridgeDatabase(":memory:");
    const firstCase = db.createInterviewCase({
      candidateName: "첫 지원자",
      durationMinutes: 120,
      proposalDates: ["2026-08-12"],
    });
    const secondCase = db.createInterviewCase({
      candidateName: "두 번째 지원자",
      durationMinutes: 60,
      proposalDates: ["2026-08-12"],
    });
    const blocks = db.syncMeetingRoomBlocks(["2026-08-12"], [
      {
        sourceKey: "DAOU:shared-room-1",
        roomId: "happiness",
        roomName: "[818호] 행복룸",
        reservedBy: "박현수",
        purpose: "면접",
        date: "2026-08-12",
        startTime: "09:00",
        endTime: "10:00",
        sourcePayloadHash: "shared-room-1",
      },
      {
        sourceKey: "DAOU:shared-room-2",
        roomId: "happiness",
        roomName: "[818호] 행복룸",
        reservedBy: "김성은",
        purpose: "면접",
        date: "2026-08-12",
        startTime: "10:00",
        endTime: "12:00",
        sourcePayloadHash: "shared-room-2",
      },
    ]);

    const available = db.findAvailableRoomBlocks("2026-08-12", "09:00", "11:00");
    expect(available).toHaveLength(1);
    expect(available[0]).toMatchObject({ id: blocks[0]!.id, roomName: "[818호] 행복룸" });

    expect(
      db.allocateRoomBlock({
        caseId: firstCase.id,
        roomBlockId: available[0]!.id,
        startTime: "09:00",
        endTime: "11:00",
      }),
    ).toMatchObject({ status: "ACTIVE", startTime: "09:00", endTime: "11:00" });

    expect(db.findAvailableRoomBlocks("2026-08-12", "10:00", "11:00")).toEqual([]);
    expect(() =>
      db!.allocateRoomBlock({
        caseId: secondCase.id,
        roomBlockId: blocks[1]!.id,
        startTime: "10:00",
        endTime: "11:00",
      }),
    ).toThrow("already allocated");
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

  it("records a direct candidate confirmation only after the proposal was sent", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Candidate",
      proposalDates: ["2026-07-30"],
    });
    db!.setCaseStatus(interviewCase.id, "AWAITING_CANDIDATE_CONFIRMATION");
    expect(() =>
      db!.recordExternallyConfirmedCandidateSchedule({
        caseId: interviewCase.id,
        sourceEventId: "event-1",
        date: "2026-07-30",
        startTime: "15:00",
        endTime: "16:00",
      }),
    ).toThrow("proposal has not been recorded as sent");
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

  it("keeps multiple candidate proposal options and releases the unselected room slot", () => {
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
          sourceKey: "DAOU:proposal-one",
          roomId: "R1",
          roomName: "Room one",
          reservedBy: "Recruiter",
          purpose: "Interview",
          date: "2026-08-10",
          startTime: "10:00",
          endTime: "12:00",
          sourcePayloadHash: "proposal-one",
        },
        {
          sourceKey: "DAOU:proposal-two",
          roomId: "R2",
          roomName: "Room two",
          reservedBy: "Recruiter",
          purpose: "Interview",
          date: "2026-08-11",
          startTime: "14:00",
          endTime: "16:00",
          sourcePayloadHash: "proposal-two",
        },
      ],
    );
    const first = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: blocks[0]!.id,
      startTime: "10:00",
      endTime: "11:00",
    });
    const second = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: blocks[1]!.id,
      startTime: "14:00",
      endTime: "15:00",
      allowAdditionalForCase: true,
    });
    db.confirmInternalSchedule(interviewCase.id);
    expect(db.createCandidateScheduleOptions({
      caseId: interviewCase.id,
      allocationIds: [first.id, second.id],
    })).toHaveLength(2);
    db.recordCandidateScheduleProposalSent(interviewCase.id);

    const confirmed = db.recordExternallyConfirmedCandidateSchedule({
      caseId: interviewCase.id,
      sourceEventId: "ninehire-confirmation-1",
      date: "2026-08-11",
      startTime: "14:00",
      endTime: "15:00",
    });

    expect(confirmed).toMatchObject({
      status: "CONFIRMED",
      scheduledDate: "2026-08-11",
      scheduledStartTime: "14:00",
      scheduledEndTime: "15:00",
    });
    expect(db.listCandidateScheduleOptions(interviewCase.id)).toMatchObject([
      { roomAllocationId: first.id, status: "RELEASED" },
      { roomAllocationId: second.id, status: "SELECTED" },
    ]);
    expect(db.listRoomAllocations(interviewCase.id)).toMatchObject([
      { id: first.id, status: "CANCELLED" },
      { id: second.id, status: "ACTIVE" },
    ]);
  });

  it("keeps sequential candidate proposal dates as room-allocation groups", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Sequential candidate",
      recruitmentName: "Recruitment",
      durationMinutes: 120,
      proposalDates: ["2026-08-10", "2026-08-11"],
    });
    db.upsertCaseInterviewPlan({
      caseId: interviewCase.id,
      source: "CANDIDATE_OVERRIDE",
      mode: "SEQUENTIAL",
      stepIds: ["S1", "S2"],
      stepNames: ["First", "Second"],
      sessions: [
        { stepId: "S1", stepName: "First", interviewerIds: [] },
        { stepId: "S2", stepName: "Second", interviewerIds: [] },
      ],
      durationMinutes: 120,
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    const blocks = db.syncMeetingRoomBlocks(
      ["2026-08-10", "2026-08-11"],
      [
        { sourceKey: "one-a", date: "2026-08-10", roomName: "Room 1" },
        { sourceKey: "one-b", date: "2026-08-10", roomName: "Room 2" },
        { sourceKey: "two-a", date: "2026-08-11", roomName: "Room 3" },
        { sourceKey: "two-b", date: "2026-08-11", roomName: "Room 4" },
      ].map((block) => ({
        sourceKey: `DAOU:${block.sourceKey}`,
        roomId: block.sourceKey,
        roomName: block.roomName,
        reservedBy: "Recruiter",
        purpose: "Interview",
        date: block.date,
        startTime: "09:00",
        endTime: "12:00",
        sourcePayloadHash: block.sourceKey,
      })),
    );
    const first = db.allocateSequentialRoomBlocks({
      caseId: interviewCase.id,
      sessions: [
        { stepId: "S1", roomBlockId: blocks[0]!.id, startTime: "09:00", endTime: "10:00" },
        { stepId: "S2", roomBlockId: blocks[1]!.id, startTime: "10:00", endTime: "11:00" },
      ],
    });
    const second = db.allocateSequentialRoomBlocks({
      caseId: interviewCase.id,
      sessions: [
        { stepId: "S1", roomBlockId: blocks[2]!.id, startTime: "09:00", endTime: "10:00" },
        { stepId: "S2", roomBlockId: blocks[3]!.id, startTime: "10:00", endTime: "11:00" },
      ],
      allowAdditionalForCase: true,
    });
    db.confirmSequentialInternalSchedule(interviewCase.id, first.map((allocation) => allocation.id));
    const options = db.createSequentialCandidateScheduleOptions({
      caseId: interviewCase.id,
      allocationGroups: [
        first.map((allocation) => allocation.id),
        second.map((allocation) => allocation.id),
      ],
    });
    expect(options).toHaveLength(2);
    expect(db.listCandidateScheduleOptionSegments(options[0]!.id)).toHaveLength(2);
    db.recordCandidateScheduleProposalSent(interviewCase.id);

    const confirmed = db.recordExternallyConfirmedCandidateSchedule({
      caseId: interviewCase.id,
      sourceEventId: "confirmation-2",
      date: "2026-08-11",
      startTime: "09:00",
      endTime: "11:00",
    });

    expect(confirmed).toMatchObject({
      status: "CONFIRMED",
      scheduledDate: "2026-08-11",
      scheduledStartTime: "09:00",
      scheduledEndTime: "11:00",
      scheduledRoomName: "Room 3 → Room 4",
    });
    expect(db.listCandidateScheduleOptions(interviewCase.id)).toMatchObject([
      { id: options[0]!.id, status: "RELEASED" },
      { id: options[1]!.id, status: "SELECTED" },
    ]);
    expect(db.listRoomAllocations(interviewCase.id)).toMatchObject([
      { id: first[0]!.id, status: "CANCELLED" },
      { id: first[1]!.id, status: "CANCELLED" },
      { id: second[0]!.id, status: "ACTIVE" },
      { id: second[1]!.id, status: "ACTIVE" },
    ]);
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
    db.recordCandidateScheduleProposalSent(interviewCase.id);
    expect(db.hasCandidateScheduleProposalSent(interviewCase.id)).toBe(true);
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
      proposalDates: ["2026-08-06"],
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
    expect(db.getCase(interviewCase.id)?.proposalDates).toEqual(["2026-08-06"]);
    expect(db.hasCandidateScheduleProposalSent(interviewCase.id)).toBe(false);
    expect(db.listCandidateScheduleOptions(interviewCase.id)).toMatchObject([
      { status: "RELEASED" },
    ]);

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

  it("keeps only the latest calendar schedule when an externally confirmed interview is rescheduled", () => {
    db = new BridgeDatabase(":memory:");
    db.syncExternalConfirmedInterviews([
      {
        sourceEventId: "NINEHIRE_SLACK:old-confirmation",
        title: "NineHire confirmed interview",
        rawText: "old confirmation",
        candidateName: "김병진",
        recruitmentName: "[휴넷] B2B 교육영업 담당 경력채용",
        date: "2026-08-20",
        startTime: "15:00",
        endTime: "16:00",
      },
      {
        sourceEventId: "DAOU_CALENDAR:old-calendar-event",
        title: "[면접] B2B교육영업 1차 인터뷰 (김병진)",
        rawText: "old calendar event",
        candidateName: "김병진",
        recruitmentName: "B2B교육영업 1차 인터뷰",
        date: "2026-08-20",
        startTime: "15:00",
        endTime: "16:00",
      },
    ]);

    db.syncExternalConfirmedInterviews([
      {
        sourceEventId: "DAOU_CALENDAR:new-calendar-event",
        title: "[면접] B2B교육영업 1차 인터뷰 (김병진)",
        rawText: "new calendar event",
        candidateName: "김병진",
        recruitmentName: "B2B교육영업 1차 인터뷰",
        date: "2026-08-24",
        startTime: "16:00",
        endTime: "17:00",
        roomName: "[818호] 열정룸",
      },
    ], { reconcileCalendarSnapshot: true });

    expect(db.listExternalConfirmedInterviews()).toEqual([
      expect.objectContaining({
        candidateName: "김병진",
        date: "2026-08-24",
        startTime: "16:00",
        endTime: "17:00",
        roomName: "[818호] 열정룸",
        sourceEventId: "DAOU_CALENDAR:new-calendar-event",
      }),
    ]);
  });

  it("updates an existing confirmed case when NineHire reports a changed schedule", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateRef: "C1",
      candidateName: "김병진",
      recruitmentRef: "R1",
      recruitmentName: "B2B 교육영업",
      proposalDates: ["2026-08-20"],
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    db.recordExternallyConfirmedSchedule({
      caseId: interviewCase.id,
      sourceEventId: "ninehire-original",
      source: "NINEHIRE_MCP",
      date: "2026-08-20",
      startTime: "15:00",
      endTime: "16:00",
    });

    const updated = db.reconcileConfirmedScheduleFromExternal({
      caseId: interviewCase.id,
      sourceEventId: "ninehire-rescheduled",
      source: "NINEHIRE_MCP",
      date: "2026-08-24",
      startTime: "16:00",
      endTime: "17:00",
    });

    expect(updated).toMatchObject({
      status: "CONFIRMED",
      scheduledDate: "2026-08-24",
      scheduledStartTime: "16:00",
      scheduledEndTime: "17:00",
      lastScheduledDate: "2026-08-20",
      lastScheduledStartTime: "15:00",
      lastScheduledEndTime: "16:00",
    });
    expect(db.listCaseEvents(interviewCase.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "EXTERNAL_CONFIRMED_SCHEDULE_UPDATED" }),
    ]));
  });
});
