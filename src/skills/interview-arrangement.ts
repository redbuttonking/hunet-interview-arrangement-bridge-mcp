// 인터뷰 조율 반복 업무를 MCP와 대시보드가 함께 호출할 수 있는 스킬로 묶는다.
import type {
  BridgeDatabase,
  InterviewSkillDecisionRow,
  ReviewRow,
} from "../db/database.js";
import type { InterviewSkillDecisionOption } from "../domain/skills.js";
import { suggestInterviewSlotsWithRooms } from "../services/room-scheduling.js";
import { suggestSequentialInterviewSlotsWithRooms } from "../services/sequential-scheduling.js";
import type { OperationalReadinessService } from "../services/operational-readiness.js";
import type { WorkflowService } from "../services/workflow.js";

type WorkflowActions = Pick<
  WorkflowService,
  | "approveInterviewArrangement"
  | "createRequestDraft"
  | "recordManualConfirmedInterview"
  | "resolveCandidateInterviewAbsenceReview"
  | "syncCaseInterviewers"
  | "createAvailabilityRecoveryDraft"
>;

type ReadinessActions = Pick<OperationalReadinessService, "inspect">;

interface StandardScheduleChoice {
  optionId: string;
  date: string;
  startTime: string;
  endTime: string;
  roomBlockId: string;
  roomName: string;
}

interface SequentialScheduleChoice {
  optionId: string;
  order: "NORMAL" | "REVERSED";
  date: string;
  sessions: Array<{
    stepId: string;
    stepName: string;
    startTime: string;
    endTime: string;
    room: {
      roomBlockId: string;
      roomName: string;
      startTime: string;
      endTime: string;
    };
  }>;
}

interface ReconciledNinehireScheduleChoice {
  optionId: string;
  roomName: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
      })
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function caseContext(
  db: BridgeDatabase,
  caseId: string,
): Record<string, unknown> {
  const interviewCase = db.getCase(caseId);
  if (!interviewCase) throw new Error(`Case not found: ${caseId}`);
  return {
    caseId,
    candidateName: interviewCase.candidateName,
    recruitmentName: interviewCase.recruitmentName,
    caseStatus: interviewCase.status,
  };
}

function decisionOptions(
  options: Array<[string, string, string]>,
): InterviewSkillDecisionOption[] {
  return options.map(([id, label, description]) => ({ id, label, description }));
}

function requiredDecisionContext(
  decision: InterviewSkillDecisionRow,
): Record<string, unknown> {
  return decision.context;
}

function requiredCaseId(decision: InterviewSkillDecisionRow): string {
  if (!decision.caseId) {
    throw new Error(`Interview skill decision does not have a case: ${decision.id}`);
  }
  return decision.caseId;
}

function requiredReviewId(decision: InterviewSkillDecisionRow): string {
  if (!decision.reviewId) {
    throw new Error(`Interview skill decision does not have a review: ${decision.id}`);
  }
  return decision.reviewId;
}

function reviewContext(review: ReviewRow): Record<string, unknown> {
  const summary = review.summary ?? {};
  const sourceContext = asRecord(summary.context);
  return {
    reviewId: review.id,
    reviewType: review.reviewType,
    reason: review.reason,
    recruitmentRef: text(sourceContext?.recruitmentRef) ?? null,
    candidateName: text(sourceContext?.candidateName) ?? null,
    recruitmentName: text(sourceContext?.recruitmentName) ?? null,
  };
}

function interviewRouteChoices(
  db: BridgeDatabase,
  review: ReviewRow,
): Array<{
  optionId: string;
  routeTriggerStepId: string;
  label: string;
  description: string;
}> {
  const sourceContext = asRecord(review.summary?.context);
  const recruitmentRef = text(sourceContext?.recruitmentRef);
  if (!recruitmentRef) return [];
  const template = db.getRecruitmentInterviewTemplate(recruitmentRef);
  if (!template) return [];
  const evaluation = asRecord(review.summary?.evaluation);
  const currentStepId = text(asRecord(evaluation?.currentStep)?.stepId);
  const matchingRoutes = currentStepId
    ? template.routes.filter((route) => route.triggerStepId === currentStepId)
    : [];
  const routes = matchingRoutes.length > 0 ? matchingRoutes : template.routes;
  const stepsById = new Map(template.steps.map((step) => [step.stepId, step]));
  return routes.flatMap((route) => {
    const steps = route.stepIds.map((stepId) => stepsById.get(stepId));
    if (steps.some((step) => !step)) return [];
    const resolvedSteps = steps.filter((step): step is NonNullable<typeof step> => Boolean(step));
    const names = resolvedSteps.map((step) => step.name);
    const durationMinutes = route.mode === "SEQUENTIAL"
      ? resolvedSteps.reduce((total, step) => total + step.durationMinutes, 0)
      : resolvedSteps[0]!.durationMinutes;
    const label = route.mode === "COMBINED" && names.length > 1
      ? `${names.join(" + ")} 통합 인터뷰`
      : route.mode === "SEQUENTIAL"
        ? `${names.join(" → ")} 연속 인터뷰`
        : names.join(" + ");
    return [{
      optionId: `ROUTE:${route.triggerStepId}`,
      routeTriggerStepId: route.triggerStepId,
      label,
      description: `${durationMinutes}분 인터뷰 계획으로 조율 건을 만들고 면접관 확인 단계로 이동합니다.`,
    }];
  });
}

