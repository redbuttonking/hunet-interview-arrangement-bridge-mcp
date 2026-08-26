// 후보자의 채용 여정과 현재 인터뷰 조율 상태를 분리해 표현한다.
import type {
  InterviewCaseRow,
  RecruitmentInterviewRoute,
  RecruitmentInterviewTemplateRow,
} from "../db/database.js";
import type { InterviewCaseStatus } from "../domain/types.js";

export type CandidateJourneyStageState = "COMPLETED" | "SCHEDULED" | "CURRENT" | "UPCOMING" | "STOPPED";

export interface CandidateJourneyStage {
  id: string;
  label: string;
  state: CandidateJourneyStageState;
  detail: string;
}

export interface CandidateJourney {
  stages: CandidateJourneyStage[];
  currentStageLabel: string;
  currentStageDetail: string;
}

export type CandidateJourneyEvaluationStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED";

export interface CandidateJourneyInput {
  template?: RecruitmentInterviewTemplateRow;
  currentStepId?: string | null;
  interviewCase?: InterviewCaseRow;
  plannedStepIds?: string[];
  evaluationStatus?: CandidateJourneyEvaluationStatus;
  candidateScheduleProposalSent?: boolean;
}

type JourneyRoute = RecruitmentInterviewRoute & {
  label: string;
  order: number;
};

function routeLabel(route: RecruitmentInterviewRoute, template: RecruitmentInterviewTemplateRow): string {
  const step = template.steps.find((item) => item.stepId === route.triggerStepId);
  const name = (step?.name ?? step?.title ?? "인터뷰").replace(/\s*,\s*/gu, "·").replace(/\s+/gu, " ").trim();
  if (route.mode === "COMBINED") {
    if (name.includes("1day")) return name;
    if (name.includes("실무자") && name.includes("임원")) return "실무자·임원 1day 인터뷰";
    return `${name.replace(/\s*(인터뷰|면접)$/u, "")} 통합 인터뷰`;
  }
  if (route.mode === "SEQUENTIAL") return `${name.replace(/\s*(인터뷰|면접)$/u, "")} 연속 인터뷰`;
  return name.includes("인터뷰") ? name : `${name} 인터뷰`;
}

