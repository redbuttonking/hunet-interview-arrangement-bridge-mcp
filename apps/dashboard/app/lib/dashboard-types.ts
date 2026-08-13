// 로컬 대시보드 화면에서 사용하는 운영 현황 데이터 형태를 정의한다.
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

export type CandidateCase = {
  id: string;
  candidateRef?: string | null;
  recruitmentRef?: string | null;
  candidateName: string | null;
  recruitmentName: string | null;
  status: InterviewCaseStatus;
  isReschedule: boolean;
  scheduledRoomName: string | null;
  scheduledDate: string | null;
  scheduledStartTime: string | null;
  scheduledEndTime: string | null;
  scheduledSegments: Array<{
    stepId: string | null;
    roomName: string;
    date: string;
    startTime: string;
    endTime: string;
  }>;
  candidateScheduleProposalSent: boolean;
  cancellationExternalFollowUps: Array<{
    id: string;
    followUpType: "NINEHIRE_CANDIDATE_SCHEDULE" | "DAOU_ROOM_RESERVATION";
    status: "PENDING" | "CONFIRMED" | "NOT_REQUIRED";
    createdAt: string;
    resolvedAt: string | null;
    resolutionNote: string | null;
  }>;
  interviewerResponses: {
    required: number;
    submitted: number;
    pending: number;
    declinedPendingReview: number;
  };
  needsAttention: boolean;
  interviewPlan: {
    mode: "STANDARD" | "COMBINED" | "SEQUENTIAL";
    stepNames: string[];
    durationMinutes: number;
  } | null;
  candidateJourney?: CandidateJourney | null;
};

export type CandidateJourney = {
  stages: Array<{
    id: string;
    label: string;
    state: "COMPLETED" | "CURRENT" | "UPCOMING" | "STOPPED";
    detail: string;
  }>;
  currentStageLabel: string;
  currentStageDetail: string;
};

export type Review = {
  id: string;
  caseId: string | null;
  reviewType: string;
  reason: string;
  candidateName: string | null;
  recruitmentName: string | null;
  currentStepName: string | null;
  evaluationSummary: EvaluationSummary | null;
  candidateJourney?: CandidateJourney | null;
  createdAt: string;
};

export type EvaluationSummary = {
  scoreSheets: Array<{
    title: string;
    evaluationMethod?: string;
    completedAt?: string;
    participantCount: number;
    evaluators: Array<{
      name: string;
      submittedAt?: string;
      comment?: string;
      items: Array<{
        title: string;
        finalEvaluation: boolean;
        selectedOptions: Array<{ title: string; score?: number }>;
        comment?: string;
      }>;
    }>;
  }>;
  currentStep?: { name: string; order?: number };
};

export type Decision = {
  id: string;
  skillKey: string;
  reviewId: string | null;
  caseId: string | null;
  decisionType: string;
  title: string;
  prompt: string;
  selectionMode: "SINGLE" | "MULTIPLE";
  options: Array<{ id: string; label: string; description: string }>;
  candidateName: string | null;
  recruitmentName: string | null;
  createdAt: string;
};

export type HeldWork = {
  id: string;
  kind: "REVIEW" | "CASE";
  candidateName: string | null;
  recruitmentName: string | null;
  detail: string;
  heldAt: string;
};

export type DashboardSnapshot = {
  dashboard: {
    generatedAt: string;
    summary: {
      caseCountsByStatus: Record<InterviewCaseStatus, number>;
      openReviews: number;
      pendingRequiredInterviewerResponses: number;
      pendingIntegrationRetries: number;
      failedIntegrationRetries: number;
      worker: { status: string; lastSuccessfulCycleAt?: string | null };
      freshness: {
        slack: DataFreshness;
        ninehire: DataFreshness;
        daouOffice: DataFreshness;
        daouOfficeCalendar: DataFreshness;
        worker: DataFreshness;
      };
    };
    cases: CandidateCase[];
  };
  reviews: Review[];
  decisions: Decision[];
  heldWork: HeldWork[];
  meetingRoomBlocks: Array<{
    id: string;
    roomName: string;
    date: string;
    startTime: string;
    endTime: string;
  }>;
  externalConfirmedInterviews?: Array<{
    id: string;
    candidateName: string;
    recruitmentName: string;
    date: string;
    startTime: string;
    endTime: string;
    roomName: string | null;
    linkedCaseId: string | null;
    lastSeenAt: string;
  }>;
};

export type DataFreshness = {
  lastSuccessfulAt: string | null;
  state: "FRESH" | "STALE" | "UNKNOWN";
};
