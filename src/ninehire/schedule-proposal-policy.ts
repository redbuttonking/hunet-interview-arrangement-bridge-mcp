// 나인하이어 후보자 일정 제안의 고정 제목·장소·템플릿 규칙을 만든다.

export interface CandidateScheduleProposalOption {
  date: string;
  startTime: string;
  endTime: string;
  roomName: string;
}

export interface CandidateScheduleProposalPolicyInput {
  recruitmentName: string;
  interviewStepNames: string[];
  durationMinutes: number;
  proposalOptions: CandidateScheduleProposalOption[];
  sentDate: string;
}

export interface CandidateScheduleProposalPreview {
  title: string;
  interviewRound: string;
  notice: string;
  location: string;
  durationMinutes: number;
  replyDeadlineDays: 1 | 2;
  emailTemplateName: string | null;
  requiresEmailTemplateSelection: boolean;
  proposalOptions: CandidateScheduleProposalOption[];
}

export const DEFAULT_SCHEDULE_NOTICE = "도착 후 070-5210-4810으로 연락 바랍니다!";
export const DEFAULT_INTERVIEW_LOCATION = "서울시 구로구 디지털로 26길 5 에이스하이엔드타워 1차 8층 816호(주차가능)";
export const UI_MUNDANG_INTERVIEW_LOCATION = "서울시 구로구 디지털로 26길 5 에이스하이엔드타워 1차 7층 709호(주차가능)";

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("ko-KR");
}

export function removeEmploymentSuffix(recruitmentName: string): string {
  return recruitmentName
    .replace(/\s*\[(?:정규직|계약직|인턴|신입|경력(?:직)?)\]\s*$/u, "")
    .trim();
}

export function deriveInterviewRound(input: {
  recruitmentName: string;
  interviewStepNames: string[];
}): string {
  const steps = input.interviewStepNames.join(" ");
  const text = normalized(`${input.recruitmentName} ${steps}`);
  if (/ceo|최종.*인터뷰/.test(text)) return "CEO 인터뷰";
  if (/대기업.*공공기업/.test(text) && /(?:실무자|임원|1차|2차)/.test(text)) {
    return "1,2차 인터뷰";
  }
  if (/2차/.test(text)) return "2차 인터뷰";
  if (/1차/.test(text)) return "1차 인터뷰";
  if (/시강/.test(text)) return "면접(시강)";
  const firstStep = input.interviewStepNames[0]?.trim();
  return firstStep?.includes("인터뷰")
    ? firstStep
    : firstStep
      ? `${firstStep} 인터뷰`
      : "인터뷰";
}

export function locationForInterviewRoom(roomName: string): string {
  return /의문당|疑問堂/u.test(roomName)
    ? UI_MUNDANG_INTERVIEW_LOCATION
    : DEFAULT_INTERVIEW_LOCATION;
}

function locationForProposalOptions(options: CandidateScheduleProposalOption[]): string {
  return options.every(
    (option) => locationForInterviewRoom(option.roomName) === UI_MUNDANG_INTERVIEW_LOCATION,
  )
    ? UI_MUNDANG_INTERVIEW_LOCATION
    : DEFAULT_INTERVIEW_LOCATION;
}

function daysBetween(date: string, laterDate: string): number {
  const start = new Date(`${date}T00:00:00+09:00`).getTime();
  const end = new Date(`${laterDate}T00:00:00+09:00`).getTime();
  return Math.round((end - start) / 86_400_000);
}

export function replyDeadlineDays(input: {
  sentDate: string;
  proposalOptions: CandidateScheduleProposalOption[];
}): 1 | 2 {
  const firstDate = [...input.proposalOptions]
    .map((option) => option.date)
    .sort()[0];
  if (!firstDate) throw new Error("후보자에게 제안할 일정이 하나 이상 필요합니다.");
  return daysBetween(input.sentDate, firstDate) <= 2 ? 1 : 2;
}

export function selectScheduleProposalEmailTemplate(input: {
  interviewRound: string;
  proposalOptionCount: number;
}): string | null {
  const oneOption = input.proposalOptionCount === 1;
  if (/ceo|최종/u.test(normalized(input.interviewRound))) return null;
  if (/2차/u.test(input.interviewRound)) {
    return oneOption
      ? "[✅1차 인터뷰 합격 메시지_일정 1개인 경우✅]"
      : "[✅1차 인터뷰 합격 메시지✅]";
  }
  return oneOption
    ? "[✅서류 합격 메시지_일정 1개인 경우✅]"
    : "[✅서류 합격 메시지✅]";
}

export function createCandidateScheduleProposalPreview(
  input: CandidateScheduleProposalPolicyInput,
): CandidateScheduleProposalPreview {
  if (input.proposalOptions.length === 0) {
    throw new Error("후보자에게 제안할 일정이 하나 이상 필요합니다.");
  }
  const interviewRound = deriveInterviewRound(input);
  const template = selectScheduleProposalEmailTemplate({
    interviewRound,
    proposalOptionCount: input.proposalOptions.length,
  });
  return {
    title: `${removeEmploymentSuffix(input.recruitmentName)} ${interviewRound}`,
    interviewRound,
    notice: DEFAULT_SCHEDULE_NOTICE,
    location: locationForProposalOptions(input.proposalOptions),
    durationMinutes: input.durationMinutes,
    replyDeadlineDays: replyDeadlineDays(input),
    emailTemplateName: template,
    requiresEmailTemplateSelection: template === null,
    proposalOptions: input.proposalOptions,
  };
}
