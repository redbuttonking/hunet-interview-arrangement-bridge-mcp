// 로컬 운영 대시보드에 필요한 최소 정보를 조합한다.
import { BridgeDatabase, type InterviewSkillDecisionRow, type ReviewRow } from "../db/database.js";

type DashboardEvaluationSummary = {
  scoreSheets: Array<{
    title: string;
    evaluationMethod?: string;
    completedAt?: string;
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

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const itemRecord = record(item);
        return itemRecord ? [itemRecord] : [];
      })
    : [];
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function evaluationSummary(value: unknown): DashboardEvaluationSummary | null {
  const evaluation = record(value);
  const applicantProgressId = text(evaluation?.applicantProgressId);
  const recruitmentId = text(evaluation?.recruitmentId);
  if (!applicantProgressId || !recruitmentId) return null;
  const scoreSheets = records(evaluation?.scoreSheets).flatMap((scoreSheet) => {
    const scoreSheetId = text(scoreSheet.scoreSheetId);
    const title = text(scoreSheet.title);
    if (!scoreSheetId || !title) return [];
    return [{
      title,
      ...(text(scoreSheet.evaluationMethod) ? { evaluationMethod: text(scoreSheet.evaluationMethod)! } : {}),
      ...(text(scoreSheet.completedAt) ? { completedAt: text(scoreSheet.completedAt)! } : {}),
      evaluators: records(scoreSheet.evaluators).map((evaluator) => ({
        name: text(evaluator.name) ?? "이름 미확인 평가자",
        ...(text(evaluator.submittedAt) ? { submittedAt: text(evaluator.submittedAt)! } : {}),
        ...(text(evaluator.comment) ? { comment: text(evaluator.comment)! } : {}),
        items: records(evaluator.items).map((item) => ({
          title: text(item.title) ?? "제목 없는 평가 항목",
          finalEvaluation: item.finalEvaluation === true,
          selectedOptions: records(item.selectedOptions).map((option) => ({
            title: text(option.title) ?? "선택값 미확인",
            ...(number(option.score) !== undefined ? { score: number(option.score)! } : {}),
          })),
          ...(text(item.comment) ? { comment: text(item.comment)! } : {}),
        })),
      })),
    }];
  });
  if (scoreSheets.length === 0) return null;
  const currentStep = record(evaluation?.currentStep);
  return {
    scoreSheets,
    ...(text(currentStep?.stepId) && text(currentStep?.name)
      ? {
          currentStep: {
            name: text(currentStep?.name)!,
            ...(number(currentStep?.order) !== undefined ? { order: number(currentStep?.order) } : {}),
          },
        }
      : {}),
  };
}

function reviewContext(review: ReviewRow) {
  const context = review.summary?.context;
  const summaryContext = context && typeof context === "object" && !Array.isArray(context)
    ? context as Record<string, unknown>
    : undefined;
  const evaluation = evaluationSummary(review.summary?.evaluation);
  return {
    candidateName: text(summaryContext?.candidateName),
    recruitmentName: text(summaryContext?.recruitmentName),
    currentStepName: evaluation?.currentStep?.name ?? null,
    evaluationSummary: evaluation,
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
