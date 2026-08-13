// 후보자 여정에서 일정과 평가 상태를 구분해 표시하는지 검증한다.
import { describe, expect, it } from "vitest";
import type { InterviewCaseRow, RecruitmentInterviewTemplateRow } from "../src/db/database.js";
import { buildCandidateJourney } from "../src/dashboard/candidate-journey.js";

const template: RecruitmentInterviewTemplateRow = {
  recruitmentId: "R1",
  recruitmentName: "테스트 채용",
  pipelineHash: "pipeline",
  steps: [{
    stepId: "S1",
    title: "1차 인터뷰",
    name: "1차 인터뷰",
    order: 2,
    mode: "STANDARD",
    durationMinutes: 60,
  }],
  routes: [{ triggerStepId: "S1", mode: "STANDARD", stepIds: ["S1"] }],
  approvedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const multiStageTemplate: RecruitmentInterviewTemplateRow = {
  ...template,
  steps: [
    { stepId: "S1", title: "실무자·임원 면접", name: "실무자·임원 면접", order: 2, mode: "COMBINED", durationMinutes: 60 },
    { stepId: "S2", title: "CEO 인터뷰", name: "CEO 인터뷰", order: 3, mode: "STANDARD", durationMinutes: 60 },
  ],
  routes: [
    { triggerStepId: "S1", mode: "COMBINED", stepIds: ["S1"] },
    { triggerStepId: "S2", mode: "STANDARD", stepIds: ["S2"] },
  ],
};

function confirmedCase(date: string): InterviewCaseRow {
  return {
    id: "case-1",
    notificationId: null,
    candidateRef: "C1",
    candidateName: "테스트 후보자",
    recruitmentRef: "R1",
    recruitmentName: "테스트 채용",
    status: "CONFIRMED",
    durationMinutes: 60,
    proposalDates: [date],
    scheduleRound: 1,
    scheduledRoomAllocationId: null,
    scheduledRoomName: null,
    scheduledDate: date,
    scheduledStartTime: "10:00",
    scheduledEndTime: "11:00",
    internalScheduleConfirmedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("candidate journey", () => {
  it("shows a future confirmed schedule as an upcoming interview", () => {
    const journey = buildCandidateJourney({
      template,
      interviewCase: confirmedCase("2099-01-01"),
      plannedStepIds: ["S1"],
    });

    expect(journey?.currentStageDetail).toBe("2099-01-01 10:00 인터뷰 예정");
  });

  it("shows evaluation progress after a confirmed interview has ended", () => {
    const journey = buildCandidateJourney({
      template,
      interviewCase: confirmedCase("2000-01-01"),
      plannedStepIds: ["S1"],
      evaluationStatus: "IN_PROGRESS",
    });

    expect(journey?.currentStageDetail).toBe("평가 진행 중");
  });

  it("shows evaluation completion after every required evaluation is submitted", () => {
    const journey = buildCandidateJourney({
      template,
      interviewCase: confirmedCase("2000-01-01"),
      plannedStepIds: ["S1"],
      evaluationStatus: "COMPLETED",
    });

    expect(journey?.currentStageDetail).toBe("평가 완료");
  });

  it("shows a confirmed final interview in green while keeping the final result pending", () => {
    const journey = buildCandidateJourney({
      template: multiStageTemplate,
      currentStepId: "S2",
      interviewCase: confirmedCase("2099-01-01"),
    });

    expect(journey?.stages.map((stage) => [stage.label, stage.state, stage.detail])).toEqual([
      ["서류 평가", "COMPLETED", "완료"],
      ["실무자·임원 1day 인터뷰", "COMPLETED", "완료"],
      ["CEO 인터뷰", "SCHEDULED", "2099-01-01 10:00 인터뷰 예정"],
      ["최종 결과", "UPCOMING", "결과 대기"],
    ]);
  });
});
