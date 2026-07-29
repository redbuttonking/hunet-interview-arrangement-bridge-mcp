import { createHash } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import type { AppConfig } from "../config.js";
import {
  BridgeDatabase,
  type CaseBundle,
  type ConfirmedInterviewScheduleRow,
  type DraftRow,
  type InterviewCaseRow,
  type IntegrationRetryJobRow,
  type InterviewPlanMode,
  type RecruitmentInterviewRoute,
  type RecruitmentInterviewTemplateStep,
  type ScheduleTransitionResult,
  type WorkerDowntime,
} from "../db/database.js";
import { proposalDates } from "../domain/calendar.js";
import type {
  CandidateContext,
  EvaluationSummary,
  RescheduleAvailabilityPolicy,
  ScoreSheetSummary,
  SlackNotificationInput,
} from "../domain/types.js";
import type { NinehireWorkflowAdapter } from "../ninehire/adapter.js";
import {
  buildRequestMessage,
  buildAvailabilityRecoveryMessage,
  buildScheduleConfirmationMessage,
  buildScheduleUpdateMessage,
  type SequentialInterviewScheduleMessageSession,
} from "../slack/blocks.js";
import {
  isCandidateInterviewAbsenceText,
  parseConfirmedScheduleDateTime,
  type ParsedSlackNotification,
} from "../slack/parser.js";

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

function scheduleDurationMinutes(startTime: string, endTime: string): number {
  const start = startTime.match(/^(\d{2}):(\d{2})$/);
  const end = endTime.match(/^(\d{2}):(\d{2})$/);
  if (!start || !end) {
    throw new Error("A valid interview start and end time are required.");
  }
  if (
    Number(start[1]) > 23 ||
    Number(start[2]) > 59 ||
    Number(end[1]) > 23 ||
    Number(end[2]) > 59
  ) {
    throw new Error("A valid interview start and end time are required.");
  }
  const startMinutes = Number(start[1]) * 60 + Number(start[2]);
  const endMinutes = Number(end[1]) * 60 + Number(end[2]);
  if (startMinutes >= endMinutes) {
    throw new Error("The interview end time must be later than the start time.");
  }
  return endMinutes - startMinutes;
}

function hashPayload(text: string, blocks: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ text, blocks }))
    .digest("hex");
}

function pipelineHash(steps: Array<{ stepId: string; title: string; name: string; order: number }>): string {
  return createHash("sha256")
    .update(JSON.stringify(steps.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      name: step.name,
      order: step.order,
    }))))
    .digest("hex");
}

function isSuggestedInterviewStep(step: { title: string; name: string }): boolean {
  const text = `${step.title} ${step.name}`;
  return /면접|인터뷰|시강|CEO\s*와의\s*대화/ui.test(text);
}

function suggestedInterviewMode(
  step: { title: string; name: string },
): "STANDARD" | "COMBINED" {
  const normalized = `${step.title} ${step.name}`.replace(/\s/gu, "").toLowerCase();
  return normalized.includes("실무자+hr") ||
    normalized.includes("실무자+임원") ||
    normalized.includes("실무자,임원")
    ? "COMBINED"
    : "STANDARD";
}

type RecruitmentInterviewRouteSelection = {
  triggerStepId: string;
  mode: InterviewPlanMode;
  stepIds: string[];
};

function defaultRoutes(
  steps: RecruitmentInterviewTemplateStep[],
): RecruitmentInterviewRoute[] {
  return steps.map((step) => ({
    triggerStepId: step.stepId,
    mode: step.mode,
    stepIds: [step.stepId],
  }));
}

function resolveTemplateRoutes(
  steps: RecruitmentInterviewTemplateStep[],
  selections: RecruitmentInterviewRouteSelection[] | undefined,
): RecruitmentInterviewRoute[] {
  if (!selections || selections.length === 0) return defaultRoutes(steps);

  const byId = new Map(steps.map((step) => [step.stepId, step]));
  if (new Set(selections.map((route) => route.triggerStepId)).size !== selections.length) {
    throw new Error("Each interview route needs a unique trigger step.");
  }
  const explicitRoutes = selections.map((selection) => {
    const uniqueStepIds = [...new Set(selection.stepIds)];
    if (
      !byId.has(selection.triggerStepId) ||
      uniqueStepIds.length === 0 ||
      uniqueStepIds.some((stepId) => !byId.has(stepId))
    ) {
      throw new Error("Interview routes must use configured interview steps.");
    }
    const orderedStepIds = uniqueStepIds
      .sort((left, right) => byId.get(left)!.order - byId.get(right)!.order);
    if (orderedStepIds[0] !== selection.triggerStepId) {
      throw new Error("An interview route must start with its trigger step.");
    }
    if (selection.mode === "STANDARD" && orderedStepIds.length !== 1) {
      throw new Error("A standard interview route must contain exactly one step.");
    }
    if (selection.mode === "SEQUENTIAL" && orderedStepIds.length < 2) {
      throw new Error("A sequential interview route needs at least two stages.");
    }
    if (
      selection.mode === "SEQUENTIAL" &&
      orderedStepIds.some((stepId) => byId.get(stepId)!.durationMinutes !== 60)
    ) {
      throw new Error("Every sequential interview stage must be 60 minutes.");
    }
    return {
      triggerStepId: selection.triggerStepId,
      mode: selection.mode,
      stepIds: orderedStepIds,
    };
  });
  const coveredStepIds = new Set(explicitRoutes.flatMap((route) => route.stepIds));
  return [
    ...explicitRoutes,
    ...steps
      .filter((step) => !coveredStepIds.has(step.stepId))
      .map((step) => ({
        triggerStepId: step.stepId,
        mode: step.mode,
        stepIds: [step.stepId],
      })),
  ].sort(
    (left, right) =>
      byId.get(left.triggerStepId)!.order - byId.get(right.triggerStepId)!.order,
  );
}

function replaceExactText(
  value: unknown,
  textToReplace: string,
  replacementText: string,
): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (count, item) =>
        count + replaceExactText(item, textToReplace, replacementText),
      0,
    );
  }
  if (!value || typeof value !== "object") return 0;

  let replaced = 0;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === "text" && child === textToReplace) {
      record[key] = replacementText;
      replaced += 1;
      continue;
    }
    replaced += replaceExactText(child, textToReplace, replacementText);
  }
  return replaced;
}

function slackMetadataEventType(messageType: DraftRow["messageType"]): string {
  if (messageType === "INTERVIEWER_REQUEST") {
    return "interview_bridge_request";
  }
  if (messageType === "SCHEDULE_CONFIRMATION") {
    return "interview_bridge_schedule_confirmation";
  }
  if (messageType === "AVAILABILITY_RECOVERY") {
    return "interview_bridge_availability_recovery";
  }
  return "interview_bridge_schedule_update";
}

export interface SlackIdentityResolver {
  lookupUserIdByEmail(email: string): Promise<string | undefined>;
}

interface EvaluationApprovalPayload {
  context: CandidateContext;
  evaluation: EvaluationSummary;
}

type InterviewArrangementEligibility =
  | "ELIGIBLE"
  | "NOT_ELIGIBLE"
  | "REVIEW_REQUIRED";

function evaluationApprovalPayload(
  value: Record<string, unknown> | null,
): EvaluationApprovalPayload | undefined {
  if (!value) return undefined;
  const context = value.context;
  const evaluation = value.evaluation;
  if (
    !context ||
    typeof context !== "object" ||
    Array.isArray(context) ||
    !evaluation ||
    typeof evaluation !== "object" ||
    Array.isArray(evaluation)
  ) {
    return undefined;
  }
  const candidateContext = context as CandidateContext;
  const evaluationSummary = evaluation as EvaluationSummary;
  if (
    !evaluationSummary.applicantProgressId ||
    !evaluationSummary.recruitmentId ||
    !Array.isArray(evaluationSummary.scoreSheets)
  ) {
    return undefined;
  }
  return { context: candidateContext, evaluation: evaluationSummary };
}

