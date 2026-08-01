// 로컬 운영 대시보드에 필요한 최소 정보를 조합한다.
import { BridgeDatabase, type InterviewSkillDecisionRow, type ReviewRow } from "../db/database.js";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function reviewContext(review: ReviewRow) {
  const context = review.summary?.context;
  const summaryContext = context && typeof context === "object" && !Array.isArray(context)
    ? context as Record<string, unknown>
    : undefined;
  const evaluation = review.summary?.evaluation;
  const currentStep = evaluation && typeof evaluation === "object"
    ? (evaluation as { currentStep?: { name?: unknown } }).currentStep
    : undefined;
  return {
    candidateName: text(summaryContext?.candidateName),
    recruitmentName: text(summaryContext?.recruitmentName),
    currentStepName: text(currentStep?.name),
  };
}

function decisionSummary(decision: InterviewSkillDecisionRow) {
  return {
    id: decision.id,
    skillKey: decision.skillKey,
    decisionType: decision.decisionType,
    title: decision.title,
    prompt: decision.prompt,
    selectionMode: decision.selectionMode,
    options: decision.options,
    reviewId: decision.reviewId ?? null,
    caseId: decision.caseId ?? null,
    candidateName: text(decision.context.candidateName),
    recruitmentName: text(decision.context.recruitmentName),
    createdAt: decision.createdAt,
  };
}

export function getDashboardSnapshot(db: BridgeDatabase, limit = 100) {
  const dashboard = db.getOperationsDashboard(limit);
  const reviews = db.listOpenReviews(limit).map((review) => ({
    id: review.id,
    caseId: review.caseId,
    reviewType: review.reviewType,
    reason: review.reason,
    createdAt: review.createdAt,
    ...reviewContext(review),
  }));
  const decisions = db
    .listInterviewSkillDecisions({ status: "PENDING", limit })
    .map(decisionSummary);

  return {
    dashboard,
    reviews,
    decisions,
    meetingRoomBlocks: db.listMeetingRoomBlocks().map((block) => ({
      id: block.id,
      roomName: block.roomName,
      date: block.date,
      startTime: block.startTime,
      endTime: block.endTime,
    })),
  };
}
