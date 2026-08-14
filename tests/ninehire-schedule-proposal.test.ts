// 로컬 인터뷰 배정에서 나인하이어 제안 초안을 만드는 규칙을 검증한다.
import { describe, expect, it } from "vitest";
import { buildCandidateScheduleProposalDraft } from "../src/ninehire/schedule-proposal.js";

describe("나인하이어 일정 제안 초안", () => {
  it("필수이면서 활성인 현재 면접관만 내부 참석자로 사용한다", () => {
    const draft = buildCandidateScheduleProposalDraft({
      interviewCase: {
        id: "case-1",
        notificationId: null,
        candidateRef: "not-a-reference",
        candidateName: "테스트 후보자",
        recruitmentRef: "not-a-reference",
        recruitmentName: "[휴넷] 영업대표 채용 [정규직]",
        status: "AWAITING_CANDIDATE_CONFIRMATION",
        durationMinutes: 60,
        proposalDates: ["2026-08-20"],
        scheduleRound: 1,
        scheduledRoomAllocationId: null,
        scheduledRoomName: "[818호] 행복룸",
        scheduledDate: "2026-08-20",
        scheduledStartTime: "14:00",
        scheduledEndTime: "15:00",
        internalScheduleConfirmedAt: null,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
      plan: undefined,
      proposalOptions: [{
        id: "option-1",
        caseId: "case-1",
        roomAllocationId: "allocation-1",
        date: "2026-08-20",
        startTime: "14:00",
        endTime: "15:00",
        roomName: "[818호] 행복룸",
        status: "PROPOSED",
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      }],
      interviewers: [
        { id: "i-1", caseId: "case-1", ninehireUserId: "one", slackUserId: null, displayName: "필수 면접관", email: null, required: true, active: true, source: "NINEHIRE", status: "PENDING", respondedAt: null, createdAt: "", updatedAt: "" },
        { id: "i-2", caseId: "case-1", ninehireUserId: "two", slackUserId: null, displayName: "제외 면접관", email: null, required: true, active: false, source: "NINEHIRE", status: "EXCLUDED_UPSTREAM", respondedAt: null, createdAt: "", updatedAt: "" },
        { id: "i-3", caseId: "case-1", ninehireUserId: "three", slackUserId: null, displayName: "선택 면접관", email: null, required: false, active: true, source: "NINEHIRE", status: "PENDING", respondedAt: null, createdAt: "", updatedAt: "" },
      ],
      sentDate: "2026-08-18",
    });

    expect(draft.internalAttendeeNames).toEqual(["필수 면접관"]);
    expect(draft.title).toBe("[휴넷] 영업대표 채용 인터뷰");
    expect(draft.emailTemplateName).toBe("[✅서류 합격 메시지_일정 1개인 경우✅]");
  });
});
