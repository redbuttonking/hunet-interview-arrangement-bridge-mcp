// 인터뷰 업무 스킬과 대시보드 선택 흐름에서 공유하는 결정 형식을 정의한다.
export type InterviewSkillKey =
  | "OPERATIONS_CONTROL"
  | "OPERATIONS_RECOVERY"
  | "CANDIDATE_TRIAGE"
  | "AVAILABILITY_COLLECTION"
  | "INTERVIEW_SCHEDULING"
  | "CANDIDATE_SCHEDULE_PROPOSAL"
  | "CANDIDATE_SCHEDULE_RESPONSE";

export type InterviewSkillDecisionStatus = "PENDING" | "RESOLVED";

export type InterviewSkillSelectionMode = "SINGLE" | "MULTIPLE";

export interface InterviewSkillDecisionOption {
  id: string;
  label: string;
  description: string;
}

export interface InterviewSkillDecisionInput {
  skillKey: InterviewSkillKey;
  decisionType: string;
  fingerprint: string;
  title: string;
  prompt: string;
  selectionMode: InterviewSkillSelectionMode;
  options: InterviewSkillDecisionOption[];
  context: Record<string, unknown>;
  caseId?: string;
  reviewId?: string;
}