function journeyRoutes(template?: RecruitmentInterviewTemplateRow): JourneyRoute[] {
  if (!template) return [];
  const routes = template.routes.length > 0
    ? template.routes
    : template.steps.map((step) => ({
      triggerStepId: step.stepId,
      mode: step.mode,
      stepIds: [step.stepId],
    }));
  return routes
    .map((route) => {
      const step = template.steps.find((item) => item.stepId === route.triggerStepId);
      return {
        ...route,
        label: routeLabel(route, template),
        order: step?.order ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .sort((left, right) => left.order - right.order);
}

function nowInKorea(): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}

function scheduledDetail(
  interviewCase: InterviewCaseRow,
  evaluationStatus?: CandidateJourneyEvaluationStatus,
): string {
  if (!interviewCase.scheduledDate || !interviewCase.scheduledStartTime) return "일정 조율 중";
  const now = nowInKorea();
  const scheduleStart = `${interviewCase.scheduledDate}T${interviewCase.scheduledStartTime}`;
  const scheduleEnd = `${interviewCase.scheduledDate}T${interviewCase.scheduledEndTime ?? interviewCase.scheduledStartTime}`;
  const current = `${now.date}T${now.time}`;
  if (current < scheduleStart) {
    return `${interviewCase.scheduledDate} ${interviewCase.scheduledStartTime} 인터뷰 예정`;
  }
  if (current < scheduleEnd) return "인터뷰 진행 중";
  if (evaluationStatus === "COMPLETED") return "평가 완료";
  if (evaluationStatus === "IN_PROGRESS") return "평가 진행 중";
  return "평가 대기";
}

function currentStageDetail(
  interviewCase?: InterviewCaseRow,
  evaluationStatus?: CandidateJourneyEvaluationStatus,
  candidateScheduleProposalSent = false,
): string {
  if (!interviewCase) return "일정 조율 시작 대기";
  const labels: Partial<Record<InterviewCaseStatus, string>> = {
    READY_FOR_DRAFT: "일정 조율 중",
    DRAFT_CREATED: "면접관 일정 요청 초안 확인",
    REQUEST_SENT: "면접관 일정 응답 대기",
    COLLECTING_AVAILABILITY: "면접관 일정 응답 대기",
    READY_TO_SCHEDULE: "시간·회의실 선택 대기",
    AWAITING_CANDIDATE_CONFIRMATION: candidateScheduleProposalSent ? "후보자 응답 대기" : "일정 제안 보내기 전",
    CONFIRMED: scheduledDetail(interviewCase, evaluationStatus),
    REVIEW_REQUIRED: "예외 상황 확인 필요",
    ON_HOLD: "조율 보류",
    CANCELLED: "인터뷰 취소",
    CLOSED: "인터뷰 종료",
  };
  return labels[interviewCase.status] ?? "상태 확인 필요";
}

function stageStateForCase(
  interviewCase?: InterviewCaseRow,
): CandidateJourneyStageState | undefined {
  if (!interviewCase) return undefined;
  if (["CANCELLED", "CLOSED"].includes(interviewCase.status)) return "STOPPED";
  if (interviewCase.status === "CONFIRMED") {
    const now = nowInKorea();
    const scheduledEnd = interviewCase.scheduledDate && interviewCase.scheduledEndTime
      ? `${interviewCase.scheduledDate}T${interviewCase.scheduledEndTime}`
      : undefined;
    if (!scheduledEnd || `${now.date}T${now.time}` < scheduledEnd) return "SCHEDULED";
  }
  return "CURRENT";
}

export function buildCandidateJourney(input: CandidateJourneyInput): CandidateJourney | null {
  const routes = journeyRoutes(input.template);
  if (routes.length === 0) return null;

  const plannedStepIds = new Set(input.plannedStepIds ?? []);
  const observedRouteIndex = input.currentStepId
    ? routes.findIndex((route) => route.triggerStepId === input.currentStepId)
    : -1;
  const plannedRouteIndex = routes.findIndex((route) =>
    route.stepIds.some((stepId) => plannedStepIds.has(stepId)),
  );
  const currentRouteIndex = observedRouteIndex >= 0 ? observedRouteIndex : plannedRouteIndex;
  if (currentRouteIndex < 0) return null;

  const currentRoute = routes[currentRouteIndex]!;
  const caseMatchesCurrentRoute = !input.interviewCase
    ? false
    : plannedStepIds.size === 0
      || currentRoute.stepIds.some((stepId) => plannedStepIds.has(stepId));
  const currentInterviewCase = caseMatchesCurrentRoute ? input.interviewCase : undefined;
  const interviewCaseState = stageStateForCase(currentInterviewCase);
  const currentDetail = currentStageDetail(
    currentInterviewCase,
    input.evaluationStatus,
    input.candidateScheduleProposalSent,
  );
  const stages: CandidateJourneyStage[] = [
    {
      id: "document-screening",
      label: "서류 평가",
      state: "COMPLETED",
      detail: "완료",
    },
    ...routes.map((route, index): CandidateJourneyStage => {
      if (index < currentRouteIndex) {
        return { id: route.triggerStepId, label: route.label, state: "COMPLETED", detail: "완료" };
      }
      if (index === currentRouteIndex) {
        return {
          id: route.triggerStepId,
          label: route.label,
          state: interviewCaseState ?? "CURRENT",
          detail: currentDetail,
        };
      }
      return { id: route.triggerStepId, label: route.label, state: "UPCOMING", detail: "예정" };
    }),
    {
      id: "final-result",
      label: "최종 결과",
      state: "UPCOMING",
      detail: "결과 대기",
    },
  ];

  return {
    stages,
    currentStageLabel: currentRoute.label,
    currentStageDetail: currentDetail,
  };
}
