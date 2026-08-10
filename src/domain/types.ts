export type InterviewCaseStatus =
  | "READY_FOR_DRAFT"
  | "DRAFT_CREATED"
  | "REQUEST_SENT"
  | "COLLECTING_AVAILABILITY"
  | "READY_TO_SCHEDULE"
  | "AWAITING_CANDIDATE_CONFIRMATION"
  | "CONFIRMED"
  | "CANCELLED"
  | "REVIEW_REQUIRED"
  | "ON_HOLD"
  | "CLOSED";

export type RescheduleAvailabilityPolicy = "REUSE" | "RECOLLECT";

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

export interface NinehireCandidateSchedule {
  eventId: string;
  candidateRef: string;
  candidateName: string;
  recruitmentRef: string;
  recruitmentName: string;
  date: string;
  startTime: string;
  endTime: string;
  location?: string;
  attendeeNames: string[];
}

export interface NinehireInterviewer {
  ninehireUserId: string;
  displayName: string;
  email?: string;
  required: boolean;
}

export interface InterviewerLookup {
  interviewers: NinehireInterviewer[];
  unresolvedUserGroups: string[];
  reason?: string;
}

export interface NinehireRecruitmentSummary {
  recruitmentId: string;
  title: string;
  externalTitle?: string;
  status: string;
  closedAt?: string;
  deadlineType?: string;
  deadlineValue?: string;
  isPrivate: boolean;
}

export interface NinehireRecruitmentList {
  count: number;
  limit: number;
  offset: number;
  recruitments: NinehireRecruitmentSummary[];
}

export interface RecruitmentPipelineStep {
  stepId: string;
  title: string;
  name: string;
  order: number;
  applicantCount: number;
}

export interface RecruitmentPipeline {
  recruitmentId: string;
  recruitmentName: string;
  steps: RecruitmentPipelineStep[];
}

export interface EvaluationOptionSummary {
  title: string;
  score?: number;
}

export interface EvaluationItemSummary {
  title: string;
  finalEvaluation: boolean;
  selectedOptions: EvaluationOptionSummary[];
  comment?: string;
}

export interface EvaluatorSummary {
  name: string;
  submittedAt?: string;
  comment?: string;
  items: EvaluationItemSummary[];
}

export interface ScoreSheetSummary {
  scoreSheetId: string;
  title: string;
  evaluationMethod?: string;
  completedAt?: string;
  participants: string[];
  evaluators: EvaluatorSummary[];
}

export interface EvaluationSummary {
  applicantProgressId: string;
  recruitmentId: string;
  currentStatus?: string;
  scoreSheets: ScoreSheetSummary[];
  currentStep?: {
    stepId: string;
    name: string;
    order?: number;
  };
}

export interface EvaluationLookup {
  context?: CandidateContext;
  summary?: EvaluationSummary;
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
