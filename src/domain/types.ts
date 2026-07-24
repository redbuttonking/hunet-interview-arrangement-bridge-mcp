export type EvaluationDecision = "PASS" | "FAIL" | "REVIEW_REQUIRED";

export type InterviewCaseStatus =
  | "READY_FOR_DRAFT"
  | "DRAFT_CREATED"
  | "REQUEST_SENT"
  | "COLLECTING_AVAILABILITY"
  | "READY_TO_SCHEDULE"
  | "REVIEW_REQUIRED"
  | "CLOSED";

export type InterviewerStatus =
  | "PENDING"
  | "SUBMITTED"
  | "DECLINED_PENDING_REVIEW"
  | "EXCLUDED_BY_USER"
  | "EXCLUDED_UPSTREAM";

export interface CandidateContext {
  candidateRef?: string;
  candidateName?: string;
  recruitmentRef?: string;
  recruitmentName?: string;
}

export interface NinehireInterviewer {
  ninehireUserId: string;
  displayName: string;
  email?: string;
  required: boolean;
}

export interface EvaluationLookup {
  decision: EvaluationDecision;
  rawValue?: string;
  reason?: string;
}

export interface TimeSlot {
  date: string;
  start: string;
  end: string;
}

export interface SlackNotificationInput extends CandidateContext {
  channelId: string;
  messageTs: string;
  sourceBotId?: string;
  eventType: string;
  title: string;
  payloadHash: string;
  payloadJson: string;
}
