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
  | "CLOSED";

export type CandidateCase = {
  id: string;
  candidateName: string | null;
  recruitmentName: string | null;
  status: InterviewCaseStatus;
  isReschedule: boolean;
  scheduledRoomName: string | null;
  scheduledDate: string | null;
  scheduledStartTime: string | null;
  scheduledEndTime: string | null;
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
};

export type Review = {
  id: string;
  caseId: string | null;
  reviewType: string;
  reason: string;
  candidateName: string | null;
  recruitmentName: string | null;
  currentStepName: string | null;
  createdAt: string;
};

export type Decision = {
  id: string;
  reviewId: string | null;
  caseId: string | null;
  decisionType: string;
  title: string;
  prompt: string;
  options: Array<{ id: string; label: string; description: string }>;
  candidateName: string | null;
  recruitmentName: string | null;
  createdAt: string;
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
    };
    cases: CandidateCase[];
  };
  reviews: Review[];
  decisions: Decision[];
  meetingRoomBlocks: Array<{
    id: string;
    roomName: string;
    date: string;
    startTime: string;
    endTime: string;
  }>;
};
