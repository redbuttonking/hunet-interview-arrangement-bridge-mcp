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
});
