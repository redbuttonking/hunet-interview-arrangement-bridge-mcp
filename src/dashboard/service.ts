// 로컬 운영 대시보드에 필요한 최소 정보를 조합한다.
import {
  BridgeDatabase,
  type InterviewCaseRow,
  type InterviewSkillDecisionRow,
  type ReviewRow,
} from "../db/database.js";
import {
  buildCandidateJourney,
  type CandidateJourneyEvaluationStatus,
} from "./candidate-journey.js";

const FRESHNESS_THRESHOLD_MS = 10 * 60 * 1000;

function todayInKorea(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

type DashboardEvaluationSummary = {
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

function plainText(value: unknown): string | null {
  const source = text(value);
  if (!source) return null;
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "")
    .replace(/<\s*br\s*\/?\s*>/giu, "\n")
    .replace(/<\s*li\b[^>]*>/giu, "• ")
    .replace(/<\/\s*(?:li|p|div|ul|ol|h[1-6])\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim() || null;
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
      participantCount: records(scoreSheet.participants).length,
      evaluators: records(scoreSheet.evaluators).map((evaluator) => ({
        name: text(evaluator.name) ?? "이름 미확인 평가자",
        ...(text(evaluator.submittedAt) ? { submittedAt: text(evaluator.submittedAt)! } : {}),
        ...(plainText(evaluator.comment) ? { comment: plainText(evaluator.comment)! } : {}),
        items: records(evaluator.items).map((item) => ({
          title: text(item.title) ?? "제목 없는 평가 항목",
          finalEvaluation: item.finalEvaluation === true,
          selectedOptions: records(item.selectedOptions).map((option) => ({
            title: text(option.title) ?? "선택값 미확인",
            ...(number(option.score) !== undefined ? { score: number(option.score)! } : {}),
          })),
          ...(plainText(item.comment) ? { comment: plainText(item.comment)! } : {}),
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

function reviewContext(db: BridgeDatabase, review: ReviewRow) {
  const summary = record(review.summary);
  const context = summary?.context;
  const summaryContext = context && typeof context === "object" && !Array.isArray(context)
    ? context as Record<string, unknown>
    : undefined;
  const evaluation = evaluationSummary(review.summary?.evaluation);
  const rawEvaluation = record(review.summary?.evaluation);
  const currentStep = record(rawEvaluation?.currentStep);
  const interviewCase = review.caseId ? db.getCase(review.caseId) : undefined;
  const plan = review.caseId ? db.getCaseInterviewPlan(review.caseId) : undefined;
  return {
    candidateRef: text(summaryContext?.candidateRef),
    recruitmentRef: text(summaryContext?.recruitmentRef),
    currentStepId: text(currentStep?.stepId),
    candidateName: text(summaryContext?.candidateName)
      ?? text(summary?.candidateName)
      ?? interviewCase?.candidateName
      ?? null,
    recruitmentName: text(summaryContext?.recruitmentName)
      ?? text(summary?.recruitmentName)
      ?? interviewCase?.recruitmentName
      ?? null,
    currentStepName: evaluation?.currentStep?.name ?? plan?.stepNames.join(
      plan.mode === "SEQUENTIAL" ? " → " : " + ",
    ) ?? null,
    evaluationSummary: evaluation,
  };
}

function currentCaseForJourney(
  db: BridgeDatabase,
  input: { candidateRef: string | null; recruitmentRef: string | null; currentStepId: string | undefined },
) {
  if (!input.currentStepId) return undefined;
  return db.listCases(undefined, 1_000)
    .filter((interviewCase) =>
      interviewCase.candidateRef === input.candidateRef
      && interviewCase.recruitmentRef === input.recruitmentRef
      && !["CANCELLED", "CLOSED"].includes(interviewCase.status),
    )
    .map((interviewCase) => ({ interviewCase, plan: db.getCaseInterviewPlan(interviewCase.id) }))
    .find(({ plan }) => plan?.stepIds.includes(input.currentStepId!));
}

function sameCandidateContext(
  context: ReturnType<typeof reviewContext>,
  interviewCase: InterviewCaseRow,
): boolean {
  if (context.candidateRef && interviewCase.candidateRef) {
    return context.candidateRef === interviewCase.candidateRef
      && context.recruitmentRef === interviewCase.recruitmentRef;
  }
  return context.candidateName === interviewCase.candidateName
    && context.recruitmentName === interviewCase.recruitmentName;
}

function hasScheduledInterviewEnded(interviewCase: InterviewCaseRow): boolean {
  if (!interviewCase.scheduledDate || !interviewCase.scheduledEndTime) return false;
  const endAt = Date.parse(`${interviewCase.scheduledDate}T${interviewCase.scheduledEndTime}:00+09:00`);
  return !Number.isNaN(endAt) && endAt <= Date.now();
}

function evaluationStatus(summary: DashboardEvaluationSummary | null): CandidateJourneyEvaluationStatus {
  if (!summary || summary.scoreSheets.length === 0) return "PENDING";
  const allCompleted = summary.scoreSheets.every((scoreSheet) =>
    Boolean(scoreSheet.completedAt)
    || (scoreSheet.participantCount > 0 && scoreSheet.evaluators.length >= scoreSheet.participantCount),
  );
  if (allCompleted) return "COMPLETED";
  return summary.scoreSheets.some((scoreSheet) => scoreSheet.evaluators.length > 0)
    ? "IN_PROGRESS"
    : "PENDING";
}

function evaluationStatusForCase(
  db: BridgeDatabase,
  interviewCase: InterviewCaseRow,
  plan: { stepIds: string[] } | undefined,
): CandidateJourneyEvaluationStatus | undefined {
  if (interviewCase.status !== "CONFIRMED" || !plan || !hasScheduledInterviewEnded(interviewCase)) {
    return undefined;
  }
  const scheduledEndAt = Date.parse(
    `${interviewCase.scheduledDate}T${interviewCase.scheduledEndTime}:00+09:00`,
  );
  const latestReview = db.listOpenReviews(1_000)
    .map((review) => ({ review, context: reviewContext(db, review) }))
    .filter(({ review, context }) =>
      sameCandidateContext(context, interviewCase)
      && Boolean(context.currentStepId && plan.stepIds.includes(context.currentStepId))
      && Date.parse(review.createdAt) >= scheduledEndAt,
    )
    .sort((left, right) => right.review.createdAt.localeCompare(left.review.createdAt))
    .at(0);
  return evaluationStatus(latestReview?.context.evaluationSummary ?? null);
}

export function getCandidateJourneyForCase(
  db: BridgeDatabase,
  interviewCase: InterviewCaseRow,
  plan = db.getCaseInterviewPlan(interviewCase.id),
) {
  const template = interviewCase.recruitmentRef
    ? db.getRecruitmentInterviewTemplate(interviewCase.recruitmentRef)
    : undefined;
  return buildCandidateJourney({
    template,
    interviewCase,
    plannedStepIds: plan?.stepIds,
    evaluationStatus: evaluationStatusForCase(db, interviewCase, plan),
  });
}

function decisionSummary(db: BridgeDatabase, decision: InterviewSkillDecisionRow) {
  const interviewCase = decision.caseId ? db.getCase(decision.caseId) : undefined;
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
    candidateName: text(decision.context.candidateName) ?? interviewCase?.candidateName ?? null,
    recruitmentName: text(decision.context.recruitmentName) ?? interviewCase?.recruitmentName ?? null,
    createdAt: decision.createdAt,
  };
}

function freshness(lastSuccessfulAt: string | null | undefined) {
  if (!lastSuccessfulAt) {
    return { lastSuccessfulAt: null, state: "UNKNOWN" as const };
  }
  const timestamp = Date.parse(lastSuccessfulAt);
  if (Number.isNaN(timestamp)) {
    return { lastSuccessfulAt: null, state: "UNKNOWN" as const };
  }
  return {
    lastSuccessfulAt,
    state: Date.now() - timestamp <= FRESHNESS_THRESHOLD_MS ? "FRESH" as const : "STALE" as const,
  };
}

export function withDashboardFreshness(
  db: BridgeDatabase,
  dashboard: Record<string, unknown>,
) {
  const dashboardData = dashboard as {
    cases: unknown[];
    summary: Record<string, unknown>;
    [key: string]: unknown;
  };
  const dashboardSummary = dashboardData.summary && typeof dashboardData.summary === "object"
    ? dashboardData.summary
    : {};
  const worker = dashboardSummary.worker && typeof dashboardSummary.worker === "object"
    ? dashboardSummary.worker as Record<string, unknown>
    : {};
  const roomSyncAt = db.getLatestMeetingRoomSyncAt() ?? null;
  const dashboardWithFreshness = {
    ...dashboardData,
    summary: {
      ...dashboardSummary,
      freshness: {
        slack: freshness(db.getCursorInfo("sync:slack:last_success")?.updatedAt),
        ninehire: freshness(db.getCursorInfo("sync:ninehire:last_success")?.updatedAt),
        daouOffice: freshness(roomSyncAt),
        daouOfficeCalendar: freshness(db.getCursorInfo("sync:daou_calendar:last_success")?.updatedAt),
        worker: freshness(typeof worker.lastSuccessfulCycleAt === "string" ? worker.lastSuccessfulCycleAt : null),
      },
    },
  };
  return dashboardWithFreshness;
}

export function getDashboardSnapshot(db: BridgeDatabase, limit = 100) {
  const dashboardWithFreshness = withDashboardFreshness(
    db,
    db.getOperationsDashboard(limit),
  );
  const dashboardCases = (dashboardWithFreshness.cases as Array<Record<string, unknown>>).map((caseSummary) => {
    const caseId = text(caseSummary.id);
    const interviewCase = caseId ? db.getCase(caseId) : undefined;
    const plan = interviewCase ? db.getCaseInterviewPlan(interviewCase.id) : undefined;
    return {
      ...caseSummary,
      ...(interviewCase
        ? {
            candidateRef: interviewCase.candidateRef,
            recruitmentRef: interviewCase.recruitmentRef,
            candidateJourney: getCandidateJourneyForCase(db, interviewCase, plan),
          }
        : {}),
    };
  });
  const reviews = db.listOpenReviews(limit).map((review) => {
    const context = reviewContext(db, review);
    const template = context.recruitmentRef
      ? db.getRecruitmentInterviewTemplate(context.recruitmentRef)
      : undefined;
    const matchedCase = currentCaseForJourney(db, {
      candidateRef: context.candidateRef,
      recruitmentRef: context.recruitmentRef,
      currentStepId: context.currentStepId ?? undefined,
    });
    return {
      id: review.id,
      caseId: review.caseId,
      reviewType: review.reviewType,
      reason: review.reason,
      createdAt: review.createdAt,
      ...context,
      candidateJourney: buildCandidateJourney({
        template,
        currentStepId: context.currentStepId ?? undefined,
        interviewCase: matchedCase?.interviewCase,
        plannedStepIds: matchedCase?.plan?.stepIds,
        evaluationStatus: matchedCase
          ? evaluationStatusForCase(db, matchedCase.interviewCase, matchedCase.plan)
          : undefined,
      }),
    };
  });
  const decisions = db
    .listInterviewSkillDecisions({ status: "PENDING", limit })
    .map((decision) => decisionSummary(db, decision));
  const heldReviewWork = db
    .listHeldReviews(limit)
    .filter((review) => !review.caseId)
    .map((review) => {
      const context = reviewContext(db, review);
      return {
        id: review.id,
        kind: "REVIEW" as const,
        candidateName: context.candidateName,
        recruitmentName: context.recruitmentName,
        detail: context.currentStepName
          ? `${context.currentStepName} 단계의 조율 시작을 보류했습니다.`
          : "인터뷰 조율 시작을 보류했습니다.",
        heldAt: review.resolvedAt ?? review.createdAt,
      };
    });
  const heldCaseWork = db.listCases("ON_HOLD", limit).map((interviewCase) => {
    const plan = db.getCaseInterviewPlan(interviewCase.id);
    return {
      id: interviewCase.id,
      kind: "CASE" as const,
      candidateName: interviewCase.candidateName,
      recruitmentName: interviewCase.recruitmentName,
      detail: plan
        ? `${plan.stepNames.join(plan.mode === "SEQUENTIAL" ? " → " : " + ")} 조율을 보류했습니다.`
        : "인터뷰 조율을 보류했습니다.",
      heldAt: interviewCase.updatedAt,
    };
  });

  return {
    dashboard: {
      ...dashboardWithFreshness,
      cases: dashboardCases,
    },
    reviews,
    decisions,
    heldWork: [...heldReviewWork, ...heldCaseWork]
      .sort((left, right) => right.heldAt.localeCompare(left.heldAt)),
    meetingRoomBlocks: db.listMeetingRoomBlocks().map((block) => ({
      id: block.id,
      roomName: block.roomName,
      date: block.date,
      startTime: block.startTime,
      endTime: block.endTime,
    })),
    externalConfirmedInterviews: db.listExternalConfirmedInterviews()
      .filter((interview) => interview.date >= todayInKorea())
      .map((interview) => ({
      id: interview.id,
      candidateName: interview.candidateName,
      recruitmentName: interview.recruitmentName,
      date: interview.date,
      startTime: interview.startTime,
      endTime: interview.endTime,
      roomName: interview.roomName,
      linkedCaseId: interview.linkedCaseId,
      lastSeenAt: interview.lastSeenAt,
      })),
  };
}