function finalDecisionTitles(scoreSheet: ScoreSheetSummary): string[] {
  return scoreSheet.evaluators.flatMap((evaluator) =>
    evaluator.items
      .filter((item) => item.finalEvaluation)
      .flatMap((item) => item.selectedOptions.map((option) => option.title.trim())),
  );
}

function latestFinalScoreSheet(
  evaluation: EvaluationSummary,
): ScoreSheetSummary | undefined {
  const scoreSheets = evaluation.scoreSheets
    .map((scoreSheet) => ({
      scoreSheet,
      completedAt: Date.parse(scoreSheet.completedAt ?? ""),
    }))
    .filter(({ scoreSheet }) => finalDecisionTitles(scoreSheet).length > 0);

  if (scoreSheets.length === 0) return undefined;
  if (scoreSheets.length === 1) return scoreSheets[0]!.scoreSheet;
  if (scoreSheets.some(({ completedAt }) => !Number.isFinite(completedAt))) {
    return undefined;
  }

  scoreSheets.sort((left, right) => right.completedAt - left.completedAt);
  if (scoreSheets[0]!.completedAt === scoreSheets[1]!.completedAt) {
    return undefined;
  }
  return scoreSheets[0]!.scoreSheet;
}

function classifyInterviewArrangementEligibility(
  evaluation: EvaluationSummary,
): InterviewArrangementEligibility {
  const scoreSheet = latestFinalScoreSheet(evaluation);
  if (!scoreSheet) return "REVIEW_REQUIRED";

  const decisions = finalDecisionTitles(scoreSheet);

  const hasPass = decisions.some(
    (title) => title.includes("합격") && !title.includes("불합격"),
  );
  if (hasPass) return "ELIGIBLE";

  const hasOnlyRejectOrHold = decisions.every(
    (title) => title.includes("불합격") || title.includes("보류"),
  );
  return hasOnlyRejectOrHold ? "NOT_ELIGIBLE" : "REVIEW_REQUIRED";
}

type RecruitmentTemplateCheck =
  | { status: "NOT_CONFIGURED" }
  | { status: "MATCHED" }
  | {
      status: "CHANGED";
      template: ReturnType<BridgeDatabase["getRecruitmentInterviewTemplate"]>;
      pipeline: {
        recruitmentId: string;
        recruitmentName: string;
        pipelineHash: string;
        steps: Array<{ stepId: string; title: string; name: string; order: number }>;
      };
    }
  | {
      status: "UNAVAILABLE";
      template: ReturnType<BridgeDatabase["getRecruitmentInterviewTemplate"]>;
    };

function evaluationRetryPayload(
  payload: Record<string, unknown>,
): { notificationId: string; parsed: ParsedSlackNotification } | undefined {
  const notificationId = payload.notificationId;
  const parsed = payload.parsed;
  if (
    typeof notificationId !== "string" ||
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return undefined;
  }
  const notification = parsed as Partial<ParsedSlackNotification>;
  if (
    notification.eventType !== "EVALUATION_COMPLETED" ||
    typeof notification.title !== "string" ||
    typeof notification.text !== "string" ||
    !Array.isArray(notification.links) ||
    typeof notification.payloadHash !== "string" ||
    typeof notification.payloadJson !== "string"
  ) {
    return undefined;
  }
  return { notificationId, parsed: notification as ParsedSlackNotification };
}