function pendingDecision(
  db: BridgeDatabase,
  input: Parameters<BridgeDatabase["createOrGetPendingInterviewSkillDecision"]>[0],
) {
  return db.createOrGetPendingInterviewSkillDecision(input);
}

export class InterviewArrangementSkills {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly workflow: WorkflowActions,
    private readonly readiness: ReadinessActions,
  ) {}

  async getOperationsControl(limit = 100) {
    return {
      skillKey: "OPERATIONS_CONTROL" as const,
      dashboard: this.db.getOperationsDashboard(limit),
      readiness: await this.readiness.inspect({ checkExternal: false }),
      pendingDecisions: this.db.listInterviewSkillDecisions({
        status: "PENDING",
        limit,
      }),
    };
  }

  createCandidateTriageDecision(reviewId: string): InterviewSkillDecisionRow {
    const review = this.db.getReview(reviewId);
    if (!review || review.status !== "OPEN") {
      throw new Error(`Open review not found: ${reviewId}`);
    }
    const context = reviewContext(review);
    if (review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED") {
      const routes = interviewRouteChoices(this.db, review);
      if (routes.length === 0) {
        return pendingDecision(this.db, {
          skillKey: "CANDIDATE_TRIAGE",
          decisionType: "REVIEW_RECRUITMENT_TEMPLATE",
          fingerprint: `review:${review.id}:missing-template`,
          reviewId: review.id,
          title: "인터뷰 계획 설정 필요",
          prompt: "인터뷰 조율을 시작하기 전에 이 채용의 인터뷰 유형과 소요시간 규칙을 승인하세요.",
          selectionMode: "SINGLE",
          options: decisionOptions([
            ["OPEN_TEMPLATE", "채용 인터뷰 규칙 확인", "채용별 인터뷰 유형과 시간을 확인·승인합니다."],
            ["HOLD", "보류", "조율을 시작하지 않고 현재 검토 건을 유지합니다."],
          ]),
          context,
        });
      }
      if (routes.length === 1) {
        const route = routes[0]!;
        return pendingDecision(this.db, {
          skillKey: "CANDIDATE_TRIAGE",
          decisionType: "START_INTERVIEW_ARRANGEMENT",
          fingerprint: `review:${review.id}:start:${route.routeTriggerStepId}`,
          reviewId: review.id,
          title: "인터뷰 조율 시작 여부",
          prompt: `승인된 ${route.label} 계획으로 인터뷰 조율을 시작할지 선택하세요.`,
          selectionMode: "SINGLE",
          options: decisionOptions([
            ["START", "인터뷰 조율 시작", route.description],
            ["HOLD", "보류", "원래 검토 건을 유지하고 조율을 시작하지 않습니다."],
          ]),
          context: { ...context, routeTriggerStepId: route.routeTriggerStepId },
        });
      }
      return pendingDecision(this.db, {
        skillKey: "CANDIDATE_TRIAGE",
        decisionType: "SELECT_INTERVIEW_ROUTE",
        fingerprint: `review:${review.id}:route`,
        reviewId: review.id,
        title: "인터뷰 유형 선택",
        prompt: "승인할 인터뷰 유형을 선택하세요. 선택한 유형으로만 인터뷰 조율을 시작합니다.",
        selectionMode: "SINGLE",
        options: decisionOptions([
          ...routes.map((route) => [route.optionId, route.label, route.description] as [string, string, string]),
          ["HOLD", "보류", "원래 검토 건을 유지하고 조율을 시작하지 않습니다."],
        ]),
        context,
      });
    }
    if (
      review.reviewType === "RECRUITMENT_TEMPLATE_UPDATE_REQUIRED" ||
      review.reviewType === "RECRUITMENT_TEMPLATE_CHECK_REQUIRED"
    ) {
      return pendingDecision(this.db, {
        skillKey: "CANDIDATE_TRIAGE",
        decisionType: "REVIEW_RECRUITMENT_TEMPLATE",
        fingerprint: `review:${review.id}:template`,
        reviewId: review.id,
        title: "채용 인터뷰 단계 규칙 검토",
        prompt: "나인하이어의 현재 칸반 단계와 저장된 인터뷰 규칙이 일치하지 않습니다.",
        selectionMode: "SINGLE",
        options: decisionOptions([
          ["OPEN_TEMPLATE", "채용 단계 규칙 확인", "채용 단계 미리 보기로 이동해 규칙을 검토합니다."],
          ["HOLD", "보류", "현재 규칙을 바꾸거나 조율을 시작하지 않습니다."],
        ]),
        context,
      });
    }
    throw new Error(
      `Candidate triage skill does not support review type: ${review.reviewType}`,
    );
  }

  createAvailabilityCollectionDecision(caseId: string): InterviewSkillDecisionRow {
    const context = caseContext(this.db, caseId);
    const interviewCase = this.db.getCase(caseId)!;
    const interviewers = this.db
      .listInterviewers(caseId)
      .filter((interviewer) => interviewer.active && interviewer.required);
    const missingSlackMappings = interviewers
      .filter((interviewer) => !interviewer.slackUserId)
      .map((interviewer) => interviewer.displayName);
    const pendingInterviewerNames = interviewers
      .filter((interviewer) => interviewer.status === "PENDING")
      .map((interviewer) => interviewer.displayName);
    const baseContext = {
      ...context,
      requiredInterviewerCount: interviewers.length,
      missingSlackMappings,
      pendingInterviewerNames,
    };
    if (interviewers.length === 0) {
      return pendingDecision(this.db, {
        skillKey: "AVAILABILITY_COLLECTION",
        decisionType: "SYNC_INTERVIEWERS",
        fingerprint: `case:${caseId}:sync-interviewers:${interviewCase.updatedAt}`,
        caseId,
        title: "면접관 조회 필요",
        prompt: "나인하이어에서 이 인터뷰의 최신 면접관을 다시 조회하세요.",
        selectionMode: "SINGLE",
        options: decisionOptions([
          ["SYNC_INTERVIEWERS", "면접관 다시 조회", "나인하이어 면접관 정보를 로컬 상태에 반영합니다."],
          ["HOLD", "보류", "면접관 조회를 나중에 진행합니다."],
        ]),
        context: baseContext,
      });
    }
    if (missingSlackMappings.length > 0) {
      return pendingDecision(this.db, {
        skillKey: "AVAILABILITY_COLLECTION",
        decisionType: "MAP_INTERVIEWERS",
        fingerprint: `case:${caseId}:map-interviewers:${missingSlackMappings.join("|")}`,
        caseId,
        title: "면접관 Slack 연결 필요",
        prompt: "일정 요청을 보내기 전에 아래 면접관의 Slack 사용자를 연결하세요.",
        selectionMode: "SINGLE",
        options: decisionOptions([
          ["OPEN_MAPPING", "Slack 사용자 연결", "면접관별 Slack 사용자 연결 화면 또는 도구로 이동합니다."],
          ["HOLD", "보류", "연결을 나중에 진행합니다."],
        ]),
        context: baseContext,
      });
    }
    if (interviewCase.status === "READY_FOR_DRAFT") {
      return pendingDecision(this.db, {
        skillKey: "AVAILABILITY_COLLECTION",
        decisionType: "CREATE_AVAILABILITY_REQUEST_DRAFT",
        fingerprint: `case:${caseId}:availability-request:${interviewCase.scheduleRound}`,
        caseId,
        title: "면접관 가능 일정 요청",
        prompt: "면접관에게 보낼 가능 일정 요청 초안을 만드세요. 초안은 별도 승인 전까지 발송되지 않습니다.",
        selectionMode: "SINGLE",
        options: decisionOptions([
          ["CREATE_DRAFT", "일정 요청 초안 만들기", "Slack 발송 전 검토할 메시지 초안을 만듭니다."],
          ["HOLD", "보류", "초안을 만들지 않고 현재 상태를 유지합니다."],
        ]),
        context: baseContext,
      });
    }
    if (interviewCase.status === "DRAFT_CREATED") {
      return pendingDecision(this.db, {
        skillKey: "AVAILABILITY_COLLECTION",
        decisionType: "REVIEW_AVAILABILITY_REQUEST_DRAFT",
        fingerprint: `case:${caseId}:availability-draft`,
        caseId,
        title: "면접관 일정 요청 초안 검토",
        prompt: "초안 내용을 확인한 뒤 기존 발송 승인 도구로 발송 여부를 결정하세요.",
        selectionMode: "SINGLE",
        options: decisionOptions([
          ["VIEW_DRAFT", "초안 보기", "발송하지 않고 현재 초안을 확인합니다."],
          ["HOLD", "보류", "초안을 그대로 두고 나중에 검토합니다."],
        ]),
        context: baseContext,
      });
    }
    if (["REQUEST_SENT", "COLLECTING_AVAILABILITY"].includes(interviewCase.status)) {
      return pendingDecision(this.db, {
        skillKey: "AVAILABILITY_COLLECTION",
        decisionType: "WAIT_FOR_AVAILABILITY",
        fingerprint: `case:${caseId}:waiting-availability:${pendingInterviewerNames.join("|")}`,
        caseId,
        title: "면접관 일정 제출 대기",
        prompt: "아직 가능한 일정을 제출하지 않은 면접관이 있습니다.",
        selectionMode: "SINGLE",
        options: decisionOptions([
          ["WAIT", "제출 대기", "리마인드 정책에 따라 제출을 기다립니다."],
          ["OPEN_RECOVERY", "재요청 검토", "일정 재제출 요청을 위한 기존 검토 도구로 이동합니다."],
        ]),
        context: baseContext,
      });
    }
    return pendingDecision(this.db, {
      skillKey: "AVAILABILITY_COLLECTION",
      decisionType: "OPEN_SCHEDULING",
      fingerprint: `case:${caseId}:open-scheduling:${interviewCase.status}`,
      caseId,
      title: "일정·회의실 조율 진행",
      prompt: "면접관 일정 수집이 완료되었습니다. 시간과 회의실을 추천하세요.",
      selectionMode: "SINGLE",
      options: decisionOptions([
        ["OPEN_SCHEDULING", "일정 추천 보기", "시간과 회의실 추천 스킬로 이동합니다."],
        ["HOLD", "보류", "일정 추천을 나중에 진행합니다."],
      ]),
      context: baseContext,
    });
  }

  createInterviewSchedulingDecision(caseId: string): InterviewSkillDecisionRow {
    const context = caseContext(this.db, caseId);
    const plan = this.db.getCaseInterviewPlan(caseId);
    if (plan?.mode === "SEQUENTIAL") {
      return this.createSequentialSchedulingDecision(caseId, context);
    }
    const result = suggestInterviewSlotsWithRooms(this.db, caseId);
    if (!result.ready) {
      return pendingDecision(this.db, {
        skillKey: "INTERVIEW_SCHEDULING",
        decisionType: "COLLECT_AVAILABILITY_BEFORE_SCHEDULING",
        fingerprint: `case:${caseId}:missing-availability:${result.missingRequiredResponses.join("|")}`,
        caseId,
        title: "면접관 가능 일정 필요",
        prompt: "필수 면접관의 가능 일정이 모두 제출된 뒤 시간과 회의실을 추천할 수 있습니다.",
        selectionMode: "SINGLE",
        options: decisionOptions([
          ["OPEN_AVAILABILITY", "일정 수집으로 이동", "면접관 가능 일정 수집 상태를 확인합니다."],
          ["HOLD", "보류", "현재 조율을 보류합니다."],
        ]),
        context: { ...context, missingRequiredResponses: result.missingRequiredResponses },
      });
    }
    if (result.meetingRoomCheck === "NOT_SYNCED") {
      return pendingDecision(this.db, {
        skillKey: "INTERVIEW_SCHEDULING",
        decisionType: "SYNC_MEETING_ROOMS",
        fingerprint: `case:${caseId}:sync-rooms`,
        caseId,
        title: "회의실 정보 동기화 필요",
        prompt: "다우오피스에서 인터뷰 회의실 블록을 읽어온 뒤 추천할 수 있습니다.",
        selectionMode: "SINGLE",
        options: decisionOptions([
          ["OPEN_ROOM_SYNC", "회의실 동기화", "다우오피스 회의실 동기화 도구로 이동합니다."],
          ["HOLD", "보류", "회의실 동기화를 나중에 진행합니다."],
        ]),
        context,
      });
    }
    const choices: StandardScheduleChoice[] = result.suggestions
      .slice(0, 10)
      .flatMap((suggestion, suggestionIndex) =>
        suggestion.rooms.slice(0, 3).map((room, roomIndex) => ({
          optionId: `STANDARD_${suggestionIndex}_${roomIndex}`,
          date: suggestion.date,
          startTime: suggestion.start,
          endTime: suggestion.end,
          roomBlockId: room.roomBlockId,
          roomName: room.roomName,
        })),
      );
    if (choices.length === 0) {
      return pendingDecision(this.db, {
        skillKey: "INTERVIEW_SCHEDULING",
        decisionType: "NO_SCHEDULING_SLOT",
        fingerprint: `case:${caseId}:no-slot:${result.meetingRoomCheck}`,
        caseId,
        title: "추천 가능한 인터뷰 시간이 없음",
        prompt: "면접관 공통 시간 또는 확보된 회의실이 부족합니다.",
        selectionMode: "SINGLE",
        options: decisionOptions([
          ["OPEN_AVAILABILITY", "면접관 일정 재수집", "면접관 가능 시간을 다시 수집합니다."],
          ["HOLD", "보류", "현재 조율을 보류합니다."],
        ]),
        context: { ...context, meetingRoomCheck: result.meetingRoomCheck },
      });
    }
    return pendingDecision(this.db, {
      skillKey: "INTERVIEW_SCHEDULING",
      decisionType: "CONFIRM_STANDARD_SCHEDULE",
      fingerprint: `case:${caseId}:standard:${choices.map((choice) => [
        choice.optionId,
        choice.date,
        choice.startTime,
        choice.endTime,
        choice.roomBlockId,
      ].join(":")).join("|")}`,
      caseId,
      title: "인터뷰 시간과 회의실 선택",
      prompt: "추천 시간과 회의실 중 하나를 내부 확정하세요. 이 단계에서는 Slack 메시지를 발송하지 않습니다.",
      selectionMode: "SINGLE",
      options: choices.map((choice) => ({
        id: choice.optionId,
        label: `${choice.date} ${choice.startTime}~${choice.endTime} · ${choice.roomName}`,
        description: "회의실 블록 안에 로컬 인터뷰 일정을 배정하고 내부 확정으로 기록합니다.",
      })),
      context: { ...context, scheduleKind: "STANDARD", choices },
    });
  }

  createCandidateScheduleProposalDecision(caseId: string): InterviewSkillDecisionRow {
    const interviewCase = this.db.getCase(caseId);
    if (!interviewCase || interviewCase.status !== "AWAITING_CANDIDATE_CONFIRMATION") {
      throw new Error("An internally confirmed interview is required before recording a candidate proposal.");
    }
    if (this.db.hasCandidateScheduleProposalSent(caseId)) {
      throw new Error("The candidate schedule proposal is already recorded as sent.");
    }
    return pendingDecision(this.db, {
      skillKey: "CANDIDATE_SCHEDULE_PROPOSAL",
      decisionType: "CANDIDATE_SCHEDULE_PROPOSAL_SENT",
      fingerprint: `case:${caseId}:candidate-schedule-proposal`,
      caseId,
      title: "나인하이어 일정 제안 발송 확인",
      prompt:
        "나인하이어에서 후보자에게 일정 제안을 발송한 뒤에만 완료로 처리하세요. 현재 나인하이어 MCP는 이 발송 이력을 직접 조회할 수 없습니다.",
      selectionMode: "SINGLE",
      options: decisionOptions([
        ["MARK_PROPOSAL_SENT", "일정 제안 발송 완료", "후보자에게 보낼 나인하이어 일정 제안이 발송되었음을 로컬 운영 이력에 기록합니다."],
      ]),
      context: {
        ...caseContext(this.db, caseId),
        scheduledDate: interviewCase.scheduledDate,
        scheduledStartTime: interviewCase.scheduledStartTime,
        scheduledEndTime: interviewCase.scheduledEndTime,
        scheduledRoomName: interviewCase.scheduledRoomName,
      },
    });
  }

  createAvailabilityRecoveryDecision(reviewId: string): InterviewSkillDecisionRow {
    const review = this.db.getReview(reviewId);
    if (
      !review ||
      review.status !== "OPEN" ||
      !review.caseId ||
      review.reviewType !== "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED"
    ) {
      throw new Error(`Open availability recovery review not found: ${reviewId}`);
    }
    return pendingDecision(this.db, {
      skillKey: "OPERATIONS_RECOVERY",
      decisionType: "CREATE_AVAILABILITY_RECOVERY_DRAFT",
      fingerprint: `review:${review.id}:availability-recovery`,
      reviewId: review.id,
      caseId: review.caseId,
      title: "면접관 일정 재제출 요청 확인",
      prompt:
        "워커 중단 중 제출된 일정이 누락됐을 수 있습니다. 초안을 만든 뒤 내용을 검토하고 Slack 발송을 승인하세요.",
      selectionMode: "SINGLE",
      options: decisionOptions([
        ["CREATE_RECOVERY_DRAFT", "재제출 요청 초안 만들기", "미제출 필수 면접관에게 보낼 Slack 재제출 요청 초안을 만듭니다. 아직 발송하지 않습니다."],
        ["CONFIRM_NO_RECOVERY_NEEDED", "현재 상태 확인, 경고 해제", "현재 미제출 상태가 맞음을 확인하고 외부 메시지 없이 안전 경고만 해제합니다."],
        ["HOLD", "보류", "현재 복구 요청을 보내지 않고 검토 건을 보류합니다."],
      ]),
      context: {
        ...caseContext(this.db, review.caseId),
        reviewId: review.id,
      },
    });
  }

  createCandidateScheduleResponseDecision(reviewId: string): InterviewSkillDecisionRow {
    const review = this.db.getReview(reviewId);
    if (
      !review ||
      review.status !== "OPEN" ||
      review.reviewType !== "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED" ||
      !review.caseId
    ) {
      throw new Error(`Open candidate-attendance review not found: ${reviewId}`);
    }
    return pendingDecision(this.db, {
      skillKey: "CANDIDATE_SCHEDULE_RESPONSE",
      decisionType: "CANDIDATE_INTERVIEW_ABSENCE",
      fingerprint: `review:${review.id}:candidate-response`,
      caseId: review.caseId,
      reviewId: review.id,
      title: "후보자 불참 또는 일정 변경 요청",
      prompt: "후보자의 의도를 자동으로 단정하지 않고 다음 조치를 선택하세요.",
      selectionMode: "SINGLE",
      options: decisionOptions([
        ["RESCHEDULE_REUSE", "기존 가능 시간으로 재조율", "기존 면접관 제출 일정을 재사용해 새 일정을 찾습니다."],
        ["RESCHEDULE_RECOLLECT", "가능 일정 다시 수집", "면접관에게 새 가능 일정을 받습니다."],
        ["CANCEL", "인터뷰 조율 취소", "로컬 일정과 미발송 초안을 정리하고 안내 초안을 만듭니다."],
        ["HOLD", "보류", "후보자 메시지와 기존 일정을 유지한 채 검토를 보류합니다."],
      ]),
      context: {
        ...caseContext(this.db, review.caseId),
        reviewId: review.id,
        reason: review.reason,
      },
    });
  }

  listPendingDecisions(limit = 100): InterviewSkillDecisionRow[] {
    return this.db.listInterviewSkillDecisions({ status: "PENDING", limit });
  }

  async resolveDecision(input: {
    decisionId: string;
    optionId: string;
    note?: string;
  }) {
    const decision = this.db.getInterviewSkillDecision(input.decisionId);
    if (!decision || decision.status !== "PENDING") {
      throw new Error(`Pending interview skill decision not found: ${input.decisionId}`);
    }
    if (!decision.options.some((option) => option.id === input.optionId)) {
      throw new Error(`Invalid interview skill decision option: ${input.optionId}`);
    }
    const outcome = await this.executeDecision(decision, input.optionId, input.note);
    const resolved = this.db.resolveInterviewSkillDecision({
      decisionId: decision.id,
      optionId: input.optionId,
      resolution: outcome,
    });
    return { decision: resolved, outcome };
  }

  private async executeDecision(
    decision: InterviewSkillDecisionRow,
    optionId: string,
    note?: string,
  ): Promise<Record<string, unknown>> {
    if (optionId === "HOLD") {
      const heldCase = decision.caseId
        ? this.db.holdInterviewCase({
            caseId: decision.caseId,
            decisionId: decision.id,
            reviewId: decision.reviewId,
            note,
          })
        : undefined;
      if (decision.reviewId) {
        this.db.resolveReview(decision.reviewId, "HOLD");
      }
      return {
        action: optionId,
        note: note?.trim() || null,
        ...(heldCase ? { case: heldCase } : {}),
        nextAction: "NONE",
      };
    }
    if (optionId === "WAIT") {
      return { action: optionId, note: note?.trim() || null, nextAction: "NONE" };
    }
    if (decision.decisionType === "START_INTERVIEW_ARRANGEMENT") {
      if (optionId !== "START") throw new Error(`Unsupported triage option: ${optionId}`);
      const routeTriggerStepId = text(decision.context.routeTriggerStepId);
      if (!routeTriggerStepId) {
        throw new Error("The interview route selection is missing from this decision.");
      }
      return {
        action: optionId,
        result: await this.workflow.approveInterviewArrangement({
          reviewId: requiredReviewId(decision),
          routeTriggerStepId,
        }),
      };
    }
    if (decision.decisionType === "SELECT_INTERVIEW_ROUTE") {
      const routeTriggerStepId = optionId.startsWith("ROUTE:")
        ? optionId.slice("ROUTE:".length)
        : "";
      if (!routeTriggerStepId) {
        throw new Error(`Unsupported interview route option: ${optionId}`);
      }
      return {
        action: optionId,
        result: await this.workflow.approveInterviewArrangement({
          reviewId: requiredReviewId(decision),
          routeTriggerStepId,
        }),
      };
    }
    if (decision.decisionType === "REVIEW_RECRUITMENT_TEMPLATE") {
      return {
        action: optionId,
        nextAction: "PREVIEW_RECRUITMENT_INTERVIEW_TEMPLATE",
        context: requiredDecisionContext(decision),
      };
    }
    if (decision.decisionType === "SYNC_INTERVIEWERS") {
      return {
        action: optionId,
        result: await this.workflow.syncCaseInterviewers(requiredCaseId(decision)),
      };
    }
    if (decision.decisionType === "MAP_INTERVIEWERS") {
      return {
        action: optionId,
        nextAction: "MAP_INTERVIEWER_TO_SLACK",
        context: requiredDecisionContext(decision),
      };
    }
    if (decision.decisionType === "CREATE_AVAILABILITY_REQUEST_DRAFT") {
      return {
        action: optionId,
        draft: await this.workflow.createRequestDraft(requiredCaseId(decision)),
        nextAction: "REVIEW_AND_APPROVE_INTERVIEWER_REQUEST",
      };
    }
    if (decision.decisionType === "REVIEW_AVAILABILITY_REQUEST_DRAFT") {
      const bundle = this.db.getCaseBundle(requiredCaseId(decision));
      return {
        action: optionId,
        drafts: bundle?.drafts.filter((draft) => draft.status === "DRAFT") ?? [],
        nextAction: "APPROVE_AND_SEND_INTERVIEWER_REQUEST",
      };
    }
    if (
      [
        "WAIT_FOR_AVAILABILITY",
        "OPEN_SCHEDULING",
        "COLLECT_AVAILABILITY_BEFORE_SCHEDULING",
        "SYNC_MEETING_ROOMS",
        "NO_SCHEDULING_SLOT",
      ].includes(decision.decisionType)
    ) {
      const nextAction = {
        OPEN_SCHEDULING: "CREATE_INTERVIEW_SCHEDULING_DECISION",
        OPEN_ROOM_SYNC: "SYNC_DAOU_MEETING_ROOM_BLOCKS",
        OPEN_RECOVERY: "CREATE_AVAILABILITY_RECOVERY_DRAFT",
        OPEN_AVAILABILITY: "CREATE_AVAILABILITY_COLLECTION_DECISION",
      }[optionId] ?? "NONE";
      return {
        action: optionId,
        nextAction,
        context: requiredDecisionContext(decision),
      };
    }
    if (decision.decisionType === "CONFIRM_STANDARD_SCHEDULE") {
      const choice = this.standardScheduleChoice(decision, optionId);
      const allocation = this.db.allocateRoomBlock({
        caseId: requiredCaseId(decision),
        roomBlockId: choice.roomBlockId,
        startTime: choice.startTime,
        endTime: choice.endTime,
      });
      const schedule = this.db.confirmInternalSchedule(requiredCaseId(decision));
      return {
        action: optionId,
        allocation,
        schedule,
        nextAction: "CREATE_CANDIDATE_SCHEDULE_PROPOSAL_DECISION",
      };
    }
    if (decision.decisionType === "CANDIDATE_SCHEDULE_PROPOSAL_SENT") {
      if (optionId !== "MARK_PROPOSAL_SENT") {
        throw new Error(`Unsupported candidate proposal option: ${optionId}`);
      }
      return {
        action: optionId,
        result: this.db.recordCandidateScheduleProposalSent(requiredCaseId(decision)),
        nextAction: "NONE",
      };
    }
    if (decision.decisionType === "CREATE_AVAILABILITY_RECOVERY_DRAFT") {
      if (optionId === "CONFIRM_NO_RECOVERY_NEEDED") {
        const reviewId = requiredReviewId(decision);
        const caseId = requiredCaseId(decision);
        this.db.resolveReview(reviewId, "AVAILABILITY_RECOVERY_NOT_NEEDED");
        this.db.addEvent(caseId, "AVAILABILITY_RECOVERY_NOT_NEEDED", "USER", { reviewId });
        return {
          action: optionId,
          nextAction: "WAIT_FOR_AVAILABILITY",
        };
      }
      if (optionId === "CREATE_RECOVERY_DRAFT") {
        return {
          action: optionId,
          draft: this.workflow.createAvailabilityRecoveryDraft(requiredReviewId(decision)),
          nextAction: "REVIEW_AND_APPROVE_AVAILABILITY_RECOVERY",
        };
      }
      throw new Error(`Unsupported availability recovery option: ${optionId}`);
    }
    if (decision.decisionType === "SELECT_CONFIRMED_SCHEDULE_ROOM") {
      const choice = this.standardScheduleChoice(decision, optionId);
      const allocation = this.db.allocateRoomBlock({
        caseId: requiredCaseId(decision),
        roomBlockId: choice.roomBlockId,
        startTime: choice.startTime,
        endTime: choice.endTime,
      });
      const schedule = this.db.setConfirmedScheduleRoomAllocation({
        caseId: requiredCaseId(decision),
        roomAllocationId: allocation.id,
        actor: "USER",
      });
      return {
        action: optionId,
        allocation,
        schedule,
        nextAction: "NONE",
      };
    }
    if (decision.decisionType === "SELECT_NINEHIRE_CONFIRMED_SCHEDULE_ROOM") {
      const choice = this.reconciledNinehireScheduleChoice(decision, optionId);
      const context = requiredDecisionContext(decision);
      const date = text(context.date);
      const startTime = text(context.startTime);
      const endTime = text(context.endTime);
      if (!date || !startTime || !endTime) {
        throw new Error("The reconciled NineHire schedule is incomplete.");
      }
      return {
        action: optionId,
        result: this.workflow.recordManualConfirmedInterview({
          reviewId: requiredReviewId(decision),
          date,
          startTime,
          endTime,
          roomName: choice.roomName,
          note: `나인하이어 직접 확정 일정 ${text(context.eventId) ?? ""}에서 사용자 선택으로 기록`,
        }),
        nextAction: "NONE",
      };
    }
    if (decision.decisionType === "CONFIRM_SEQUENTIAL_SCHEDULE") {
      const choice = this.sequentialScheduleChoice(decision, optionId);
      const allocations = this.db.allocateSequentialRoomBlocks({
        caseId: requiredCaseId(decision),
        sessions: choice.sessions.map((session) => ({
          stepId: session.stepId,
          roomBlockId: session.room.roomBlockId,
          startTime: session.startTime,
          endTime: session.endTime,
        })),
      });
      const schedule = this.db.confirmSequentialInternalSchedule(requiredCaseId(decision));
      return {
        action: optionId,
        order: choice.order,
        allocations,
        schedule,
        nextAction: "CREATE_CANDIDATE_SCHEDULE_PROPOSAL_DECISION",
      };
    }
    if (decision.decisionType === "CANDIDATE_INTERVIEW_ABSENCE") {
      const action =
        optionId === "RESCHEDULE_REUSE"
          ? "RESCHEDULE_USING_EXISTING_AVAILABILITY"
          : optionId === "RESCHEDULE_RECOLLECT"
            ? "RESCHEDULE_WITH_NEW_AVAILABILITY"
            : optionId === "CANCEL"
              ? "CANCEL"
              : optionId === "HOLD"
                ? "HOLD"
                : undefined;
      if (!action) {
        throw new Error(`Unsupported candidate response option: ${optionId}`);
      }
      return {
        action: optionId,
        result: await this.workflow.resolveCandidateInterviewAbsenceReview({
          reviewId: requiredReviewId(decision),
          action,
          ...(note?.trim() ? { note: note.trim() } : {}),
        }),
      };
    }
    throw new Error(`Unsupported interview skill decision type: ${decision.decisionType}`);
  }

  private createSequentialSchedulingDecision(
    caseId: string,
    context: Record<string, unknown>,
  ): InterviewSkillDecisionRow {
    const result = suggestSequentialInterviewSlotsWithRooms(this.db, caseId) as {
      ready: boolean;
      missingRequiredResponses: string[];
      suggestions: SequentialScheduleChoice[];
    };
    if (!result.ready || result.suggestions.length === 0) {
      return pendingDecision(this.db, {
        skillKey: "INTERVIEW_SCHEDULING",
        decisionType: "COLLECT_AVAILABILITY_BEFORE_SCHEDULING",
        fingerprint: `case:${caseId}:sequential-missing:${result.missingRequiredResponses.join("|")}`,
        caseId,
        title: "연속 인터뷰 가능 일정 필요",
        prompt: "각 단계 면접관의 가능 일정과 회의실 블록을 다시 확인하세요.",
        selectionMode: "SINGLE",
        options: decisionOptions([
          ["OPEN_AVAILABILITY", "일정 수집으로 이동", "면접관 가능 일정 수집 상태를 확인합니다."],
          ["HOLD", "보류", "현재 조율을 보류합니다."],
        ]),
        context: { ...context, missingRequiredResponses: result.missingRequiredResponses },
      });
    }
    const choices = result.suggestions.slice(0, 10).map((suggestion, index) => ({
      ...suggestion,
      optionId: `SEQUENTIAL_${index}`,
    }));
    return pendingDecision(this.db, {
      skillKey: "INTERVIEW_SCHEDULING",
      decisionType: "CONFIRM_SEQUENTIAL_SCHEDULE",
      fingerprint: `case:${caseId}:sequential:${choices.map((choice) => [
        choice.optionId,
        choice.order,
        choice.date,
        ...choice.sessions.flatMap((session) => [
          session.stepId,
          session.startTime,
          session.endTime,
          session.room.roomBlockId,
        ]),
      ].join(":")).join("|")}`,
      caseId,
      title: "연속 인터뷰 시간과 회의실 선택",
      prompt: "단계 순서와 회의실 조합을 확인한 뒤 하나를 내부 확정하세요.",
      selectionMode: "SINGLE",
      options: choices.map((choice) => ({
        id: choice.optionId,
        label: `${choice.date} ${choice.sessions[0]?.startTime ?? ""}~${choice.sessions.at(-1)?.endTime ?? ""}`,
        description: `${choice.order === "NORMAL" ? "기본 단계 순서" : "가용시간 부족으로 역순 진행"} · ${choice.sessions.map((session) => session.room.roomName).join(" → ")}`,
      })),
      context: { ...context, scheduleKind: "SEQUENTIAL", choices },
    });
  }

  private standardScheduleChoice(
    decision: InterviewSkillDecisionRow,
    optionId: string,
  ): StandardScheduleChoice {
    const choices = records(requiredDecisionContext(decision).choices).flatMap((choice) => {
      const optionIdValue = text(choice.optionId);
      const date = text(choice.date);
      const startTime = text(choice.startTime);
      const endTime = text(choice.endTime);
      const roomBlockId = text(choice.roomBlockId);
      const roomName = text(choice.roomName);
      if (!optionIdValue || !date || !startTime || !endTime || !roomBlockId || !roomName) {
        return [];
      }
      return [{ optionId: optionIdValue, date, startTime, endTime, roomBlockId, roomName }];
    });
    const choice = choices.find((item) => item.optionId === optionId);
    if (!choice) throw new Error(`Standard schedule choice not found: ${optionId}`);
    return choice;
  }

  private sequentialScheduleChoice(
    decision: InterviewSkillDecisionRow,
    optionId: string,
  ): SequentialScheduleChoice {
    const choice = records(requiredDecisionContext(decision).choices).find(
      (item) => text(item.optionId) === optionId,
    );
    if (!choice) throw new Error(`Sequential schedule choice not found: ${optionId}`);
    const order = text(choice.order);
    const date = text(choice.date);
    const sessions = records(choice.sessions).flatMap((session) => {
      const room = asRecord(session.room);
      const stepId = text(session.stepId);
      const stepName = text(session.stepName);
      const startTime = text(session.startTime);
      const endTime = text(session.endTime);
      const roomBlockId = text(room?.roomBlockId);
      const roomName = text(room?.roomName);
      const roomStartTime = text(room?.startTime);
      const roomEndTime = text(room?.endTime);
      if (
        !stepId || !stepName || !startTime || !endTime || !roomBlockId || !roomName ||
        !roomStartTime || !roomEndTime
      ) {
        return [];
      }
      return [{
        stepId,
        stepName,
        startTime,
        endTime,
        room: {
          roomBlockId,
          roomName,
          startTime: roomStartTime,
          endTime: roomEndTime,
        },
      }];
    });
    if ((order !== "NORMAL" && order !== "REVERSED") || !date || sessions.length === 0) {
      throw new Error(`Sequential schedule choice is invalid: ${optionId}`);
    }
    return { optionId, order, date, sessions };
  }

  private reconciledNinehireScheduleChoice(
    decision: InterviewSkillDecisionRow,
    optionId: string,
  ): ReconciledNinehireScheduleChoice {
    const choice = records(requiredDecisionContext(decision).choices).find(
      (item) => text(item.optionId) === optionId,
    );
    const roomName = text(choice?.roomName);
    if (!choice || !roomName) {
      throw new Error(`Reconciled NineHire schedule choice not found: ${optionId}`);
    }
    return { optionId, roomName };
  }
}
