// 로컬 인터뷰 배정을 나인하이어 일정 제안 입력값으로 바꾼다.
import type {
  CandidateScheduleOptionRow,
  CaseInterviewPlanRow,
  InterviewCaseRow,
  InterviewerRow,
} from "../db/database.js";
import { buildNinehireCandidateUrl } from "./app-link.js";
import {
  createCandidateScheduleProposalPreview,
  type CandidateScheduleProposalPreview,
} from "./schedule-proposal-policy.js";

export interface CandidateScheduleProposalDraft extends CandidateScheduleProposalPreview {
  caseId: string;
  candidateName: string;
  recruitmentName: string;
  candidateUrl?: string;
  internalAttendeeNames: string[];
}

function seoulDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function buildCandidateScheduleProposalDraft(input: {
  interviewCase: InterviewCaseRow;
  plan: CaseInterviewPlanRow | undefined;
  proposalOptions: CandidateScheduleOptionRow[];
  interviewers: InterviewerRow[];
  appUrl?: string;
  sentDate?: string;
}): CandidateScheduleProposalDraft {
  const candidateName = input.interviewCase.candidateName;
  const recruitmentName = input.interviewCase.recruitmentName;
  if (!candidateName || !recruitmentName) {
    throw new Error("후보자와 채용 정보가 있어야 나인하이어 일정 제안을 만들 수 있습니다.");
  }
  const proposalOptions = input.proposalOptions
    .filter((option) => option.status === "PROPOSED")
    .map((option) => ({
      date: option.date,
      startTime: option.startTime,
      endTime: option.endTime,
      roomName: option.roomName,
    }));
  const preview = createCandidateScheduleProposalPreview({
    recruitmentName,
    interviewStepNames: input.plan?.stepNames ?? [],
    durationMinutes: input.plan?.durationMinutes ?? input.interviewCase.durationMinutes,
    proposalOptions,
    sentDate: input.sentDate ?? seoulDate(),
  });
  const candidateUrl = buildNinehireCandidateUrl({
    appUrl: input.appUrl,
    recruitmentRef: input.interviewCase.recruitmentRef,
    candidateRef: input.interviewCase.candidateRef,
  });
  return {
    caseId: input.interviewCase.id,
    candidateName,
    recruitmentName,
    ...(candidateUrl ? { candidateUrl } : {}),
    internalAttendeeNames: input.interviewers
      .filter((interviewer) => interviewer.active && interviewer.required)
      .map((interviewer) => interviewer.displayName),
    ...preview,
  };
}