export class WorkflowService {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly config: AppConfig,
    private readonly ninehire: NinehireWorkflowAdapter,
    private readonly identityResolver?: SlackIdentityResolver,
  ) {}

  async previewRecruitmentInterviewTemplate(recruitmentId: string) {
    if (!this.ninehire.getRecruitmentPipeline) {
      throw new Error("NineHire recruitment pipeline lookup is not available.");
    }
    const pipeline = await this.ninehire.getRecruitmentPipeline(recruitmentId);
    const hash = pipelineHash(pipeline.steps);
    const approved = this.db.getRecruitmentInterviewTemplate(pipeline.recruitmentId);
    return {
      recruitmentId: pipeline.recruitmentId,
      recruitmentName: pipeline.recruitmentName,
      pipelineHash: hash,
      requiresApproval: !approved || approved.pipelineHash !== hash,
      approvedTemplate: approved ?? null,
      suggestedRoutes: defaultRoutes(
        pipeline.steps
          .filter((step) => isSuggestedInterviewStep(step))
          .map((step) => ({
            ...step,
            mode: suggestedInterviewMode(step),
            durationMinutes: 60,
          })),
      ),
      steps: pipeline.steps.map((step) => ({
        ...step,
        suggestedAsInterview: isSuggestedInterviewStep(step),
        suggestedMode: isSuggestedInterviewStep(step)
          ? suggestedInterviewMode(step)
          : null,
        defaultDurationMinutes: 60,
      })),
    };
  }

  async approveRecruitmentInterviewTemplate(input: {
    recruitmentId: string;
    steps: Array<{
      stepId: string;
      mode: "STANDARD" | "COMBINED";
      durationMinutes?: number;
    }>;
    routes?: RecruitmentInterviewRouteSelection[];
  }) {
    if (!this.ninehire.getRecruitmentPipeline) {
      throw new Error("NineHire recruitment pipeline lookup is not available.");
    }
    if (input.steps.length === 0) {
      throw new Error("Select at least one interview step before approval.");
    }
    if (
      input.steps.some((step) =>
        step.durationMinutes !== undefined &&
        (!Number.isInteger(step.durationMinutes) || step.durationMinutes <= 0),
      )
    ) {
      throw new Error("Interview step duration must be a positive whole number of minutes.");
    }
    if (
      input.steps.some(
        (step) => step.mode === "COMBINED" && step.durationMinutes !== undefined && step.durationMinutes !== 60,
      )
    ) {
      throw new Error("A combined interview template must be 60 minutes.");
    }
    const pipeline = await this.ninehire.getRecruitmentPipeline(input.recruitmentId);
    const pipelineById = new Map(pipeline.steps.map((step) => [step.stepId, step]));
    if (
      new Set(input.steps.map((step) => step.stepId)).size !== input.steps.length ||
      input.steps.some((step) => !pipelineById.has(step.stepId))
    ) {
      throw new Error("Selected interview steps do not match the current NineHire pipeline.");
    }
    const steps = input.steps
      .map((selection) => {
        const step = pipelineById.get(selection.stepId)!;
        return {
          stepId: step.stepId,
          title: step.title,
          name: step.name,
          order: step.order,
          mode: selection.mode,
          durationMinutes: selection.durationMinutes ?? 60,
        };
      })
      .sort((left, right) => left.order - right.order);
    const routes = resolveTemplateRoutes(steps, input.routes);
    return this.db.upsertRecruitmentInterviewTemplate({
      recruitmentId: pipeline.recruitmentId,
      recruitmentName: pipeline.recruitmentName,
      pipelineHash: pipelineHash(pipeline.steps),
      steps,
      routes,
    });
  }

  private async checkRecruitmentTemplate(
    evaluation: EvaluationSummary,
  ): Promise<RecruitmentTemplateCheck> {
    const template = this.db.getRecruitmentInterviewTemplate(
      evaluation.recruitmentId,
    );
    if (!template) return { status: "NOT_CONFIGURED" };
    if (!this.ninehire.getRecruitmentPipeline) {
      return { status: "UNAVAILABLE", template };
    }

    const pipeline = await this.ninehire.getRecruitmentPipeline(
      evaluation.recruitmentId,
    );
    const currentPipelineHash = pipelineHash(pipeline.steps);
    if (template.pipelineHash === currentPipelineHash) {
      return { status: "MATCHED" };
    }
    return {
      status: "CHANGED",
      template,
      pipeline: {
        recruitmentId: pipeline.recruitmentId,
        recruitmentName: pipeline.recruitmentName,
        pipelineHash: currentPipelineHash,
        steps: pipeline.steps,
      },
    };
  }

  setCaseCombinedInterviewPlan(input: {
    caseId: string;
    stepIds: string[];
    interviewerIds: string[];
  }) {
    const interviewCase = this.db.getCase(input.caseId);
    if (!interviewCase?.recruitmentRef) {
      throw new Error("The case is missing its NineHire recruitment ID.");
    }
    if (!["READY_FOR_DRAFT", "DRAFT_CREATED"].includes(interviewCase.status)) {
      throw new Error("Change an interview plan before sending an interviewer request.");
    }
    if (input.stepIds.length < 2) {
      throw new Error("A combined interview requires at least two interview stages.");
    }
    const template = this.db.getRecruitmentInterviewTemplate(
      interviewCase.recruitmentRef,
    );
    if (!template) {
      throw new Error("Approve the recruitment interview template before setting an exception.");
    }
    const steps = input.stepIds.map((stepId) =>
      template.steps.find((step) => step.stepId === stepId),
    );
    if (steps.some((step) => !step)) {
      throw new Error("The selected stages are not configured interview stages.");
    }
    this.db.setRequiredInterviewers(input.caseId, input.interviewerIds);
    const plan = this.db.upsertCaseInterviewPlan({
      caseId: input.caseId,
      source: "CANDIDATE_OVERRIDE",
      mode: "COMBINED",
      stepIds: input.stepIds,
      stepNames: steps.map((step) => step!.name),
      interviewerIds: input.interviewerIds,
      durationMinutes: 60,
    });
    this.db.addEvent(input.caseId, "CANDIDATE_COMBINED_INTERVIEW_CONFIGURED", "USER", {
      stepIds: plan.stepIds,
      interviewerIds: plan.interviewerIds,
      durationMinutes: plan.durationMinutes,
    });
    return plan;
  }

  setCaseSequentialInterviewPlan(input: {
    caseId: string;
    sessions: Array<{ stepId: string; interviewerIds: string[] }>;
  }) {
    const interviewCase = this.db.getCase(input.caseId);
    if (!interviewCase?.recruitmentRef) {
      throw new Error("The case is missing its NineHire recruitment ID.");
    }
    if (!["READY_FOR_DRAFT", "DRAFT_CREATED"].includes(interviewCase.status)) {
      throw new Error("Change an interview plan before sending an interviewer request.");
    }
    if (input.sessions.length < 2) {
      throw new Error("A sequential interview requires at least two stages.");
    }
    if (new Set(input.sessions.map((session) => session.stepId)).size !== input.sessions.length) {
      throw new Error("Each sequential interview stage can be selected only once.");
    }
    const template = this.db.getRecruitmentInterviewTemplate(
      interviewCase.recruitmentRef,
    );
    if (!template) {
      throw new Error("Approve the recruitment interview template before setting an exception.");
    }
    const sessions = input.sessions.map((session) => {
      const step = template.steps.find((item) => item.stepId === session.stepId);
      if (!step || session.interviewerIds.length === 0) {
        throw new Error("Each sequential stage needs a configured step and at least one interviewer.");
      }
      return {
        stepId: step.stepId,
        stepName: step.name,
        interviewerIds: [...new Set(session.interviewerIds)],
      };
    });
    const interviewerIds = [...new Set(sessions.flatMap((session) => session.interviewerIds))];
    this.db.setRequiredInterviewers(input.caseId, interviewerIds);
    const plan = this.db.upsertCaseInterviewPlan({
      caseId: input.caseId,
      source: "CANDIDATE_OVERRIDE",
      mode: "SEQUENTIAL",
      stepIds: sessions.map((session) => session.stepId),
      stepNames: sessions.map((session) => session.stepName),
      interviewerIds,
      sessions,
      durationMinutes: sessions.length * 60,
    });
    this.db.addEvent(input.caseId, "CANDIDATE_SEQUENTIAL_INTERVIEW_CONFIGURED", "USER", {
      sessions,
      durationMinutes: plan.durationMinutes,
    });
    return plan;
  }

  async ingestSlackNotification(input: {
    channelId: string;
    messageTs: string;
    sourceBotId?: string;
    parsed: ParsedSlackNotification;
  }): Promise<{ notificationId: string; result: string; caseId?: string }> {
    const notification: SlackNotificationInput = {
      channelId: input.channelId,
      messageTs: input.messageTs,
      sourceBotId: input.sourceBotId,
      eventType: input.parsed.eventType,
      title: input.parsed.title,
      payloadHash: input.parsed.payloadHash,
      payloadJson: input.parsed.payloadJson,
      candidateRef: input.parsed.candidateRef,
      candidateName: input.parsed.candidateName,
      recruitmentRef: input.parsed.recruitmentRef,
      recruitmentName: input.parsed.recruitmentName,
    };
    const stored = this.db.insertNotification(
      notification,
      input.parsed.eventType === "EVALUATION_COMPLETED"
        ? "EVALUATION_LOOKUP_PENDING"
        : input.parsed.eventType === "SCHEDULE_CONFIRMED"
          ? "SCHEDULE_CONFIRMATION_PENDING"
          : input.parsed.eventType === "CANDIDATE_INTERVIEW_ABSENCE"
            ? "CANDIDATE_ATTENDANCE_REVIEW_PENDING"
          : "IGNORED",
    );
    if (!stored.inserted) {
      return { notificationId: stored.id, result: "DUPLICATE" };
    }
    if (input.parsed.eventType !== "EVALUATION_COMPLETED") {
      if (input.parsed.eventType === "SCHEDULE_CONFIRMED") {
        return this.processScheduleConfirmation(stored.id, input.parsed);
      }
      if (input.parsed.eventType === "CANDIDATE_INTERVIEW_ABSENCE") {
        return this.processCandidateInterviewAbsence(
          stored.id,
          input.parsed,
        );
      }
      return { notificationId: stored.id, result: "IGNORED" };
    }

    try {
      return await this.processEvaluationLookup(stored.id, input.parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateNotificationStatus(stored.id, "RETRY_PENDING", message);
      this.db.enqueueIntegrationRetry({
        jobType: "NINEHIRE_EVALUATION_LOOKUP",
        dedupeKey: stored.id,
        payload: {
          notificationId: stored.id,
          parsed: input.parsed,
        },
      });
      return { notificationId: stored.id, result: "EVALUATION_RETRY_SCHEDULED" };
    }
  }

  async processIntegrationRetryJob(
    job: IntegrationRetryJobRow,
  ): Promise<void> {
    if (job.jobType !== "NINEHIRE_EVALUATION_LOOKUP") {
      throw new Error(`Unsupported workflow retry job: ${job.jobType}`);
    }
    const payload = evaluationRetryPayload(job.payload);
    if (!payload) {
      throw new Error("Evaluation retry job payload is invalid.");
    }
    await this.processEvaluationLookup(payload.notificationId, payload.parsed);
  }

  handleIntegrationRetryExhausted(
    job: IntegrationRetryJobRow,
  ): void {
    if (job.jobType !== "NINEHIRE_EVALUATION_LOOKUP") return;
    const payload = evaluationRetryPayload(job.payload);
    if (!payload) return;
    const reason =
      job.lastError ?? "평가표 조회 재시도 횟수를 모두 사용했습니다.";
    this.db.updateNotificationStatus(payload.notificationId, "ERROR", reason);
    this.db.createReview({
      notificationId: payload.notificationId,
      reviewType: "EVALUATION_LOOKUP_FAILED",
      reason,
    });
  }

  private async processEvaluationLookup(
    notificationId: string,
    parsed: ParsedSlackNotification,
  ): Promise<{ notificationId: string; result: string }> {
    const evaluation = await this.ninehire.lookupCompletedEvaluation(parsed);
    if (!evaluation.context || !evaluation.summary) {
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      this.db.createReview({
        notificationId,
        reviewType: "EVALUATION_LOOKUP_REQUIRED",
        reason:
          evaluation.reason ??
          "평가표를 조회했지만 검토에 필요한 정보를 만들지 못했습니다.",
      });
      return { notificationId, result: "REVIEW_REQUIRED" };
    }
    const eligibility = classifyInterviewArrangementEligibility(
      evaluation.summary,
    );
    if (eligibility === "NOT_ELIGIBLE") {
      this.db.updateNotificationStatus(notificationId, "NOT_ELIGIBLE");
      return { notificationId, result: "EVALUATION_NOT_ELIGIBLE" };
    }

    if (eligibility === "REVIEW_REQUIRED") {
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      this.db.createReview({
        notificationId,
        reviewType: "EVALUATION_DECISION_REQUIRED",
        reason:
          "최종 평가 항목에서 합격·불합격·보류를 판단할 수 없습니다. 평가표를 확인하세요.",
        summary: {
          context: evaluation.context,
          evaluation: evaluation.summary,
        },
      });
      return { notificationId, result: "EVALUATION_DECISION_REQUIRED" };
    }

    const templateCheck = await this.checkRecruitmentTemplate(evaluation.summary);
    if (templateCheck.status === "CHANGED") {
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      this.db.createReview({
        notificationId,
        reviewType: "RECRUITMENT_TEMPLATE_UPDATE_REQUIRED",
        reason:
          "나인하이어의 현재 채용 단계가 저장된 인터뷰 템플릿과 다릅니다. 템플릿을 확인·갱신한 뒤 인터뷰 조율을 시작하세요.",
        summary: {
          context: evaluation.context,
          evaluation: evaluation.summary,
          template: templateCheck.template,
          currentPipeline: templateCheck.pipeline,
        },
      });
      return { notificationId, result: "RECRUITMENT_TEMPLATE_UPDATE_REQUIRED" };
    }

    if (templateCheck.status === "UNAVAILABLE") {
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      this.db.createReview({
        notificationId,
        reviewType: "RECRUITMENT_TEMPLATE_CHECK_REQUIRED",
        reason:
          "저장된 인터뷰 템플릿이 있지만 현재 채용 단계를 확인할 수 없습니다. 템플릿을 확인한 뒤 인터뷰 조율을 시작하세요.",
        summary: {
          context: evaluation.context,
          evaluation: evaluation.summary,
          template: templateCheck.template,
        },
      });
      return { notificationId, result: "RECRUITMENT_TEMPLATE_CHECK_REQUIRED" };
    }

    this.db.updateNotificationStatus(notificationId, "AWAITING_START_APPROVAL");
    this.db.createReview({
      notificationId,
      reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      reason:
        "완료된 평가표 요약을 확인한 뒤 인터뷰 조율 시작 여부를 승인하세요.",
      summary: {
        context: evaluation.context,
        evaluation: evaluation.summary,
      },
    });
    return { notificationId, result: "EVALUATION_READY_FOR_APPROVAL" };
  }

  reprocessInterviewArrangementEligibilityReviews(): {
    scanned: number;
    eligible: number;
    excluded: number;
    decisionRequired: number;
  } {
    const reviews = this.db
      .listOpenReviews(1_000)
      .filter(
        (review) =>
          review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      );
    let eligible = 0;
    let excluded = 0;
    let decisionRequired = 0;

    for (const review of reviews) {
      const approval = evaluationApprovalPayload(review.summary);
      if (!approval) {
        decisionRequired += 1;
        continue;
      }

      const eligibility = classifyInterviewArrangementEligibility(
        approval.evaluation,
      );
      if (eligibility === "ELIGIBLE") {
        eligible += 1;
        continue;
      }

      this.db.transaction(() => {
        if (review.notificationId) {
          this.db.updateNotificationStatus(
            review.notificationId,
            eligibility === "NOT_ELIGIBLE" ? "NOT_ELIGIBLE" : "REVIEW_REQUIRED",
          );
        }
        this.db.resolveReview(
          review.id,
          eligibility === "NOT_ELIGIBLE"
            ? "AUTO_EXCLUDED_NO_PASS"
            : "SUPERSEDED_BY_EVALUATION_DECISION_REVIEW",
        );
        if (eligibility === "REVIEW_REQUIRED") {
          this.db.createReview({
            notificationId: review.notificationId ?? undefined,
            reviewType: "EVALUATION_DECISION_REQUIRED",
            reason:
              "최종 평가 항목에서 합격·불합격·보류를 판단할 수 없습니다. 평가표를 확인하세요.",
            summary: review.summary ?? undefined,
          });
        }
      });

      if (eligibility === "NOT_ELIGIBLE") excluded += 1;
      else decisionRequired += 1;
    }

    return {
      scanned: reviews.length,
      eligible,
      excluded,
      decisionRequired,
    };
  }

  createWorkerDowntimeReviews(downtime: WorkerDowntime): {
    downtime: WorkerDowntime;
    impactedCaseIds: string[];
    reviewIds: string[];
  } {
    const impactedCases = this.db.listCasesWithPendingRequiredInterviewers();
    const reviewIds: string[] = [];
    this.db.transaction(() => {
      for (const interviewCase of impactedCases) {
        const reviewId = this.db.createReview({
          caseId: interviewCase.id,
          reviewType: "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED",
          reason:
            "Slack 워커 중단 구간에 면접관 가용시간 제출이 누락됐을 수 있습니다. 재제출 요청 초안을 만들거나 직접 확인하세요.",
          summary: {
            workerKey: downtime.workerKey,
            downtimeStartedAt: downtime.startedAt,
            downtimeDetectedAt: downtime.detectedAt,
            downtimeDurationMs: downtime.durationMs,
          },
        });
        this.db.addEvent(
          interviewCase.id,
          "WORKER_DOWNTIME_AVAILABILITY_REVIEW_CREATED",
          "SYSTEM",
          { reviewId, ...downtime },
        );
        reviewIds.push(reviewId);
      }
    });
    return {
      downtime,
      impactedCaseIds: impactedCases.map((interviewCase) => interviewCase.id),
      reviewIds,
    };
  }

  createAvailabilityRecoveryDraft(reviewId: string): DraftRow {
    if (!this.config.slack.requestChannelId) {
      throw new Error("SLACK_REQUEST_CHANNEL_ID is not configured.");
    }
    const review = this.db.getReview(reviewId);
    if (
      !review ||
      review.status !== "OPEN" ||
      !review.caseId ||
      review.reviewType !== "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED"
    ) {
      throw new Error(`Open worker-downtime availability review not found: ${reviewId}`);
    }
    const summary = review.summary;
    const startedAt = summary?.downtimeStartedAt;
    const detectedAt = summary?.downtimeDetectedAt;
    if (typeof startedAt !== "string" || typeof detectedAt !== "string") {
      throw new Error("Worker downtime interval is missing from the review.");
    }
    const existing = this.db.findActiveDraftByWorkflowReviewId(
      review.id,
      "AVAILABILITY_RECOVERY",
    );
    if (existing) return existing;
    const bundle = this.db.getCaseBundle(review.caseId);
    if (!bundle || bundle.interviewCase.status !== "COLLECTING_AVAILABILITY") {
      throw new Error(
        "The case is not collecting interviewer availability for this recovery request.",
      );
    }
    const missingSlackMappings = bundle.interviewers.filter(
      (interviewer) =>
        interviewer.active &&
        interviewer.required &&
        interviewer.status === "PENDING" &&
        !interviewer.slackUserId,
    );
    if (missingSlackMappings.length > 0) {
      throw new Error(
        `Slack user mapping is missing for: ${missingSlackMappings.map((item) => item.displayName).join(", ")}`,
      );
    }
    const payload = buildAvailabilityRecoveryMessage(bundle, {
      startedAt,
      detectedAt,
    }, this.db.getCaseInterviewPlan(review.caseId));
    const draft = this.db.createDraft({
      caseId: review.caseId,
      workflowReviewId: review.id,
      channelId: this.config.slack.requestChannelId,
      previewText: payload.text,
      blocksJson: JSON.stringify(payload.blocks),
      payloadHash: hashPayload(payload.text, payload.blocks),
      messageType: "AVAILABILITY_RECOVERY",
    });
    this.db.addEvent(review.caseId, "AVAILABILITY_RECOVERY_DRAFT_CREATED", "USER", {
      reviewId: review.id,
      draftId: draft.id,
    });
    return draft;
  }

  reprocessScheduleConfirmationNotifications(): {
    scanned: number;
    confirmed: number;
    reviewRequired: number;
  } {
    const notifications = this.db.listIgnoredScheduleConfirmationNotifications();
    let confirmed = 0;
    let reviewRequired = 0;
    for (const notification of notifications) {
      let text = "";
      try {
        const payload = JSON.parse(notification.payloadJson) as { text?: unknown };
        text = typeof payload.text === "string" ? payload.text : "";
      } catch {
        text = "";
      }
      const schedule = parseConfirmedScheduleDateTime(text);
      this.db.updateNotificationEventType(notification.id, "SCHEDULE_CONFIRMED");
      const processed = this.processScheduleConfirmation(notification.id, {
        eventType: "SCHEDULE_CONFIRMED",
        title: "일정이 확정되었습니다",
        text,
        links: [],
        payloadHash: "",
        payloadJson: notification.payloadJson,
        ...(notification.candidateRef
          ? { candidateRef: notification.candidateRef }
          : {}),
        ...(notification.candidateName
          ? { candidateName: notification.candidateName }
          : {}),
        ...(notification.recruitmentRef
          ? { recruitmentRef: notification.recruitmentRef }
          : {}),
        ...(notification.recruitmentName
          ? { recruitmentName: notification.recruitmentName }
          : {}),
        ...(schedule
          ? {
              scheduledDate: schedule.date,
              scheduledStartTime: schedule.startTime,
              scheduledEndTime: schedule.endTime,
            }
          : {}),
      });
      if (processed.result === "INTERVIEW_CONFIRMED") confirmed += 1;
      if (processed.result === "REVIEW_REQUIRED") reviewRequired += 1;
    }
    return { scanned: notifications.length, confirmed, reviewRequired };
  }

  reprocessCandidateInterviewAbsenceNotifications(): {
    scanned: number;
    reviewRequired: number;
  } {
    const notifications = this.db.listIgnoredCandidateInterviewAbsenceNotifications();
    let reviewRequired = 0;
    for (const notification of notifications) {
      let text = "";
      try {
        const payload = JSON.parse(notification.payloadJson) as { text?: unknown };
        text = typeof payload.text === "string" ? payload.text : "";
      } catch {
        text = "";
      }
      if (!isCandidateInterviewAbsenceText(text)) continue;
      this.db.updateNotificationEventType(
        notification.id,
        "CANDIDATE_INTERVIEW_ABSENCE",
      );
      const processed = this.processCandidateInterviewAbsence(notification.id, {
        eventType: "CANDIDATE_INTERVIEW_ABSENCE",
        title: "지원자 인터뷰 불참 메시지",
        text,
        links: [],
        payloadHash: "",
        payloadJson: notification.payloadJson,
        ...(notification.candidateRef
          ? { candidateRef: notification.candidateRef }
          : {}),
        ...(notification.candidateName
          ? { candidateName: notification.candidateName }
          : {}),
        ...(notification.recruitmentRef
          ? { recruitmentRef: notification.recruitmentRef }
          : {}),
        ...(notification.recruitmentName
          ? { recruitmentName: notification.recruitmentName }
          : {}),
      });
      if (processed.result === "CANDIDATE_ATTENDANCE_REVIEW_REQUIRED") {
        reviewRequired += 1;
      }
    }
    return { scanned: notifications.length, reviewRequired };
  }

  private processScheduleConfirmation(
    notificationId: string,
    parsed: ParsedSlackNotification,
  ): { notificationId: string; result: string; caseId?: string } {
    if (
      !parsed.candidateName ||
      !parsed.recruitmentName ||
      !parsed.scheduledDate ||
      !parsed.scheduledStartTime ||
      !parsed.scheduledEndTime
    ) {
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      this.db.createReview({
        notificationId,
        reviewType: "SCHEDULE_CONFIRMATION_MATCH_REQUIRED",
        reason:
          "The confirmed-schedule notification is missing candidate, recruitment, or date/time information.",
      });
      return { notificationId, result: "REVIEW_REQUIRED" };
    }

    const matches = this.db.findAwaitingCandidateConfirmationCases(
      parsed.candidateName,
      parsed.recruitmentName,
    );
    if (matches.length !== 1) {
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      this.db.createReview({
        notificationId,
        reviewType: "SCHEDULE_CONFIRMATION_MATCH_REQUIRED",
        reason:
          "The confirmed-schedule notification did not match exactly one candidate-confirmation case.",
        summary: {
          candidateName: parsed.candidateName,
          recruitmentName: parsed.recruitmentName,
          matchedCaseCount: matches.length,
        },
      });
      return { notificationId, result: "REVIEW_REQUIRED" };
    }

    const interviewCase = matches[0]!;
    const isSameSchedule =
      interviewCase.scheduledDate === parsed.scheduledDate &&
      interviewCase.scheduledStartTime === parsed.scheduledStartTime &&
      interviewCase.scheduledEndTime === parsed.scheduledEndTime;
    if (!isSameSchedule) {
      this.db.transaction(() => {
        this.db.setCaseStatus(interviewCase.id, "REVIEW_REQUIRED");
        this.db.createReview({
          notificationId,
          caseId: interviewCase.id,
          reviewType: "SCHEDULE_CONFIRMATION_MISMATCH",
          reason:
            "The confirmed NineHire schedule differs from the internally scheduled date or time.",
          summary: {
            expected: {
              date: interviewCase.scheduledDate,
              startTime: interviewCase.scheduledStartTime,
              endTime: interviewCase.scheduledEndTime,
            },
            received: {
              date: parsed.scheduledDate,
              startTime: parsed.scheduledStartTime,
              endTime: parsed.scheduledEndTime,
              location: parsed.location ?? null,
            },
          },
        });
        this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      });
      return {
        notificationId,
        result: "REVIEW_REQUIRED",
        caseId: interviewCase.id,
      };
    }

    this.db.confirmCandidateSchedule({
      caseId: interviewCase.id,
      notificationId,
      sourceLocation: parsed.location,
    });
    this.db.updateNotificationStatus(notificationId, "PROCESSED");
    return {
      notificationId,
      result: "INTERVIEW_CONFIRMED",
      caseId: interviewCase.id,
    };
  }

  private processCandidateInterviewAbsence(
    notificationId: string,
    parsed: ParsedSlackNotification,
  ): { notificationId: string; result: string; caseId?: string } {
    if (!parsed.candidateName || !parsed.recruitmentName) {
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      this.db.createReview({
        notificationId,
        reviewType: "CANDIDATE_INTERVIEW_ABSENCE_MATCH_REQUIRED",
        reason:
          "The candidate interview-absence message is missing candidate or recruitment information.",
      });
      return { notificationId, result: "REVIEW_REQUIRED" };
    }

    const matches = this.db.findScheduledCandidateCases(
      parsed.candidateName,
      parsed.recruitmentName,
    );
    if (matches.length !== 1) {
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      this.db.createReview({
        notificationId,
        reviewType: "CANDIDATE_INTERVIEW_ABSENCE_MATCH_REQUIRED",
        reason:
          "The candidate interview-absence message did not match exactly one scheduled interview case.",
        summary: {
          candidateName: parsed.candidateName,
          recruitmentName: parsed.recruitmentName,
          matchedCaseCount: matches.length,
        },
      });
      return { notificationId, result: "REVIEW_REQUIRED" };
    }

    const interviewCase = matches[0]!;
    this.db.transaction(() => {
      this.db.setCaseStatus(interviewCase.id, "REVIEW_REQUIRED");
      this.db.createReview({
        notificationId,
        caseId: interviewCase.id,
        reviewType: "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED",
        reason:
          "The candidate reported that they will not attend. Confirm whether the interview should be rescheduled, cancelled, or held.",
        summary: {
          candidateName: parsed.candidateName,
          recruitmentName: parsed.recruitmentName,
          scheduledDate: interviewCase.scheduledDate,
          scheduledStartTime: interviewCase.scheduledStartTime,
          scheduledEndTime: interviewCase.scheduledEndTime,
        },
      });
      this.db.addEvent(
        interviewCase.id,
        "CANDIDATE_INTERVIEW_ABSENCE_REPORTED",
        "NINEHIRE_SLACK",
        { notificationId },
      );
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
    });
    return {
      notificationId,
      result: "CANDIDATE_ATTENDANCE_REVIEW_REQUIRED",
      caseId: interviewCase.id,
    };
  }

  async approveInterviewArrangement(
    reviewId: string,
  ): Promise<{
    notificationId: string;
    result: string;
    caseId: string;
    templateStatus:
      | "APPLIED"
      | "UNCONFIGURED"
      | "STALE"
      | "CURRENT_STEP_NOT_CONFIGURED";
  }> {
    const review = this.db.getReview(reviewId);
    if (
      !review ||
      review.status !== "OPEN" ||
      !review.notificationId ||
      review.reviewType !== "INTERVIEW_ARRANGEMENT_START_REQUIRED"
    ) {
      throw new Error(`Open interview-arrangement approval not found: ${reviewId}`);
    }
    const approval = evaluationApprovalPayload(review.summary);
    if (!approval) {
      throw new Error("Evaluation approval summary is missing or invalid.");
    }
    const interviewCase = this.db.createInterviewCase({
      notificationId: review.notificationId,
      candidateRef: approval.context.candidateRef,
      candidateName: approval.context.candidateName,
      recruitmentRef: approval.context.recruitmentRef,
      recruitmentName: approval.context.recruitmentName,
      proposalDates: proposalDates(todayInKorea()),
    });
    let template = approval.context.recruitmentRef
      ? this.db.getRecruitmentInterviewTemplate(approval.context.recruitmentRef)
      : undefined;
    let templateStatus: "UNCONFIGURED" | "STALE" | "CURRENT_STEP_NOT_CONFIGURED" =
      template ? "CURRENT_STEP_NOT_CONFIGURED" : "UNCONFIGURED";
    if (template && this.ninehire.getRecruitmentPipeline) {
      try {
        const pipeline = await this.ninehire.getRecruitmentPipeline(template.recruitmentId);
        if (pipelineHash(pipeline.steps) !== template.pipelineHash) {
          template = undefined;
          templateStatus = "STALE";
        }
      } catch {
        // 나인하이어 조회가 일시적으로 실패해도 이미 승인된 템플릿을 사용합니다.
      }
    }
    const currentStep = approval.evaluation.currentStep;
    const templateRoute = currentStep && template
      ? template.routes.find((route) => route.triggerStepId === currentStep.stepId)
      : undefined;
    const currentStepIsCoveredByRoute = Boolean(
      currentStep && template?.routes.some((route) => route.stepIds.includes(currentStep.stepId)),
    );
    const templateSteps = templateRoute && template
      ? templateRoute.stepIds.map((stepId) =>
          template.steps.find((step) => step.stepId === stepId),
        )
      : [];
    const templateStep = currentStep && template && !currentStepIsCoveredByRoute
      ? template.steps.find((step) => step.stepId === currentStep.stepId)
      : undefined;
    if (templateRoute && templateSteps.every((step) => step)) {
      const resolvedSteps = templateSteps as RecruitmentInterviewTemplateStep[];
      const mode = templateRoute.mode;
      const sessions = mode === "SEQUENTIAL"
        ? resolvedSteps.map((step) => ({
            stepId: step.stepId,
            stepName: step.name,
            interviewerIds: [],
          }))
        : [];
      this.db.upsertCaseInterviewPlan({
        caseId: interviewCase.id,
        source: "TEMPLATE",
        mode,
        stepIds: resolvedSteps.map((step) => step.stepId),
        stepNames: resolvedSteps.map((step) => step.name),
        sessions,
        durationMinutes: mode === "SEQUENTIAL"
          ? resolvedSteps.reduce((total, step) => total + step.durationMinutes, 0)
          : resolvedSteps[0]!.durationMinutes,
      });
      this.db.addEvent(interviewCase.id, "TEMPLATE_INTERVIEW_ROUTE_APPLIED", "SYSTEM", {
        triggerStepId: templateRoute.triggerStepId,
        mode,
        stepIds: templateRoute.stepIds,
      });
    } else if (templateStep) {
      this.db.upsertCaseInterviewPlan({
        caseId: interviewCase.id,
        source: "TEMPLATE",
        mode: templateStep.mode,
        stepIds: [templateStep.stepId],
        stepNames: [templateStep.name],
        durationMinutes: templateStep.durationMinutes,
      });
    }
    this.db.updateNotificationStatus(review.notificationId, "PROCESSED");
    this.db.resolveReview(reviewId, "INTERVIEW_ARRANGEMENT_STARTED");
    return {
      notificationId: review.notificationId,
      result: "INTERVIEW_CASE_CREATED",
      caseId: interviewCase.id,
      templateStatus: !template
        ? templateStatus
        : templateRoute || templateStep
          ? "APPLIED"
          : templateStatus,
    };
  }

  recordManualConfirmedInterview(input: {
    reviewId: string;
    date: string;
    startTime: string;
    endTime: string;
    roomName: string;
    note?: string;
  }): {
    case: InterviewCaseRow;
    schedule: ConfirmedInterviewScheduleRow;
  } {
    const review = this.db.getReview(input.reviewId);
    if (
      !review ||
      review.status !== "OPEN" ||
      !review.notificationId ||
      review.reviewType !== "INTERVIEW_ARRANGEMENT_START_REQUIRED"
    ) {
      throw new Error(`Open interview-arrangement approval not found: ${input.reviewId}`);
    }
    const approval = evaluationApprovalPayload(review.summary);
    if (!approval) {
      throw new Error("Evaluation approval summary is missing or invalid.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      throw new Error("A valid interview date is required.");
    }
    const durationMinutes = scheduleDurationMinutes(input.startTime, input.endTime);
    const roomName = input.roomName.trim();
    if (!roomName) {
      throw new Error("An interview room name is required.");
    }
    this.db.assertNoScheduledRoomConflict({
      date: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      roomName,
    });
    const interviewCase = this.db.createInterviewCase({
      notificationId: review.notificationId,
      candidateRef: approval.context.candidateRef,
      candidateName: approval.context.candidateName,
      recruitmentRef: approval.context.recruitmentRef,
      recruitmentName: approval.context.recruitmentName,
      durationMinutes,
      proposalDates: [input.date],
    });
    const schedule = this.db.recordManualConfirmedSchedule({
      caseId: interviewCase.id,
      date: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      roomName,
      note: input.note,
    });
    this.db.updateNotificationStatus(review.notificationId, "PROCESSED");
    this.db.resolveReview(review.id, "MANUAL_INTERVIEW_CONFIRMED");
    return {
      case: this.db.getCase(interviewCase.id)!,
      schedule,
    };
  }

  async syncCaseInterviewers(caseId: string): Promise<{
    addedOrUpdated: number;
    deactivated: number;
    missingSlackMappings: string[];
    unresolvedUserGroups: string[];
  }> {
    const interviewCase = this.db.getCase(caseId);
    if (!interviewCase) throw new Error(`Case not found: ${caseId}`);
    const context: CandidateContext = {
      candidateRef: interviewCase.candidateRef ?? undefined,
      candidateName: interviewCase.candidateName ?? undefined,
      recruitmentRef: interviewCase.recruitmentRef ?? undefined,
      recruitmentName: interviewCase.recruitmentName ?? undefined,
    };
    const upstream = await this.ninehire.listInterviewers(context);
    if (
      upstream.unresolvedUserGroups.length > 0 &&
      !this.db.hasCaseReview(
        caseId,
        "INTERVIEWER_GROUP_MEMBERS_REQUIRED",
      )
    ) {
      this.db.createReview({
        caseId,
        reviewType: "INTERVIEWER_GROUP_MEMBERS_REQUIRED",
        reason:
          `나인하이어 사용자 그룹(${upstream.unresolvedUserGroups.join(", ")})은 구성원을 반환하지 않습니다. ` +
          "필요한 면접관을 개별로 추가하거나, 이 건에서 제외할지 검토하세요.",
      });
    }
    if (upstream.interviewers.length === 0) {
      this.db.createReview({
        caseId,
        reviewType: "INTERVIEWER_LOOKUP_REQUIRED",
        reason:
          "나인하이어 채용 참여자에서 개별 사용자를 찾지 못했습니다. 면접관을 건별로 직접 추가하세요.",
      });
      return {
        addedOrUpdated: 0,
        deactivated: 0,
        missingSlackMappings: [],
        unresolvedUserGroups: upstream.unresolvedUserGroups,
      };
    }

    const missingSlackMappings: string[] = [];
    for (const person of upstream.interviewers) {
      const cached = this.db.findIdentityByNinehireId(person.ninehireUserId);
      let slackUserId =
        cached?.slack_user_id === undefined
          ? undefined
          : String(cached.slack_user_id);
      if (!slackUserId && person.email && this.identityResolver) {
        slackUserId = await this.identityResolver.lookupUserIdByEmail(
          person.email,
        );
        if (slackUserId) {
          this.db.upsertIdentityMapping({
            ninehireUserId: person.ninehireUserId,
            slackUserId,
            displayName: person.displayName,
            email: person.email,
          });
        }
      }
      if (!slackUserId) missingSlackMappings.push(person.displayName);
      this.db.addOrUpdateInterviewer({
        caseId,
        ninehireUserId: person.ninehireUserId,
        slackUserId,
        displayName: person.displayName,
        email: person.email,
        required: person.required,
        source: "NINEHIRE",
      });
    }
    const deactivated = this.db.deactivateMissingNinehireInterviewers(
      caseId,
      upstream.interviewers.map((person) => person.ninehireUserId),
    );
    const plan = this.db.getCaseInterviewPlan(caseId);
    if (plan?.source === "CANDIDATE_OVERRIDE") {
      this.db.setRequiredInterviewers(caseId, plan.interviewerIds);
    }
    return {
      addedOrUpdated: upstream.interviewers.length,
      deactivated,
      missingSlackMappings,
      unresolvedUserGroups: upstream.unresolvedUserGroups,
    };
  }

  async createRequestDraft(caseId: string): Promise<DraftRow> {
    if (!this.config.slack.requestChannelId) {
      throw new Error("SLACK_REQUEST_CHANNEL_ID is not configured.");
    }
    await this.syncCaseInterviewers(caseId);
    const bundle = this.db.getCaseBundle(caseId);
    if (!bundle) throw new Error(`Case not found: ${caseId}`);
    const plan = this.db.getCaseInterviewPlan(caseId);
    if (
      plan?.mode === "SEQUENTIAL" &&
      plan.sessions.some((session) => session.interviewerIds.length === 0)
    ) {
      throw new Error(
        "Assign the actual interviewer for every sequential stage before creating a Slack request draft.",
      );
    }
    const missing = bundle.interviewers.filter(
      (person) => person.active && person.required && !person.slackUserId,
    );
    if (missing.length > 0) {
      throw new Error(
        `Slack user mapping is missing for: ${missing.map((item) => item.displayName).join(", ")}`,
      );
    }
    const payload = buildRequestMessage(bundle, { plan });
    return this.db.createDraft({
      caseId,
      channelId: this.config.slack.requestChannelId,
      previewText: payload.text,
      blocksJson: JSON.stringify(payload.blocks),
      payloadHash: hashPayload(payload.text, payload.blocks),
      messageType: "INTERVIEWER_REQUEST",
    });
  }

  confirmInternalSchedule(caseId: string) {
    return this.db.confirmInternalSchedule(caseId);
  }

  reopenInterviewSchedule(input: {
    caseId: string;
    availabilityPolicy: RescheduleAvailabilityPolicy;
    reason: string;
  }): ScheduleTransitionResult & { scheduleUpdateDraft: DraftRow | null } {
    if (!this.config.slack.requestChannelId) {
      throw new Error("SLACK_REQUEST_CHANNEL_ID is not configured.");
    }
    const transition = this.db.reopenScheduleForReschedule(input);
    const bundle = this.db.getCaseBundle(input.caseId);
    if (!bundle) throw new Error(`Case not found: ${input.caseId}`);
    const scheduleUpdateDraft = transition.hadSentScheduleConfirmation
      ? this.createScheduleUpdateDraft(
          bundle,
          transition.previousSchedule!,
          "SCHEDULE_CHANGE",
        )
      : null;
    return { ...transition, scheduleUpdateDraft };
  }

  cancelInterviewArrangement(input: {
    caseId: string;
    reason: string;
  }): ScheduleTransitionResult & {
    scheduleUpdateDraft: DraftRow | null;
    cancellationExternalFollowUps: ReturnType<
      BridgeDatabase["createCancellationExternalFollowUps"]
    >;
  } {
    if (!this.config.slack.requestChannelId) {
      throw new Error("SLACK_REQUEST_CHANNEL_ID is not configured.");
    }
    const transition = this.db.cancelInterviewArrangement(input);
    const bundle = this.db.getCaseBundle(input.caseId);
    if (!bundle) throw new Error(`Case not found: ${input.caseId}`);
    const scheduleUpdateDraft =
      transition.hadSentScheduleConfirmation && transition.previousSchedule
        ? this.createScheduleUpdateDraft(
            bundle,
            transition.previousSchedule,
            "SCHEDULE_CANCELLATION",
          )
        : null;
    const cancellationExternalFollowUps =
      this.db.createCancellationExternalFollowUps(input.caseId);
    return { ...transition, scheduleUpdateDraft, cancellationExternalFollowUps };
  }

  resolveCandidateInterviewAbsenceReview(input: {
    reviewId: string;
    action:
      | "RESCHEDULE_USING_EXISTING_AVAILABILITY"
      | "RESCHEDULE_WITH_NEW_AVAILABILITY"
      | "CANCEL"
      | "HOLD";
    note?: string;
  }) {
    const review = this.db.getReview(input.reviewId);
    if (
      !review ||
      review.status !== "OPEN" ||
      !review.caseId ||
      review.reviewType !== "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED"
    ) {
      throw new Error(`Open candidate-attendance review not found: ${input.reviewId}`);
    }

    const reason = input.note?.trim() || "Candidate reported interview absence.";
    if (input.action === "HOLD") {
      this.db.addEvent(
        review.caseId,
        "CANDIDATE_INTERVIEW_ABSENCE_HELD",
        "USER",
        { reviewId: review.id, note: input.note?.trim() || null },
      );
      return {
        action: input.action,
        reviewId: review.id,
        caseId: review.caseId,
        reviewOpen: true,
      };
    }

    const outcome =
      input.action === "CANCEL"
        ? this.cancelInterviewArrangement({ caseId: review.caseId, reason })
        : this.reopenInterviewSchedule({
            caseId: review.caseId,
            availabilityPolicy:
              input.action === "RESCHEDULE_USING_EXISTING_AVAILABILITY"
                ? "REUSE"
                : "RECOLLECT",
            reason,
          });
    this.db.resolveReview(review.id, input.action);
    return {
      action: input.action,
      reviewId: review.id,
      caseId: review.caseId,
      reviewOpen: false,
      outcome,
    };
  }

  createScheduleConfirmationDraft(caseId: string): DraftRow {
    if (!this.config.slack.requestChannelId) {
      throw new Error("SLACK_REQUEST_CHANNEL_ID is not configured.");
    }
    const bundle = this.db.getCaseBundle(caseId);
    if (!bundle) throw new Error(`Case not found: ${caseId}`);
    if (
      ![
        "AWAITING_CANDIDATE_CONFIRMATION",
        "CONFIRMED",
      ].includes(bundle.interviewCase.status)
    ) {
      throw new Error(
        "Confirm the internal schedule before creating a schedule confirmation draft.",
      );
    }
    const payload = this.buildScheduleConfirmationPayload(caseId, bundle);
    return this.db.createDraft({
      caseId,
      channelId: this.config.slack.requestChannelId,
      previewText: payload.text,
      blocksJson: JSON.stringify(payload.blocks),
      payloadHash: hashPayload(payload.text, payload.blocks),
      messageType: "SCHEDULE_CONFIRMATION",
    });
  }

  replacePendingDraftText(input: {
    draftId: string;
    textToReplace: string;
    replacementText: string;
  }): DraftRow {
    const draft = this.db.getDraft(input.draftId);
    if (!draft || draft.status !== "DRAFT") {
      throw new Error(`Draft is not editable: ${input.draftId}`);
    }
    let blocks: unknown;
    try {
      blocks = JSON.parse(draft.blocksJson) as unknown;
    } catch {
      throw new Error(`Draft blocks are invalid: ${input.draftId}`);
    }
    const replaced = replaceExactText(
      blocks,
      input.textToReplace,
      input.replacementText,
    );
    if (replaced !== 1) {
      throw new Error(
        `Expected one matching draft text, but found ${replaced}: ${input.draftId}`,
      );
    }
    return this.db.replacePendingDraftText({
      draftId: draft.id,
      blocksJson: JSON.stringify(blocks),
      payloadHash: hashPayload(draft.previewText, blocks),
    });
  }

  async approveAndSendInterviewerRequest(
    draftId: string,
    client: WebClient,
  ): Promise<DraftRow> {
    return this.approveAndSendDraft(draftId, "INTERVIEWER_REQUEST", client);
  }

  async approveAndSendAvailabilityRecovery(
    draftId: string,
    client: WebClient,
  ): Promise<DraftRow> {
    return this.approveAndSendDraft(draftId, "AVAILABILITY_RECOVERY", client);
  }

  async approveAndSendScheduleConfirmation(
    draftId: string,
    client: WebClient,
  ): Promise<DraftRow> {
    return this.approveAndSendDraft(draftId, "SCHEDULE_CONFIRMATION", client);
  }

  async approveAndSendScheduleUpdate(
    draftId: string,
    client: WebClient,
  ): Promise<DraftRow> {
    const draft = this.db.getDraft(draftId);
    if (
      !draft ||
      !["SCHEDULE_CHANGE", "SCHEDULE_CANCELLATION"].includes(
        draft.messageType,
      )
    ) {
      throw new Error("This draft is not a schedule change or cancellation draft.");
    }
    return this.approveAndSendDraft(draftId, draft.messageType, client);
  }

  private async approveAndSendDraft(
    draftId: string,
    messageType: DraftRow["messageType"],
    client: WebClient,
  ): Promise<DraftRow> {
    const existing = this.db.getDraft(draftId);
    if (!existing) throw new Error(`Draft not found: ${draftId}`);
    if (existing.messageType !== messageType) {
      throw new Error(`This draft is not a ${messageType} draft.`);
    }
    if (existing.status === "SENT") return existing;

    if (messageType === "INTERVIEWER_REQUEST") {
      await this.syncCaseInterviewers(existing.caseId);
    }
    const currentBundle = this.db.getCaseBundle(existing.caseId);
    if (!currentBundle) throw new Error(`Case not found: ${existing.caseId}`);
    const current =
      messageType === "INTERVIEWER_REQUEST"
        ? buildRequestMessage(currentBundle, {
            plan: this.db.getCaseInterviewPlan(existing.caseId),
          })
        : messageType === "SCHEDULE_CONFIRMATION"
          ? this.buildScheduleConfirmationPayload(existing.caseId, currentBundle)
          : {
              text: existing.previewText,
              blocks: JSON.parse(existing.blocksJson) as unknown,
            };
    const currentHash = hashPayload(current.text, current.blocks);
    if (currentHash !== existing.payloadHash) {
      this.db.cancelDraft(
        existing.id,
        "Case/interviewer data changed after the draft was created.",
      );
      throw new Error(
        "The case or interviewer list changed. The old draft was cancelled; create and approve a new draft.",
      );
    }

    const approved = this.db.approveDraft(draftId);
    const previouslySentTs = await this.findSlackMessageForDraft(
      approved,
      client,
      slackMetadataEventType(messageType),
    );
    if (previouslySentTs) {
      return this.db.markDraftSent(approved.id, previouslySentTs);
    }
    const response = await client.chat.postMessage({
      channel: approved.channelId,
      text: approved.previewText,
      blocks: JSON.parse(approved.blocksJson) as never,
      metadata: {
        event_type: slackMetadataEventType(messageType),
        event_payload: { draft_id: approved.id },
      },
    });
    if (!response.ts) {
      throw new Error("Slack accepted the request but did not return a message ts.");
    }
    return this.db.markDraftSent(approved.id, response.ts);
  }

  private createScheduleUpdateDraft(
    bundle: CaseBundle,
    schedule: ConfirmedInterviewScheduleRow,
    messageType: "SCHEDULE_CHANGE" | "SCHEDULE_CANCELLATION",
  ): DraftRow {
    const payload = buildScheduleUpdateMessage(
      bundle,
      schedule,
      messageType === "SCHEDULE_CANCELLATION" ? "CANCELLATION" : "CHANGE",
    );
    return this.db.createDraft({
      caseId: bundle.interviewCase.id,
      channelId: this.config.slack.requestChannelId!,
      previewText: payload.text,
      blocksJson: JSON.stringify(payload.blocks),
      payloadHash: hashPayload(payload.text, payload.blocks),
      messageType,
    });
  }

  private buildScheduleConfirmationPayload(caseId: string, bundle: CaseBundle) {
    const schedule = this.db.getConfirmedInterviewSchedule(caseId);
    if (!schedule) throw new Error("The confirmed schedule record is missing.");
    return buildScheduleConfirmationMessage(bundle, schedule, {
      sequentialSessions: this.getSequentialScheduleMessageSessions(caseId),
    });
  }

  private getSequentialScheduleMessageSessions(
    caseId: string,
  ): SequentialInterviewScheduleMessageSession[] | undefined {
    const plan = this.db.getCaseInterviewPlan(caseId);
    if (plan?.mode !== "SEQUENTIAL") return undefined;

    const blocksById = new Map(
      this.db
        .listMeetingRoomBlocks(undefined, false)
        .map((block) => [block.id, block]),
    );
    const sessionsByStepId = new Map(
      plan.sessions.map((session) => [session.stepId, session]),
    );
    const allocations = this.db
      .listRoomAllocations(caseId)
      .filter((allocation) => allocation.status === "ACTIVE")
      .sort((left, right) => left.sequenceIndex - right.sequenceIndex);
    if (allocations.length !== plan.sessions.length) {
      throw new Error("The sequential interview room allocations are incomplete.");
    }

    return allocations.map((allocation) => {
      const session = allocation.interviewStepId
        ? sessionsByStepId.get(allocation.interviewStepId)
        : undefined;
      const room = blocksById.get(allocation.roomBlockId);
      if (!session || !room) {
        throw new Error("The sequential interview stage schedule is incomplete.");
      }
      return {
        stepId: session.stepId,
        stepName: session.stepName,
        interviewerIds: session.interviewerIds,
        startTime: allocation.startTime,
        endTime: allocation.endTime,
        roomName: room.roomName,
      };
    });
  }

  private async findSlackMessageForDraft(
    draft: DraftRow,
    client: WebClient,
    eventType: string,
  ): Promise<string | undefined> {
    let cursor: string | undefined;
    const oldest = String(new Date(draft.createdAt).getTime() / 1_000);
    for (let page = 0; page < 10; page += 1) {
      const response = await client.conversations.history({
        channel: draft.channelId,
        oldest,
        inclusive: true,
        include_all_metadata: true,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const found = response.messages?.find((message) => {
        const metadata = message.metadata;
        const eventPayload = metadata?.event_payload as
          | Record<string, unknown>
          | undefined;
        return (
          metadata?.event_type === eventType &&
          eventPayload?.draft_id === draft.id
        );
      });
      if (found?.ts) return found.ts;
      cursor = response.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return undefined;
  }

  getCaseOrThrow(caseId: string): InterviewCaseRow {
    const interviewCase = this.db.getCase(caseId);
    if (!interviewCase) throw new Error(`Case not found: ${caseId}`);
    return interviewCase;
  }
}
