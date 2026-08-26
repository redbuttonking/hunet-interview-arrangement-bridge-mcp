// 로컬 대시보드에 제공하는 운영 현황과 후보자 이력을 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../src/db/database.js";
import { getDashboardSnapshot } from "../src/dashboard/service.js";

let db: BridgeDatabase | undefined;

afterEach(() => db?.close());

describe("dashboard service", () => {
  it("returns an operational case with its interview plan, review, decision, and room block", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "대시보드 테스트",
      recruitmentRef: "R1",
      recruitmentName: "인터뷰 어레인지 테스트 채용",
      proposalDates: ["2026-08-10"],
    });
    db.upsertCaseInterviewPlan({
      caseId: interviewCase.id,
      source: "TEMPLATE",
      mode: "STANDARD",
      stepIds: ["S1"],
      stepNames: ["1차 인터뷰"],
      durationMinutes: 60,
    });
    const reviewId = db.createReview({
      caseId: interviewCase.id,
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "사용자 승인이 필요합니다.",
      summary: {
        context: {
          candidateName: "대시보드 테스트",
          recruitmentName: "인터뷰 어레인지 테스트 채용",
        },
        evaluation: {
          applicantProgressId: "AP1",
          recruitmentId: "R1",
          currentStep: { stepId: "S1", name: "서류 평가", order: 1 },
          scoreSheets: [{
            scoreSheetId: "SS1",
            title: "서류전형 평가표",
            completedAt: "2026-08-02T09:00:00.000Z",
            participants: ["대시보드 테스트"],
            evaluators: [{
              name: "평가자",
              comment: "<ul><li>인터뷰를 추천합니다.</li><li>후속 인터뷰도 권장합니다.</li></ul>",
              items: [{
                title: "최종 의견",
                finalEvaluation: true,
                selectedOptions: [{ title: "합격", score: 5 }],
              }],
            }],
          }],
        },
      },
    });
    db.createOrGetPendingInterviewSkillDecision({
      skillKey: "CANDIDATE_TRIAGE",
      decisionType: "START_INTERVIEW_ARRANGEMENT",
      fingerprint: `review:${reviewId}:start`,
      reviewId,
      caseId: interviewCase.id,
      title: "인터뷰 조율 시작",
      prompt: "다음 작업을 선택하세요.",
      selectionMode: "SINGLE",
      options: [{ id: "START", label: "시작", description: "조율을 시작합니다." }],
      context: {
        candidateName: "대시보드 테스트",
        recruitmentName: "인터뷰 어레인지 테스트 채용",
      },
    });
    db.syncMeetingRoomBlocks(["2026-08-10"], [{
      sourceKey: "DAOU:dashboard-test",
      roomId: "ROOM1",
      roomName: "행복룸",
      reservedBy: "채용 담당자",
      purpose: "인터뷰",
      date: "2026-08-10",
      startTime: "09:00",
      endTime: "12:00",
      sourcePayloadHash: "dashboard-test",
    }]);
    db.setCursor("sync:slack:last_success", new Date().toISOString());
    db.setCursor("sync:ninehire:last_success", new Date().toISOString());

    const snapshot = getDashboardSnapshot(db);

    expect(snapshot.dashboard.summary).toEqual(expect.objectContaining({
      freshness: expect.objectContaining({
        slack: expect.objectContaining({ state: "FRESH" }),
        ninehire: expect.objectContaining({ state: "FRESH" }),
        daouOffice: expect.objectContaining({ state: "FRESH" }),
      }),
    }));

    expect(snapshot.dashboard.cases).toEqual([
      expect.objectContaining({
        id: interviewCase.id,
        candidateName: "대시보드 테스트",
        interviewPlan: {
          mode: "STANDARD",
          stepNames: ["1차 인터뷰"],
          durationMinutes: 60,
        },
      }),
    ]);
    expect(snapshot.reviews).toEqual([
      expect.objectContaining({
        id: reviewId,
        candidateName: "대시보드 테스트",
        evaluationSummary: expect.objectContaining({
          currentStep: { name: "서류 평가", order: 1 },
          scoreSheets: [expect.objectContaining({
            title: "서류전형 평가표",
            evaluators: [expect.objectContaining({
              name: "평가자",
              comment: "• 인터뷰를 추천합니다.\n• 후속 인터뷰도 권장합니다.",
            })],
          })],
        }),
      }),
    ]);
    expect(snapshot.decisions).toEqual([
      expect.objectContaining({ candidateName: "대시보드 테스트" }),
    ]);
    expect(snapshot.meetingRoomBlocks).toEqual([
      expect.objectContaining({ roomName: "행복룸", date: "2026-08-10" }),
    ]);
    expect(db.listCaseEvents(interviewCase.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "CASE_CREATED", caseId: interviewCase.id }),
    ]));
  });

  it("separates held interview work from the active action queue", () => {
    db = new BridgeDatabase(":memory:");
    const heldCase = db.createInterviewCase({
      candidateName: "Held candidate",
      recruitmentName: "Recruitment",
      proposalDates: ["2026-08-10"],
    });
    db.holdInterviewCase({ caseId: heldCase.id });
    const heldReviewId = db.createReview({
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "Approval is postponed.",
      summary: { context: { candidateName: "Held review candidate", recruitmentName: "Recruitment" } },
    });
    db.resolveReview(heldReviewId, "HOLD");

    const snapshot = getDashboardSnapshot(db);

    expect(snapshot.dashboard.cases).toEqual([]);
    expect(snapshot.heldWork).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: heldCase.id, kind: "CASE", candidateName: "Held candidate" }),
      expect.objectContaining({ id: heldReviewId, kind: "REVIEW", candidateName: "Held review candidate" }),
    ]));
  });

  it("includes a pending interviewer request draft for queue-side approval", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "초안 확인 후보자",
      recruitmentName: "초안 확인 채용",
      proposalDates: ["2026-08-21"],
    });
    db.createDraft({
      caseId: interviewCase.id,
      channelId: "C-DRAFT",
      previewText: "면접 가능 일정을 입력해 주세요.",
      blocksJson: "[]",
      payloadHash: "dashboard-pending-draft",
      messageType: "INTERVIEWER_REQUEST",
    });

    const snapshot = getDashboardSnapshot(db);

    expect(snapshot.dashboard.cases).toEqual([
      expect.objectContaining({
        id: interviewCase.id,
        pendingDrafts: [expect.objectContaining({
          messageType: "INTERVIEWER_REQUEST",
          status: "DRAFT",
        })],
      }),
    ]);
  });

  it("includes interviewer names and individual submission states for availability waiting", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "Availability candidate",
      recruitmentName: "Availability recruitment",
      proposalDates: ["2026-08-21"],
    });
    const submitted = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      slackUserId: "U-SUBMITTED",
      displayName: "Submitted interviewer",
      source: "MANUAL",
    });
    db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      slackUserId: "U-PENDING",
      displayName: "Pending interviewer",
      source: "MANUAL",
    });
    db.setCaseStatus(interviewCase.id, "REQUEST_SENT");
    db.replaceAvailabilityForInterviewer(interviewCase.id, submitted.id, [{
      date: "2026-08-21",
      start: "10:00",
      end: "11:00",
    }]);
    db.createOrGetPendingInterviewSkillDecision({
      skillKey: "AVAILABILITY_COLLECTION",
      decisionType: "WAIT_FOR_AVAILABILITY",
      fingerprint: `wait:${interviewCase.id}`,
      caseId: interviewCase.id,
      title: "Availability waiting",
      prompt: "Wait for availability.",
      selectionMode: "SINGLE",
      options: [{ id: "WAIT", label: "Wait", description: "Keep waiting." }],
      context: {},
    });

    const snapshot = getDashboardSnapshot(db);

    expect(snapshot.dashboard.cases[0]).toMatchObject({
      interviewerResponses: {
        submitted: 1,
        pending: 1,
        interviewers: expect.arrayContaining([
          { displayName: "Submitted interviewer", status: "SUBMITTED" },
          { displayName: "Pending interviewer", status: "PENDING" },
        ]),
      },
    });
    expect(snapshot.decisions[0]).toMatchObject({
      interviewerAvailability: expect.arrayContaining([
        expect.objectContaining({ displayName: "Submitted interviewer", submitted: true }),
        expect.objectContaining({ displayName: "Pending interviewer", submitted: false }),
      ]),
    });
  });

  it("uses the linked case when an operational review has no candidate summary", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "오현서",
      recruitmentName: "중견기업 영업",
      proposalDates: ["2026-08-18"],
    });
    db.upsertCaseInterviewPlan({
      caseId: interviewCase.id,
      source: "TEMPLATE",
      mode: "COMBINED",
      stepIds: ["S1"],
      stepNames: ["실무자 + 임원 면접"],
      durationMinutes: 60,
    });
    db.createReview({
      caseId: interviewCase.id,
      reviewType: "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED",
      reason: "Slack worker downtime may have missed availability.",
    });

    const snapshot = getDashboardSnapshot(db);

    expect(snapshot.reviews).toEqual([
      expect.objectContaining({
        candidateName: "오현서",
        recruitmentName: "중견기업 영업",
        currentStepName: "실무자 + 임원 면접",
      }),
    ]);
  });

  it("uses a direct review summary when no interview case exists yet", () => {
    db = new BridgeDatabase(":memory:");
    db.createReview({
      reviewType: "NINEHIRE_CONFIRMED_SCHEDULE_ROOM_UNAVAILABLE",
      reason: "No synchronized meeting room is available.",
      summary: {
        candidateName: "Direct schedule candidate",
        recruitmentName: "Direct schedule recruitment",
      },
    });

    const snapshot = getDashboardSnapshot(db);

    expect(snapshot.reviews).toEqual([
      expect.objectContaining({
        candidateName: "Direct schedule candidate",
        recruitmentName: "Direct schedule recruitment",
      }),
    ]);
  });

  it("shows the Slack candidate context when an evaluation lookup failed", () => {
    db = new BridgeDatabase(":memory:");
    const notification = db.insertNotification({
      channelId: "C-DASHBOARD",
      messageTs: "1724112000.000100",
      eventType: "EVALUATION_COMPLETED",
      title: "평가표 제출이 완료되었습니다.",
      candidateName: "평가 조회 후보자",
      candidateRef: "https://app.ninehire.com/applicant-progress/1",
      recruitmentName: "평가 조회 채용",
      recruitmentRef: "R-EVALUATION",
      payloadHash: "evaluation-lookup-failed",
      payloadJson: "{}",
    }, "ERROR");
    db.createReview({
      notificationId: notification.id,
      reviewType: "EVALUATION_LOOKUP_FAILED",
      reason: "나인하이어 API 요청 한도를 초과했습니다.",
    });

    const snapshot = getDashboardSnapshot(db);

    expect(snapshot.reviews).toEqual([
      expect.objectContaining({
        candidateName: "평가 조회 후보자",
        recruitmentName: "평가 조회 채용",
      }),
    ]);
  });

  it("shows a recruitment-specific journey instead of a fixed scheduling sequence", () => {
    db = new BridgeDatabase(":memory:");
    db.upsertRecruitmentInterviewTemplate({
      recruitmentId: "R-JOURNEY",
      recruitmentName: "1day 및 CEO 인터뷰 채용",
      pipelineHash: "journey-pipeline",
      steps: [
        {
          stepId: "S-ONE-DAY",
          title: "실무자 , 임원 면접",
          name: "실무자 , 임원 면접",
          order: 2,
          mode: "COMBINED",
          durationMinutes: 60,
        },
        {
          stepId: "S-CEO",
          title: "CEO 인터뷰",
          name: "CEO 인터뷰",
          order: 3,
          mode: "STANDARD",
          durationMinutes: 60,
        },
      ],
      routes: [
        { triggerStepId: "S-ONE-DAY", mode: "COMBINED", stepIds: ["S-ONE-DAY"] },
        { triggerStepId: "S-CEO", mode: "STANDARD", stepIds: ["S-CEO"] },
      ],
    });
    db.createReview({
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason: "CEO 인터뷰 조율 승인 필요",
      summary: {
        context: {
          candidateRef: "C-JOURNEY",
          candidateName: "여정 후보자",
          recruitmentRef: "R-JOURNEY",
          recruitmentName: "1day 및 CEO 인터뷰 채용",
        },
        evaluation: {
          applicantProgressId: "C-JOURNEY",
          recruitmentId: "R-JOURNEY",
          currentStep: { stepId: "S-CEO", name: "CEO 인터뷰", order: 3 },
          scoreSheets: [{
            scoreSheetId: "CEO-READY",
            title: "2차 인터뷰 전형 평가표",
            evaluators: [],
          }],
        },
      },
    });

    const snapshot = getDashboardSnapshot(db);

    expect(snapshot.reviews[0]?.candidateJourney).toEqual({
      currentStageLabel: "CEO 인터뷰",
      currentStageDetail: "일정 조율 시작 대기",
      stages: [
        expect.objectContaining({ label: "서류 평가", state: "COMPLETED", detail: "완료" }),
        expect.objectContaining({ label: "실무자·임원 1day 인터뷰", state: "COMPLETED", detail: "완료" }),
        expect.objectContaining({ label: "CEO 인터뷰", state: "CURRENT", detail: "일정 조율 시작 대기" }),
        expect.objectContaining({ label: "최종 결과", state: "UPCOMING", detail: "결과 대기" }),
      ],
    });
  });
});
