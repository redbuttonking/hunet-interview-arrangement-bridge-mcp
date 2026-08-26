// 나인하이어 후보자 일정 제안의 고정 정책을 검증한다.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERVIEW_LOCATION,
  UI_MUNDANG_INTERVIEW_LOCATION,
  createCandidateScheduleProposalPreview,
  deriveInterviewRound,
  locationForInterviewRoom,
  removeEmploymentSuffix,
} from "../src/ninehire/schedule-proposal-policy.js";

const options = [{
  date: "2026-08-20",
  startTime: "14:00",
  endTime: "15:00",
  roomName: "[818호] 행복룸",
}];

describe("나인하이어 일정 제안 정책", () => {
  it("채용 제목의 고용형태 꼬리표만 제거한다", () => {
    expect(removeEmploymentSuffix("[휴넷] 영업대표 채용 [정규직]")).toBe("[휴넷] 영업대표 채용");
    expect(removeEmploymentSuffix("[휴넷] AI 강사 채용 [3년 이상]")).toBe("[휴넷] AI 강사 채용 [3년 이상]");
  });

  it("대기업·공공기업 영업의 1day 인터뷰 제목을 만든다", () => {
    expect(deriveInterviewRound({
      recruitmentName: "[휴넷] 2026 B2B 교육영업 담당 경력채용 (대기업, 공공기업 영업) [정규직]",
      interviewStepNames: ["실무자, 임원 면접"],
    })).toBe("1,2차 인터뷰");
  });

  it("의문당만 7층 장소를 사용한다", () => {
    expect(locationForInterviewRoom("[710호] 疑問堂(의문당)")).toBe(UI_MUNDANG_INTERVIEW_LOCATION);
    expect(locationForInterviewRoom("[818호] 행복룸")).toBe(DEFAULT_INTERVIEW_LOCATION);
  });

  it("1차 인터뷰 한 개 일정에는 단일 일정 템플릿과 1일 회신 기한을 쓴다", () => {
    const preview = createCandidateScheduleProposalPreview({
      recruitmentName: "[휴넷] 영업대표 채용 [정규직]",
      interviewStepNames: ["1차 인터뷰"],
      durationMinutes: 60,
      proposalOptions: options,
      sentDate: "2026-08-18",
    });
    expect(preview.title).toBe("[휴넷] 영업대표 채용 1차 인터뷰");
    expect(preview.emailTemplateName).toBe("[✅서류 합격 메시지_일정 1개인 경우✅]");
    expect(preview.replyDeadlineDays).toBe(1);
  });

  it("CEO 인터뷰는 템플릿을 임의로 선택하지 않는다", () => {
    const preview = createCandidateScheduleProposalPreview({
      recruitmentName: "[휴넷] 영업대표 채용 [정규직]",
      interviewStepNames: ["CEO 인터뷰"],
      durationMinutes: 60,
      proposalOptions: [...options, { ...options[0]!, date: "2026-08-21" }],
      sentDate: "2026-08-18",
    });
    expect(preview.emailTemplateName).toBeNull();
    expect(preview.requiresEmailTemplateSelection).toBe(true);
  });

  it("서로 다른 회의실 후보일도 함께 제안한다", () => {
    const preview = createCandidateScheduleProposalPreview({
      recruitmentName: "[휴넷] 영업대표 채용 [정규직]",
      interviewStepNames: ["1차 인터뷰"],
      durationMinutes: 60,
      proposalOptions: [
        options[0]!,
        {
          date: "2026-08-21",
          startTime: "14:00",
          endTime: "15:00",
          roomName: "[710호] 疑問堂(의문당)",
        },
      ],
      sentDate: "2026-08-18",
    });

    expect(preview.proposalOptions).toHaveLength(2);
    expect(preview.location).toBe(DEFAULT_INTERVIEW_LOCATION);
  });

  it("후보일이 모두 의문당이면 7층 장소를 안내한다", () => {
    const preview = createCandidateScheduleProposalPreview({
      recruitmentName: "[휴넷] 영업대표 채용 [정규직]",
      interviewStepNames: ["1차 인터뷰"],
      durationMinutes: 60,
      proposalOptions: [
        {
          date: "2026-08-20",
          startTime: "14:00",
          endTime: "15:00",
          roomName: "[710호] 疑問堂(의문당)",
        },
        {
          date: "2026-08-21",
          startTime: "14:00",
          endTime: "15:00",
          roomName: "[710호] 疑問堂(의문당)",
        },
      ],
      sentDate: "2026-08-18",
    });

    expect(preview.location).toBe(UI_MUNDANG_INTERVIEW_LOCATION);
  });
});
