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
  type IntegrationRetryRequeueResult,
  type InterviewPlanMode,
  type RecruitmentInterviewRoute,
  type RecruitmentInterviewTemplateStep,
  type ScheduleTransitionResult,
  type WorkerDowntime,
} from "../db/database.js";
import { nextProposalWeekDates, proposalDates } from "../domain/calendar.js";
import type {
  CandidateContext,
  EvaluationSummary,
  NinehireCandidateSchedule,
  RescheduleAvailabilityPolicy,
  ScoreSheetSummary,
  SlackNotificationInput,
} from "../domain/types.js";
import type { DaouOfficeCalendarAdapter } from "../domain/daou-office.js";
import type { DaouInterviewCalendarEvent } from "../domain/daou-calendar.js";
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

function suggestedInterviewDuration(step: { title: string; name: string }): number {
  const normalized = `${step.title} ${step.name}`.replace(/\s/gu, "").toLowerCase();
  return normalized.includes("시강") ? 30 : 60;
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
  if (messageType === "AVAILABILITY_REMINDER") {
    return "interview_bridge_availability_reminder";
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

  const normalized = decisions.map((title) => title.replace(/\s/gu, ""));
  const isAmbiguous = (title: string) =>
    /(판단|어렵|여부|미정|검토|확인|추가|불확실)/u.test(title);
  const isPass = (title: string) =>
    title.includes("합격") && !title.includes("불합격") && !title.includes("보류") && !isAmbiguous(title);
  const isReject = (title: string) =>
    title.includes("불합격") && !title.includes("보류") && !isAmbiguous(title);
  const isHold = (title: string) => title.includes("보류") && !isAmbiguous(title);
  const hasPass = normalized.some(isPass);
  if (hasPass) return "ELIGIBLE";

  const hasOnlyRejectOrHold = normalized.every((title) => isReject(title) || isHold(title));
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

  private requestChannelIdForCase(caseId: string): string {
    const mappedChannelId = this.db.getRequestChannelForCase(caseId);
    if (mappedChannelId) return mappedChannelId;
    if (this.config.slack.requestChannelId) return this.config.slack.requestChannelId;
    throw new Error(
      "No Slack request channel is configured for this recruitment or as a default.",
    );
  }

  private isRecruitmentInManagedScope(input: {
    recruitmentId?: string;
    recruitmentName?: string;
  }): boolean {
    const configuredChannels = this.db.listRecruitmentSlackChannels();
    if (configuredChannels.length === 0) return true;
    return configuredChannels.some(
      (channel) =>
        channel.recruitmentId === input.recruitmentId ||
        channel.recruitmentName === input.recruitmentName,
    );
  }

  private findOpenInterviewArrangementReview(context: CandidateContext) {
    return this.db.listOpenReviews(1_000).find((review) => {
      if (review.reviewType !== "INTERVIEW_ARRANGEMENT_START_REQUIRED") return false;
      const approval = evaluationApprovalPayload(review.summary);
      if (!approval) return false;
      if (context.candidateRef && approval.context.candidateRef) {
        return context.candidateRef === approval.context.candidateRef;
      }
      return (
        context.candidateName === approval.context.candidateName &&
        context.recruitmentName === approval.context.recruitmentName
      );
    });
  }

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
            durationMinutes: suggestedInterviewDuration(step),
          })),
      ),
      steps: pipeline.steps.map((step) => ({
        ...step,
        suggestedAsInterview: isSuggestedInterviewStep(step),
        suggestedMode: isSuggestedInterviewStep(step)
          ? suggestedInterviewMode(step)
          : null,
        defaultDurationMinutes: suggestedInterviewDuration(step),
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
          durationMinutes: selection.durationMinutes ?? suggestedInterviewDuration(step),
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
      if (step.durationMinutes !== 60) {
        throw new Error("A 30-minute interview stage cannot be included in a sequential interview.");
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
      const existing = this.db.getNotification(stored.id);
      const processingStatus = String(existing?.processing_status ?? "");
      const terminalStatuses = new Set([
        "PROCESSED",
        "IGNORED",
        "NOT_ELIGIBLE",
        "REVIEW_REQUIRED",
        "AWAITING_START_APPROVAL",
        "ERROR",
      ]);
      if (terminalStatuses.has(processingStatus)) {
        return { notificationId: stored.id, result: "DUPLICATE" };
      }
      try {
        if (input.parsed.eventType === "SCHEDULE_CONFIRMED") {
          return this.processScheduleConfirmation(stored.id, input.parsed);
        }
        if (input.parsed.eventType === "CANDIDATE_INTERVIEW_ABSENCE") {
          return this.processCandidateInterviewAbsence(stored.id, input.parsed);
        }
        if (input.parsed.eventType === "EVALUATION_COMPLETED") {
          return await this.processEvaluationLookup(stored.id, input.parsed);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.updateNotificationStatus(stored.id, "RETRY_PENDING", message);
        throw error;
      }
      return { notificationId: stored.id, result: "DUPLICATE_PENDING" };
    }
    if (input.parsed.eventType !== "EVALUATION_COMPLETED") {
      if (input.parsed.eventType === "SCHEDULE_CONFIRMED") {
        try {
          return this.processScheduleConfirmation(stored.id, input.parsed);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.db.updateNotificationStatus(stored.id, "RETRY_PENDING", message);
          throw error;
        }
      }
      if (input.parsed.eventType === "CANDIDATE_INTERVIEW_ABSENCE") {
        try {
          return this.processCandidateInterviewAbsence(stored.id, input.parsed);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.db.updateNotificationStatus(stored.id, "RETRY_PENDING", message);
          throw error;
        }
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

  async reconcileReceiptEvaluationCompletions(): Promise<{
    scanned: number;
    queuedForApproval: number;
    excluded: number;
    reviewRequired: number;
    skipped: number;
  }> {
    if (!this.ninehire.listReceiptCandidatesWithCompletedScoreSheets) {
      return {
        scanned: 0,
        queuedForApproval: 0,
        excluded: 0,
        reviewRequired: 0,
        skipped: 0,
      };
    }

    const recruitments = this.db.listRecruitmentSlackChannels().map((channel) => ({
      recruitmentId: channel.recruitmentId,
      recruitmentName: channel.recruitmentName,
    }));
    if (recruitments.length === 0) {
      return {
        scanned: 0,
        queuedForApproval: 0,
        excluded: 0,
        reviewRequired: 0,
        skipped: 0,
      };
    }

    const candidates = await this.ninehire.listReceiptCandidatesWithCompletedScoreSheets({
      recruitments,
    });
    const summary = {
      scanned: candidates.length,
      queuedForApproval: 0,
      excluded: 0,
      reviewRequired: 0,
      skipped: 0,
    };

    for (const candidate of candidates) {
      if (!candidate.candidateRef || !candidate.candidateName || !candidate.recruitmentRef || !candidate.recruitmentName) {
        summary.skipped += 1;
        continue;
      }
      const reconciliation = await this.ingestSlackNotification({
        channelId: "NINEHIRE_DIRECT_RECONCILIATION",
        messageTs: `receipt-evaluation:${candidate.candidateRef}`,
        parsed: {
          eventType: "EVALUATION_COMPLETED",
          title: "나인하이어 서류 평가 완료 확인",
          text: "나인하이어 직접 조회에서 서류 평가 완료를 확인했습니다.",
          links: [],
          payloadHash: `receipt-evaluation:${candidate.candidateRef}`,
          payloadJson: JSON.stringify({
            source: "NINEHIRE_DIRECT_RECONCILIATION",
            candidateRef: candidate.candidateRef,
            recruitmentRef: candidate.recruitmentRef,
          }),
          ...candidate,
        },
      });

      if (reconciliation.result === "EVALUATION_READY_FOR_APPROVAL") {
        summary.queuedForApproval += 1;
      } else if (
        reconciliation.result === "EVALUATION_NOT_ELIGIBLE" ||
        reconciliation.result === "EVALUATION_IGNORED_FINALIZED_CANDIDATE"
      ) {
        summary.excluded += 1;
      } else if (reconciliation.result === "DUPLICATE") {
        summary.skipped += 1;
      } else {
        summary.reviewRequired += 1;
      }
    }

    return summary;
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
    if (job.jobType !== "NINEHIRE_EVALUATION_LOOKUP") {
      const existing = this.db.listOpenReviews(1_000).find(
        (review) =>
          review.reviewType === "INTEGRATION_RETRY_EXHAUSTED" &&
          review.summary?.jobId === job.id,
      );
      if (existing) return;
      this.db.createReview({
        reviewType: "INTEGRATION_RETRY_EXHAUSTED",
        reason: job.lastError ?? "Integration retry attempts were exhausted.",
        summary: {
          jobId: job.id,
          jobType: job.jobType,
          dedupeKey: job.dedupeKey,
          attemptCount: job.attemptCount,
        },
      });
      return;
    }
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

  requeueIntegrationRetryJob(jobId: string): IntegrationRetryRequeueResult {
    const result = this.db.requeueIntegrationRetryJob(jobId);
    if (result.queued) {
      const review = this.db.listOpenReviews(1_000).find(
        (item) =>
          item.reviewType === "INTEGRATION_RETRY_EXHAUSTED" &&
          item.summary?.jobId === jobId,
      );
      if (review) this.db.resolveReview(review.id, "MANUAL_RETRY_REQUESTED");
    }
    return result;
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
    if (!this.isRecruitmentInManagedScope({
      recruitmentId: evaluation.summary.recruitmentId,
      recruitmentName: evaluation.context.recruitmentName,
    })) {
      this.db.updateNotificationStatus(notificationId, "IGNORED_OUT_OF_SCOPE");
      return { notificationId, result: "EVALUATION_IGNORED_OUT_OF_SCOPE" };
    }
    if (["passed", "failed"].includes(evaluation.summary.currentStatus ?? "")) {
      this.db.updateNotificationStatus(notificationId, "NOT_ELIGIBLE");
      return { notificationId, result: "EVALUATION_IGNORED_FINALIZED_CANDIDATE" };
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

    const existingReview = this.findOpenInterviewArrangementReview(evaluation.context);
    if (existingReview) {
      const previous = evaluationApprovalPayload(existingReview.summary);
      const refreshedSummary = evaluation.summary;
      this.db.transaction(() => {
        this.db.updateOpenReviewSummary(existingReview.id, {
          ...(existingReview.summary ?? {}),
          context: evaluation.context,
          evaluation: refreshedSummary,
        });
        if (previous?.evaluation.currentStep?.stepId !== refreshedSummary.currentStep?.stepId) {
          this.db.discardPendingInterviewSkillDecisionsForReview(existingReview.id);
        }
        this.db.updateNotificationStatus(notificationId, "PROCESSED");
      });
      return { notificationId, result: "EVALUATION_MERGED_INTO_EXISTING_REVIEW" };
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

  async refreshOpenInterviewArrangementReviewStages(): Promise<{
    scanned: number;
    updated: number;
    unchanged: number;
    unavailable: number;
    discardedPendingDecisions: number;
  }> {
    const reviews = this.db
      .listOpenReviews(1_000)
      .filter((review) => review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED");
    const result = {
      scanned: reviews.length,
      updated: 0,
      unchanged: 0,
      unavailable: 0,
      discardedPendingDecisions: 0,
    };

    for (const review of reviews) {
      const approval = evaluationApprovalPayload(review.summary);
      if (!approval?.context.candidateName || !approval.context.recruitmentName) {
        result.unavailable += 1;
        continue;
      }
      const refreshed = await this.ninehire.lookupCompletedEvaluation(approval.context);
      if (!refreshed.context || !refreshed.summary) {
        result.unavailable += 1;
        continue;
      }
      const summary = {
        ...(review.summary ?? {}),
        context: refreshed.context,
        evaluation: refreshed.summary,
      };
      if (JSON.stringify(review.summary) === JSON.stringify(summary)) {
        result.unchanged += 1;
        continue;
      }
      const previousStepId = approval.evaluation.currentStep?.stepId;
      const currentStepId = refreshed.summary.currentStep?.stepId;
      this.db.transaction(() => {
        this.db.updateOpenReviewSummary(review.id, summary);
        if (previousStepId !== currentStepId) {
          result.discardedPendingDecisions +=
            this.db.discardPendingInterviewSkillDecisionsForReview(review.id);
        }
      });
      result.updated += 1;
    }
    return result;
  }

  async syncCandidateCurrentInterviewStage(
    context: CandidateContext,
  ): Promise<{ notificationId: string; result: string }> {
    if (!context.candidateName || !context.recruitmentName) {
      throw new Error("Candidate name and recruitment name are required.");
    }
    const candidateKey = context.candidateRef ?? `${context.recruitmentName}:${context.candidateName}`;
    return this.ingestSlackNotification({
      channelId: "NINEHIRE_CURRENT_STAGE_RECONCILIATION",
      messageTs: `current-stage:${candidateKey}`,
      parsed: {
        eventType: "EVALUATION_COMPLETED",
        title: "나인하이어 현재 인터뷰 단계 확인",
        text: "나인하이어의 현재 칸반 단계와 완료된 평가표를 확인했습니다.",
        links: [],
        payloadHash: `current-stage:${candidateKey}`,
        payloadJson: JSON.stringify({ source: "NINEHIRE_CURRENT_STAGE_RECONCILIATION" }),
        ...context,
      },
    });
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
        const reviewType = "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED";
        const existingReviewId = this.db.getOpenCaseReviewId(
          interviewCase.id,
          reviewType,
        );
        const reviewId =
          existingReviewId ??
          this.db.createReview({
            caseId: interviewCase.id,
            reviewType,
            reason:
              "Slack 워커 중단 구간에 면접관 가용시간 제출이 누락됐을 수 있습니다. 재제출 요청 초안을 만들거나 직접 확인하세요.",
            summary: {
              workerKey: downtime.workerKey,
              downtimeStartedAt: downtime.startedAt,
              downtimeDetectedAt: downtime.detectedAt,
              downtimeDurationMs: downtime.durationMs,
            },
          });
        if (!existingReviewId) {
          this.db.addEvent(
            interviewCase.id,
            "WORKER_DOWNTIME_AVAILABILITY_REVIEW_CREATED",
            "SYSTEM",
            { reviewId, ...downtime },
          );
        }
        reviewIds.push(reviewId);
      }
    });
    return {
      downtime,
      impactedCaseIds: impactedCases.map((interviewCase) => interviewCase.id),
      reviewIds,
    };
  }

  resolveWorkerDowntimeAvailabilityReviewsAfterSuccessfulReconciliation(): {
    caseIds: string[];
    reviewIds: string[];
  } {
    const reviews = this.db
      .listOpenReviews()
      .filter((review) => review.reviewType === "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED" && review.caseId);
    const caseIds: string[] = [];
    const reviewIds: string[] = [];
    this.db.transaction(() => {
      for (const review of reviews) {
        this.db.resolveReview(review.id, "AUTO_RESOLVED_AFTER_SUCCESSFUL_RECONCILIATION");
        this.db.addEvent(review.caseId!, "WORKER_DOWNTIME_AVAILABILITY_AUTO_RESOLVED", "SYSTEM", {
          reviewId: review.id,
        });
        caseIds.push(review.caseId!);
        reviewIds.push(review.id);
      }
    });
    return { caseIds, reviewIds };
  }

  createAvailabilityRecoveryDraft(reviewId: string): DraftRow {
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
      channelId: this.requestChannelIdForCase(review.caseId),
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

  createAvailabilityReminderDraft(caseId: string): DraftRow {
    const bundle = this.db.getCaseBundle(caseId);
    if (!bundle || bundle.interviewCase.status !== "COLLECTING_AVAILABILITY") {
      throw new Error(
        "일정 입력 재안내는 면접관 일정 회신을 수집 중인 건에만 만들 수 있습니다.",
      );
    }
    const pendingInterviewerIds = bundle.interviewers
      .filter(
        (interviewer) =>
          interviewer.active &&
          interviewer.required &&
          interviewer.status === "PENDING",
      )
      .map((interviewer) => interviewer.id);
    if (pendingInterviewerIds.length === 0) {
      throw new Error("일정 제출을 기다리는 면접관이 없습니다.");
    }
    const missingSlackMappings = bundle.interviewers.filter(
      (interviewer) =>
        pendingInterviewerIds.includes(interviewer.id) && !interviewer.slackUserId,
    );
    if (missingSlackMappings.length > 0) {
      throw new Error(
        `Slack 사용자 매핑이 필요합니다: ${missingSlackMappings.map((item) => item.displayName).join(", ")}`,
      );
    }
    const payload = buildRequestMessage(bundle, {
      title: "인터뷰 가능 일정 입력 재안내",
      requestText:
        "앞서 안내드린 인터뷰 가능 일정 입력을 다시 요청드립니다. 아래 버튼에서 가능한 시간을 선택해 주세요.",
      targetInterviewerIds: pendingInterviewerIds,
      plan: this.db.getCaseInterviewPlan(caseId),
    });
    const draft = this.db.createDraft({
      caseId,
      channelId: this.requestChannelIdForCase(caseId),
      previewText: payload.text,
      blocksJson: JSON.stringify(payload.blocks),
      payloadHash: hashPayload(payload.text, payload.blocks),
      messageType: "AVAILABILITY_REMINDER",
      allowResend: true,
    });
    this.db.addEvent(caseId, "AVAILABILITY_REMINDER_DRAFT_CREATED", "USER", {
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
      if (processed.result.startsWith("INTERVIEW_CONFIRMED")) confirmed += 1;
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

  async reconcileNinehireConfirmedSchedules(): Promise<{
    trackedCandidates: number;
    discoveredSchedules: number;
    confirmedCases: number;
    manuallyRecorded: number;
    roomSelectionRequired: number;
    roomReviewRequired: number;
  }> {
    if (!this.ninehire.listCandidateSchedules) {
      throw new Error("NineHire confirmed-schedule lookup is not available.");
    }

    const targets = new Map<string, {
      candidateRef: string;
      recruitmentRef: string;
      kind: "CASE" | "CANDIDATE_CONFIRMATION" | "CONFIRMED" | "REVIEW";
      caseId?: string;
      reviewId?: string;
      candidateName: string;
      recruitmentName: string;
    }>();
    for (const interviewCase of this.db.listCases("READY_TO_SCHEDULE")) {
      if (
        !interviewCase.candidateRef ||
        !interviewCase.recruitmentRef ||
        !interviewCase.candidateName ||
        !interviewCase.recruitmentName
      ) {
        continue;
      }
      const key = `${interviewCase.candidateRef}:${interviewCase.recruitmentRef}`;
      if (targets.has(key)) continue;
      targets.set(key, {
        candidateRef: interviewCase.candidateRef,
        recruitmentRef: interviewCase.recruitmentRef,
        kind: "CASE",
        caseId: interviewCase.id,
        candidateName: interviewCase.candidateName,
        recruitmentName: interviewCase.recruitmentName,
      });
    }
    for (const interviewCase of this.db.listCases("AWAITING_CANDIDATE_CONFIRMATION")) {
      if (
        !interviewCase.candidateRef ||
        !interviewCase.recruitmentRef ||
        !interviewCase.candidateName ||
        !interviewCase.recruitmentName ||
        !this.db.hasCandidateScheduleProposalSent(interviewCase.id)
      ) {
        continue;
      }
      const key = `${interviewCase.candidateRef}:${interviewCase.recruitmentRef}`;
      if (targets.has(key)) continue;
      targets.set(key, {
        candidateRef: interviewCase.candidateRef,
        recruitmentRef: interviewCase.recruitmentRef,
        kind: "CANDIDATE_CONFIRMATION",
        caseId: interviewCase.id,
        candidateName: interviewCase.candidateName,
        recruitmentName: interviewCase.recruitmentName,
      });
    }
    for (const interviewCase of this.db.listCases("CONFIRMED")) {
      if (
        !interviewCase.candidateRef
        || !interviewCase.recruitmentRef
        || !interviewCase.candidateName
        || !interviewCase.recruitmentName
      ) {
        continue;
      }
      const key = `${interviewCase.candidateRef}:${interviewCase.recruitmentRef}`;
      if (targets.has(key)) continue;
      targets.set(key, {
        candidateRef: interviewCase.candidateRef,
        recruitmentRef: interviewCase.recruitmentRef,
        kind: "CONFIRMED",
        caseId: interviewCase.id,
        candidateName: interviewCase.candidateName,
        recruitmentName: interviewCase.recruitmentName,
      });
    }
    for (const review of this.db.listOpenReviews()) {
      if (review.reviewType !== "INTERVIEW_ARRANGEMENT_START_REQUIRED") continue;
      const approval = evaluationApprovalPayload(review.summary);
      const candidateRef = approval?.context.candidateRef;
      const recruitmentRef = approval?.context.recruitmentRef;
      const candidateName = approval?.context.candidateName;
      const recruitmentName = approval?.context.recruitmentName;
      if (!candidateRef || !recruitmentRef || !candidateName || !recruitmentName) {
        continue;
      }
      const key = `${candidateRef}:${recruitmentRef}`;
      if (targets.has(key)) continue;
      targets.set(key, {
        candidateRef,
        recruitmentRef,
        kind: "REVIEW",
        reviewId: review.id,
        candidateName,
        recruitmentName,
      });
    }

    if (targets.size === 0) {
      return {
        trackedCandidates: 0,
        discoveredSchedules: 0,
        confirmedCases: 0,
        manuallyRecorded: 0,
        roomSelectionRequired: 0,
        roomReviewRequired: 0,
      };
    }

    const schedules = await this.ninehire.listCandidateSchedules(
      [...targets.values()].map((target) => ({
        candidateRef: target.candidateRef,
        candidateName: target.candidateName,
        recruitmentRef: target.recruitmentRef,
        recruitmentName: target.recruitmentName,
      })),
    );
    const today = todayInKorea();
    const schedulesByTarget = new Map<string, NinehireCandidateSchedule>();
    for (const schedule of schedules) {
      if (schedule.date < today) continue;
      const targetKey = `${schedule.candidateRef}:${schedule.recruitmentRef}`;
      if (!targets.has(targetKey)) continue;
      const existing = schedulesByTarget.get(targetKey);
      if (
        !existing ||
        `${schedule.date}T${schedule.startTime}` < `${existing.date}T${existing.startTime}`
      ) {
        schedulesByTarget.set(targetKey, schedule);
      }
    }

    let discoveredSchedules = 0;
    let confirmedCases = 0;
    let manuallyRecorded = 0;
    let roomSelectionRequired = 0;
    let roomReviewRequired = 0;
    for (const [targetKey, schedule] of schedulesByTarget) {
      const target = targets.get(targetKey);
      if (!target) continue;
      discoveredSchedules += 1;

      if (target.kind === "CASE" && target.caseId) {
        try {
          this.db.recordExternallyConfirmedSchedule({
            caseId: target.caseId,
            sourceEventId: schedule.eventId,
            source: "NINEHIRE_MCP",
            date: schedule.date,
            startTime: schedule.startTime,
            endTime: schedule.endTime,
            sourceLocation: schedule.location,
          });
          const roomResult = this.resolveConfirmedScheduleRoom(target.caseId);
          confirmedCases += 1;
          if (roomResult === "INTERVIEW_CONFIRMED_ROOM_SELECTION_REQUIRED") {
            roomSelectionRequired += 1;
          } else if (roomResult === "INTERVIEW_CONFIRMED_ROOM_REVIEW_REQUIRED") {
            roomReviewRequired += 1;
          }
        } catch (error) {
          this.db.setCaseStatus(target.caseId, "REVIEW_REQUIRED");
          if (!this.db.hasCaseReview(target.caseId, "NINEHIRE_SCHEDULE_RECONCILIATION_REQUIRED")) {
            this.db.createReview({
              caseId: target.caseId,
              reviewType: "NINEHIRE_SCHEDULE_RECONCILIATION_REQUIRED",
              reason: error instanceof Error ? error.message : String(error),
              summary: this.reconciledScheduleSummary(schedule),
            });
          }
          roomReviewRequired += 1;
        }
        continue;
      }

      if (target.kind === "CANDIDATE_CONFIRMATION" && target.caseId) {
        try {
          this.db.recordExternallyConfirmedCandidateSchedule({
            caseId: target.caseId,
            sourceEventId: schedule.eventId,
            date: schedule.date,
            startTime: schedule.startTime,
            endTime: schedule.endTime,
            sourceLocation: schedule.location,
          });
          confirmedCases += 1;
        } catch (error) {
          this.db.setCaseStatus(target.caseId, "REVIEW_REQUIRED");
          if (!this.db.hasCaseReview(target.caseId, "NINEHIRE_SCHEDULE_RECONCILIATION_REQUIRED")) {
            this.db.createReview({
              caseId: target.caseId,
              reviewType: "NINEHIRE_SCHEDULE_RECONCILIATION_REQUIRED",
              reason: error instanceof Error ? error.message : String(error),
              summary: this.reconciledScheduleSummary(schedule),
            });
          }
          roomReviewRequired += 1;
        }
        continue;
      }

      if (target.kind === "CONFIRMED" && target.caseId) {
        const currentCase = this.db.getCase(target.caseId);
        if (
          currentCase
          && (
            currentCase.scheduledDate !== schedule.date
            || currentCase.scheduledStartTime !== schedule.startTime
            || currentCase.scheduledEndTime !== schedule.endTime
          )
        ) {
          this.db.reconcileConfirmedScheduleFromExternal({
            caseId: target.caseId,
            sourceEventId: schedule.eventId,
            source: "NINEHIRE_MCP",
            date: schedule.date,
            startTime: schedule.startTime,
            endTime: schedule.endTime,
            sourceLocation: schedule.location,
          });
        }
        continue;
      }

      if (target.kind !== "REVIEW" || !target.reviewId) continue;
      const review = this.db.getReview(target.reviewId);
      if (!review || review.status !== "OPEN") continue;
      const roomResult = this.reconcileManualNinehireSchedule(review, schedule);
      if (roomResult === "RECORDED") manuallyRecorded += 1;
      if (roomResult === "SELECTION_REQUIRED") roomSelectionRequired += 1;
      if (roomResult === "REVIEW_REQUIRED") roomReviewRequired += 1;
    }

    return {
      trackedCandidates: targets.size,
      discoveredSchedules,
      confirmedCases,
      manuallyRecorded,
      roomSelectionRequired,
      roomReviewRequired,
    };
  }

  async reconcileDaouCalendarConfirmedSchedules(
    calendar: DaouOfficeCalendarAdapter,
  ): Promise<{
    scannedEvents: number;
    recordedEvents: number;
    skippedPastEvents: number;
    removedPastRecords: number;
    matchedCases: number;
    confirmedCases: number;
    alreadyConfirmed: number;
    skippedMismatches: number;
    ambiguousEvents: number;
  }> {
    const calendarEvents = await calendar.listInterviewCalendarEvents();
    const today = todayInKorea();
    const events = calendarEvents.filter((event) => event.date >= today);
    const skippedPastEvents = calendarEvents.length - events.length;
    const removedPastRecords = this.db.deleteExternalConfirmedInterviewsBefore(today);
    this.db.syncExternalConfirmedInterviews(events, { reconcileCalendarSnapshot: true });
    const recordedEvents = events.length;
    const trackedCases = this.db
      .listCases(undefined, 500)
      .filter((interviewCase) => ["AWAITING_CANDIDATE_CONFIRMATION", "CONFIRMED"].includes(interviewCase.status));
    const linkedCasesByCalendarEvent = new Map(
      this.db
        .listExternalConfirmedInterviews(1_000)
        .filter((event) => Boolean(event.linkedCaseId))
        .map((event) => [event.sourceEventId, event.linkedCaseId!] as const),
    );
    const candidateKey = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, "").toLocaleLowerCase("ko-KR");
    let matchedCases = 0;
    let confirmedCases = 0;
    let alreadyConfirmed = 0;
    let skippedMismatches = 0;
    let ambiguousEvents = 0;
    for (const event of events) {
      const candidateMatches = trackedCases.filter((interviewCase) => candidateKey(interviewCase.candidateName) === candidateKey(event.candidateName));
      const exactScheduleMatches = candidateMatches.filter(
        (interviewCase) =>
          interviewCase.scheduledDate === event.date
          && interviewCase.scheduledStartTime === event.startTime
          && interviewCase.scheduledEndTime === event.endTime,
      );
      const sourceLinkedCaseId = linkedCasesByCalendarEvent.get(event.sourceEventId);
      const sourceLinkedMatches = sourceLinkedCaseId
        ? candidateMatches.filter((interviewCase) => interviewCase.id === sourceLinkedCaseId)
        : [];
      const matches = sourceLinkedMatches.length === 1
        ? sourceLinkedMatches
        : exactScheduleMatches;
      if (matches.length !== 1) {
        if (candidateMatches.length > 0) {
          if (candidateMatches.length > 1) ambiguousEvents += 1;
          continue;
        }
        const reviewMatches = this.db
          .listOpenReviews(1_000)
          .filter((review) => review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED")
          .filter((review) => candidateKey(evaluationApprovalPayload(review.summary)?.context.candidateName) === candidateKey(event.candidateName));
        if (reviewMatches.length !== 1 || !event.roomName) {
          if (reviewMatches.length > 1) ambiguousEvents += 1;
          continue;
        }
        const review = reviewMatches[0]!;
        if (this.db.getReview(review.id)?.status !== "OPEN") continue;
        const recorded = this.recordManualConfirmedInterview({
          reviewId: review.id,
          date: event.date,
          startTime: event.startTime,
          endTime: event.endTime,
          roomName: event.roomName,
          note: "다우오피스 캘린더의 확정 인터뷰 일정에서 자동 기록",
          source: "DAOU_OFFICE_CALENDAR",
          sourceEventId: event.sourceEventId,
        });
        this.db.linkExternalConfirmedInterviewToCase(event.sourceEventId, recorded.case.id);
        matchedCases += 1;
        confirmedCases += 1;
        continue;
      }
      const interviewCase = matches[0]!;
      matchedCases += 1;
      if (interviewCase.status === "CONFIRMED") {
        if (
          interviewCase.scheduledDate === event.date
          && interviewCase.scheduledStartTime === event.startTime
          && interviewCase.scheduledEndTime === event.endTime
        ) {
          this.db.linkExternalConfirmedInterviewToCase(event.sourceEventId, interviewCase.id);
          alreadyConfirmed += 1;
        }
        else {
          this.db.reconcileConfirmedScheduleFromExternal({
            caseId: interviewCase.id,
            sourceEventId: event.sourceEventId,
            source: "DAOU_OFFICE_CALENDAR",
            date: event.date,
            startTime: event.startTime,
            endTime: event.endTime,
            roomName: event.roomName,
          });
          this.db.linkExternalConfirmedInterviewToCase(event.sourceEventId, interviewCase.id);
          confirmedCases += 1;
        }
        continue;
      }
      if (
        interviewCase.scheduledDate !== event.date
        || interviewCase.scheduledStartTime !== event.startTime
        || interviewCase.scheduledEndTime !== event.endTime
      ) {
        skippedMismatches += 1;
        continue;
      }
      this.db.recordExternallyConfirmedCandidateSchedule({
        caseId: interviewCase.id,
        sourceEventId: event.sourceEventId,
        source: "DAOU_OFFICE_CALENDAR",
        date: event.date,
        startTime: event.startTime,
        endTime: event.endTime,
      });
      this.db.linkExternalConfirmedInterviewToCase(event.sourceEventId, interviewCase.id);
      confirmedCases += 1;
    }
    return {
      scannedEvents: events.length,
      recordedEvents,
      skippedPastEvents,
      removedPastRecords,
      matchedCases,
      confirmedCases,
      alreadyConfirmed,
      skippedMismatches,
      ambiguousEvents,
    };
  }

  private reconcileManualNinehireSchedule(
    review: { id: string; reviewType: string; status: string },
    schedule: NinehireCandidateSchedule,
  ): "RECORDED" | "SELECTION_REQUIRED" | "REVIEW_REQUIRED" {
    if (review.reviewType !== "INTERVIEW_ARRANGEMENT_START_REQUIRED") {
      return "REVIEW_REQUIRED";
    }
    if (!this.db.areMeetingRoomDatesSynced([schedule.date])) {
      this.createReconciledScheduleRoomReview(
        review.id,
        schedule,
        "NINEHIRE_CONFIRMED_SCHEDULE_ROOM_SYNC_REQUIRED",
        "나인하이어에서 직접 확정된 인터뷰 날짜의 다우오피스 회의실 정보가 없습니다. 회의실 동기화 후 다시 확인하세요.",
      );
      return "REVIEW_REQUIRED";
    }
    const rooms = this.db.findAvailableRoomBlocks(
      schedule.date,
      schedule.startTime,
      schedule.endTime,
    );
    if (rooms.length === 0) {
      this.createReconciledScheduleRoomReview(
        review.id,
        schedule,
        "NINEHIRE_CONFIRMED_SCHEDULE_ROOM_UNAVAILABLE",
        "나인하이어에서 직접 확정된 인터뷰 시간에 사용할 수 있는 동기화된 회의실이 없습니다.",
      );
      return "REVIEW_REQUIRED";
    }
    if (rooms.length === 1) {
      this.recordManualConfirmedInterview({
        reviewId: review.id,
        date: schedule.date,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
        roomName: rooms[0]!.roomName,
        note: `나인하이어 직접 확정 일정 ${schedule.eventId}에서 자동 기록`,
      });
      return "RECORDED";
    }

    this.db.createOrGetPendingInterviewSkillDecision({
      skillKey: "INTERVIEW_SCHEDULING",
      decisionType: "SELECT_NINEHIRE_CONFIRMED_SCHEDULE_ROOM",
      fingerprint: `review:${review.id}:event:${schedule.eventId}:rooms:${rooms.map((room) => room.id).join("|")}`,
      reviewId: review.id,
      title: "직접 확정된 인터뷰 회의실 선택",
      prompt: "나인하이어에서 직접 확정된 인터뷰에 사용할 회의실을 하나 선택하세요.",
      selectionMode: "SINGLE",
      options: rooms.map((room, index) => ({
        id: `NINEHIRE_CONFIRMED_ROOM_${index}`,
        label: room.roomName,
        description: `${schedule.date} ${schedule.startTime}~${schedule.endTime} 인터뷰로 기록합니다.`,
      })),
      context: {
        reviewId: review.id,
        eventId: schedule.eventId,
        candidateName: schedule.candidateName,
        recruitmentName: schedule.recruitmentName,
        date: schedule.date,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
        choices: rooms.map((room, index) => ({
          optionId: `NINEHIRE_CONFIRMED_ROOM_${index}`,
          roomName: room.roomName,
        })),
      },
    });
    return "SELECTION_REQUIRED";
  }

  private createReconciledScheduleRoomReview(
    reviewId: string,
    schedule: NinehireCandidateSchedule,
    reviewType: string,
    reason: string,
  ): void {
    if (this.db.hasOpenReviewForSourceEvent(reviewType, schedule.eventId)) return;
    this.db.createReview({
      reviewType,
      reason,
      summary: {
        reviewId,
        ...this.reconciledScheduleSummary(schedule),
      },
    });
  }

  private reconciledScheduleSummary(schedule: NinehireCandidateSchedule): Record<string, unknown> {
    return {
      eventId: schedule.eventId,
      candidateRef: schedule.candidateRef,
      candidateName: schedule.candidateName,
      recruitmentRef: schedule.recruitmentRef,
      recruitmentName: schedule.recruitmentName,
      date: schedule.date,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      location: schedule.location ?? null,
      attendeeNames: schedule.attendeeNames,
    };
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

    if (!this.isRecruitmentInManagedScope({
      recruitmentName: parsed.recruitmentName,
    })) {
      this.db.updateNotificationStatus(notificationId, "IGNORED_OUT_OF_SCOPE");
      return { notificationId, result: "SCHEDULE_CONFIRMATION_IGNORED_OUT_OF_SCOPE" };
    }

    const previouslyRecorded =
      this.db.findCaseByScheduleConfirmationNotification(notificationId);
    if (previouslyRecorded) {
      const result =
        previouslyRecorded.status === "CONFIRMED"
          ? this.resolveConfirmedScheduleRoom(previouslyRecorded.id)
          : "INTERVIEW_CONFIRMED";
      this.db.updateNotificationStatus(notificationId, "PROCESSED");
      return {
        notificationId,
        result,
        caseId: previouslyRecorded.id,
      };
    }

    const awaitingMatches = this.db.findAwaitingCandidateConfirmationCases(
      parsed.candidateName,
      parsed.recruitmentName,
    );
    let interviewCase: InterviewCaseRow;
    if (awaitingMatches.length === 1) {
      interviewCase = awaitingMatches[0]!;
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
    } else if (awaitingMatches.length === 0) {
      const readyMatches = this.db.findReadyToScheduleCandidateCases(
        parsed.candidateName,
        parsed.recruitmentName,
      );
      if (readyMatches.length !== 1) {
        if (readyMatches.length === 0) {
          this.db.syncExternalConfirmedInterviews([
            {
              sourceEventId: `NINEHIRE_SLACK:${notificationId}`,
              title: "NineHire confirmed interview",
              rawText: parsed.text,
              candidateName: parsed.candidateName,
              recruitmentName: parsed.recruitmentName,
              date: parsed.scheduledDate,
              startTime: parsed.scheduledStartTime,
              endTime: parsed.scheduledEndTime,
            },
          ]);
          for (const review of this.db.listOpenReviews()) {
            if (
              review.notificationId === notificationId &&
              review.reviewType === "SCHEDULE_CONFIRMATION_MATCH_REQUIRED"
            ) {
              this.db.resolveReview(review.id, "EXTERNAL_CONFIRMED_INTERVIEW_RECORDED");
            }
          }
          this.db.updateNotificationStatus(notificationId, "PROCESSED");
          return { notificationId, result: "INTERVIEW_CONFIRMED_EXTERNALLY_RECORDED" };
        }
        this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
        this.db.createReview({
          notificationId,
          reviewType: "SCHEDULE_CONFIRMATION_MATCH_REQUIRED",
          reason:
            "The confirmed-schedule notification did not match exactly one candidate-confirmation or ready-to-schedule case.",
          summary: {
            candidateName: parsed.candidateName,
            recruitmentName: parsed.recruitmentName,
            matchedCaseCount: readyMatches.length,
          },
        });
        return { notificationId, result: "REVIEW_REQUIRED" };
      }
      interviewCase = readyMatches[0]!;
      try {
        interviewCase = this.db.recordExternallyConfirmedSchedule({
          caseId: interviewCase.id,
          notificationId,
          date: parsed.scheduledDate,
          startTime: parsed.scheduledStartTime,
          endTime: parsed.scheduledEndTime,
          sourceLocation: parsed.location,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED", reason);
        this.db.createReview({
          notificationId,
          caseId: interviewCase.id,
          reviewType: "SCHEDULE_CONFIRMATION_DURATION_MISMATCH",
          reason,
          summary: {
            expectedDurationMinutes: interviewCase.durationMinutes,
            received: {
              date: parsed.scheduledDate,
              startTime: parsed.scheduledStartTime,
              endTime: parsed.scheduledEndTime,
            },
          },
        });
        return { notificationId, result: "REVIEW_REQUIRED", caseId: interviewCase.id };
      }
    } else {
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      this.db.createReview({
        notificationId,
        reviewType: "SCHEDULE_CONFIRMATION_MATCH_REQUIRED",
        reason:
          "The confirmed-schedule notification did not match exactly one candidate-confirmation case.",
        summary: {
          candidateName: parsed.candidateName,
          recruitmentName: parsed.recruitmentName,
          matchedCaseCount: awaitingMatches.length,
        },
      });
      return { notificationId, result: "REVIEW_REQUIRED" };
    }

    const roomResult = this.resolveConfirmedScheduleRoom(interviewCase.id);
    this.db.updateNotificationStatus(notificationId, "PROCESSED");
    return {
      notificationId,
      result: roomResult,
      caseId: interviewCase.id,
    };
  }

  private resolveConfirmedScheduleRoom(caseId: string): string {
    const interviewCase = this.db.getCase(caseId);
    if (
      !interviewCase ||
      interviewCase.status !== "CONFIRMED" ||
      !interviewCase.scheduledDate ||
      !interviewCase.scheduledStartTime ||
      !interviewCase.scheduledEndTime
    ) {
      throw new Error("The confirmed interview schedule is incomplete.");
    }

    if (interviewCase.scheduledRoomName) return "INTERVIEW_CONFIRMED";
    if (interviewCase.scheduledRoomAllocationId) {
      this.db.setConfirmedScheduleRoomAllocation({
        caseId,
        roomAllocationId: interviewCase.scheduledRoomAllocationId,
        actor: "SYSTEM",
      });
      return "INTERVIEW_CONFIRMED";
    }

    const plan = this.db.getCaseInterviewPlan(caseId);
    if (plan?.mode === "SEQUENTIAL") {
      this.db.createReview({
        caseId,
        reviewType: "CONFIRMED_SEQUENTIAL_INTERVIEW_ROOM_REQUIRED",
        reason:
          "A manually confirmed sequential interview needs room selection for each stage.",
      });
      return "INTERVIEW_CONFIRMED_ROOM_REVIEW_REQUIRED";
    }

    if (!this.db.areMeetingRoomDatesSynced([interviewCase.scheduledDate])) {
      this.db.createReview({
        caseId,
        reviewType: "CONFIRMED_INTERVIEW_ROOM_SYNC_REQUIRED",
        reason:
          "The confirmed interview date has no synced Daou Office meeting room data.",
        summary: {
          date: interviewCase.scheduledDate,
          startTime: interviewCase.scheduledStartTime,
          endTime: interviewCase.scheduledEndTime,
        },
      });
      return "INTERVIEW_CONFIRMED_ROOM_REVIEW_REQUIRED";
    }

    const rooms = this.db.findAvailableRoomBlocks(
      interviewCase.scheduledDate,
      interviewCase.scheduledStartTime,
      interviewCase.scheduledEndTime,
    );
    if (rooms.length === 1) {
      const allocation = this.db.allocateRoomBlock({
        caseId,
        roomBlockId: rooms[0]!.id,
        startTime: interviewCase.scheduledStartTime,
        endTime: interviewCase.scheduledEndTime,
      });
      this.db.setConfirmedScheduleRoomAllocation({
        caseId,
        roomAllocationId: allocation.id,
        actor: "SYSTEM",
      });
      return "INTERVIEW_CONFIRMED_ROOM_AUTO_ASSIGNED";
    }
    if (rooms.length === 0) {
      this.db.createReview({
        caseId,
        reviewType: "CONFIRMED_INTERVIEW_ROOM_UNAVAILABLE",
        reason:
          "No available synced meeting room block matches the confirmed interview schedule.",
        summary: {
          date: interviewCase.scheduledDate,
          startTime: interviewCase.scheduledStartTime,
          endTime: interviewCase.scheduledEndTime,
        },
      });
      return "INTERVIEW_CONFIRMED_ROOM_REVIEW_REQUIRED";
    }

    this.db.createOrGetPendingInterviewSkillDecision({
      skillKey: "INTERVIEW_SCHEDULING",
      decisionType: "SELECT_CONFIRMED_SCHEDULE_ROOM",
      fingerprint: `case:${caseId}:confirmed-room:${interviewCase.scheduledDate}:${interviewCase.scheduledStartTime}:${interviewCase.scheduledEndTime}:${rooms.map((room) => room.id).join("|")}`,
      caseId,
      title: "확정된 인터뷰 회의실 선택",
      prompt: "나인하이어에서 확정된 인터뷰 시간에 사용할 회의실을 하나 선택하세요.",
      selectionMode: "SINGLE",
      options: rooms.map((room, index) => ({
        id: `CONFIRMED_ROOM_${index}`,
        label: `${room.roomName}`,
        description: `${interviewCase.scheduledDate} ${interviewCase.scheduledStartTime}~${interviewCase.scheduledEndTime}에 이 회의실로 기록합니다.`,
      })),
      context: {
        caseId,
        candidateName: interviewCase.candidateName,
        recruitmentName: interviewCase.recruitmentName,
        choices: rooms.map((room, index) => ({
          optionId: `CONFIRMED_ROOM_${index}`,
          roomBlockId: room.id,
          roomName: room.roomName,
          date: interviewCase.scheduledDate,
          startTime: interviewCase.scheduledStartTime,
          endTime: interviewCase.scheduledEndTime,
        })),
      },
    });
    return "INTERVIEW_CONFIRMED_ROOM_SELECTION_REQUIRED";
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

    const previouslyReviewed = this.db.listOpenReviews(1_000).find(
      (review) =>
        review.notificationId === notificationId &&
        review.reviewType === "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED",
    );
    if (previouslyReviewed) {
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      return {
        notificationId,
        result: "CANDIDATE_ATTENDANCE_REVIEW_REQUIRED",
        ...(previouslyReviewed.caseId ? { caseId: previouslyReviewed.caseId } : {}),
      };
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
    input: {
      reviewId: string;
      routeTriggerStepId: string;
    },
  ): Promise<{
    notificationId: string;
    result: string;
    caseId: string;
    interviewPlan: ReturnType<BridgeDatabase["getCaseInterviewPlan"]>;
  }> {
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
    if (!approval.context.recruitmentRef) {
      throw new Error("The evaluation approval is missing its NineHire recruitment ID.");
    }
    const notificationId = review.notificationId;
    const template = await this.getCurrentRecruitmentInterviewTemplate(
      approval.context.recruitmentRef,
    );
    const route = template.routes.find(
      (item) => item.triggerStepId === input.routeTriggerStepId,
    );
    if (!route) {
      throw new Error("The selected interview route is not configured for this recruitment.");
    }
    const steps = route.stepIds.map((stepId) =>
      template.steps.find((step) => step.stepId === stepId),
    );
    if (steps.some((step) => !step)) {
      throw new Error("The selected interview route contains an unconfigured interview step.");
    }
    const resolvedSteps = steps as RecruitmentInterviewTemplateStep[];
    const interviewCase = this.db.transaction(() => {
      const created = this.db.createInterviewCase({
        notificationId,
        candidateRef: approval.context.candidateRef ?? undefined,
        candidateName: approval.context.candidateName ?? undefined,
        recruitmentRef: approval.context.recruitmentRef ?? undefined,
        recruitmentName: approval.context.recruitmentName ?? undefined,
        proposalDates: proposalDates(todayInKorea()),
      });
      this.applyTemplateInterviewRoute({
        caseId: created.id,
        route,
        steps: resolvedSteps,
        source: "USER",
      });
      this.db.updateNotificationStatus(notificationId, "PROCESSED");
      this.db.resolveReview(input.reviewId, "INTERVIEW_ARRANGEMENT_STARTED");
      return created;
    });
    return {
      notificationId,
      result: "INTERVIEW_CASE_CREATED",
      caseId: interviewCase.id,
      interviewPlan: this.db.getCaseInterviewPlan(interviewCase.id),
    };
  }

  async applyTemplateInterviewRouteToCase(input: {
    caseId: string;
    routeTriggerStepId: string;
  }) {
    const interviewCase = this.db.getCase(input.caseId);
    if (!interviewCase?.recruitmentRef) {
      throw new Error("The case is missing its NineHire recruitment ID.");
    }
    const template = await this.getCurrentRecruitmentInterviewTemplate(
      interviewCase.recruitmentRef,
    );
    const route = template.routes.find(
      (item) => item.triggerStepId === input.routeTriggerStepId,
    );
    if (!route) {
      throw new Error("The selected interview route is not configured for this recruitment.");
    }
    const steps = route.stepIds.map((stepId) =>
      template.steps.find((step) => step.stepId === stepId),
    );
    if (steps.some((step) => !step)) {
      throw new Error("The selected interview route contains an unconfigured interview step.");
    }
    const existingPlan = this.db.getCaseInterviewPlan(input.caseId);
    if (existingPlan) {
      const sameRoute =
        existingPlan.source === "TEMPLATE" &&
        existingPlan.mode === route.mode &&
        existingPlan.stepIds.length === route.stepIds.length &&
        existingPlan.stepIds.every((stepId, index) => stepId === route.stepIds[index]);
      if (sameRoute) return existingPlan;
      throw new Error("This case already has a different interview plan.");
    }
    if (interviewCase.status !== "READY_FOR_DRAFT") {
      throw new Error("Apply an interview route before creating an interviewer request draft.");
    }
    return this.db.transaction(() =>
      this.applyTemplateInterviewRoute({
        caseId: input.caseId,
        route,
        steps: steps as RecruitmentInterviewTemplateStep[],
        source: "USER",
      }),
    );
  }

  private async getCurrentRecruitmentInterviewTemplate(recruitmentId: string) {
    const template = this.db.getRecruitmentInterviewTemplate(recruitmentId);
    if (!template) {
      throw new Error("Approve the recruitment interview template before starting arrangement.");
    }
    if (!this.ninehire.getRecruitmentPipeline) return template;
    let currentPipelineHash: string | undefined;
    try {
      const pipeline = await this.ninehire.getRecruitmentPipeline(template.recruitmentId);
      currentPipelineHash = pipelineHash(pipeline.steps);
    } catch {
      // 나인하이어 조회가 일시적으로 실패해도 이미 승인된 템플릿을 사용합니다.
    }
    if (currentPipelineHash && currentPipelineHash !== template.pipelineHash) {
      throw new Error(
        "The recruitment interview template is outdated. Preview and approve the current pipeline before starting arrangement.",
      );
    }
    return template;
  }

  private applyTemplateInterviewRoute(input: {
    caseId: string;
    route: RecruitmentInterviewRoute;
    steps: RecruitmentInterviewTemplateStep[];
    source: "SYSTEM" | "USER";
  }) {
    const sessions = input.route.mode === "SEQUENTIAL"
      ? input.steps.map((step) => ({
          stepId: step.stepId,
          stepName: step.name,
          interviewerIds: [],
        }))
      : [];
    const plan = this.db.upsertCaseInterviewPlan({
      caseId: input.caseId,
      source: "TEMPLATE",
      mode: input.route.mode,
      stepIds: input.steps.map((step) => step.stepId),
      stepNames: input.steps.map((step) => step.name),
      sessions,
      durationMinutes: input.route.mode === "SEQUENTIAL"
        ? input.steps.reduce((total, step) => total + step.durationMinutes, 0)
        : input.steps[0]!.durationMinutes,
    });
    this.db.addEvent(input.caseId, "TEMPLATE_INTERVIEW_ROUTE_APPLIED", input.source, {
      triggerStepId: input.route.triggerStepId,
      mode: input.route.mode,
      stepIds: input.route.stepIds,
    });
    return plan;
  }

  recordManualConfirmedInterview(input: {
    reviewId: string;
    date: string;
    startTime: string;
    endTime: string;
    roomName: string;
    note?: string;
    source?: "DAOU_OFFICE_CALENDAR";
    sourceEventId?: string;
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
      source: input.source,
      sourceEventId: input.sourceEventId,
    });
    this.db.updateNotificationStatus(review.notificationId, "PROCESSED");
    this.db.resolveReview(
      review.id,
      input.source === "DAOU_OFFICE_CALENDAR"
        ? "DAOU_OFFICE_CALENDAR_CONFIRMED"
        : "MANUAL_INTERVIEW_CONFIRMED",
    );
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
          upstream.reason ??
          "현재 단계의 나인하이어 평가표에서 개별 평가자를 찾지 못했습니다. 평가표의 등록 평가자를 확인하거나 면접관을 건별로 직접 추가하세요.",
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
    const resolvedLookupReviews = this.db.resolveOpenCaseReviewsByType(
      caseId,
      "INTERVIEWER_LOOKUP_REQUIRED",
      "AUTO_RESOLVED_INTERVIEWERS_SYNCED",
    );
    if (resolvedLookupReviews > 0) {
      this.db.addEvent(
        caseId,
        "INTERVIEWER_LOOKUP_REVIEW_AUTO_RESOLVED",
        "SYSTEM",
        { resolvedLookupReviews },
      );
    }
    return {
      addedOrUpdated: upstream.interviewers.length,
      deactivated,
      missingSlackMappings,
      unresolvedUserGroups: upstream.unresolvedUserGroups,
    };
  }

  async createRequestDraft(caseId: string): Promise<DraftRow> {
    await this.syncCaseInterviewers(caseId);
    const bundle = this.db.getCaseBundle(caseId);
    if (!bundle) throw new Error(`Case not found: ${caseId}`);
    if (!["READY_FOR_DRAFT", "DRAFT_CREATED"].includes(bundle.interviewCase.status)) {
      throw new Error(
        "Interviewer request drafts can only be created before availability collection starts.",
      );
    }
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
      channelId: this.requestChannelIdForCase(caseId),
      previewText: payload.text,
      blocksJson: JSON.stringify(payload.blocks),
      payloadHash: hashPayload(payload.text, payload.blocks),
      messageType: "INTERVIEWER_REQUEST",
    });
  }

  async createNextWeekAvailabilityRetryDraft(caseId: string): Promise<{
    interviewCase: InterviewCaseRow;
    draft: DraftRow;
  }> {
    const interviewCase = this.db.getCase(caseId);
    if (!interviewCase || interviewCase.status !== "READY_TO_SCHEDULE") {
      throw new Error(
        "A new availability request can only be prepared after scheduling has no available common slot.",
      );
    }
    const nextDates = nextProposalWeekDates(
      interviewCase.proposalDates,
      todayInKorea(),
    );
    const prepared = this.db.prepareAvailabilityRecollection({
      caseId,
      proposalDates: nextDates,
      reason: "NO_COMMON_SCHEDULING_SLOT",
    });
    const draft = await this.createRequestDraft(caseId);
    this.db.addEvent(caseId, "NEXT_WEEK_AVAILABILITY_RETRY_DRAFT_CREATED", "SYSTEM", {
      draftId: draft.id,
      proposalDates: nextDates,
      scheduleRound: prepared.scheduleRound,
    });
    return { interviewCase: this.db.getCase(caseId)!, draft };
  }

  confirmInternalSchedule(caseId: string) {
    return this.db.confirmInternalSchedule(caseId);
  }

  reopenInterviewSchedule(input: {
    caseId: string;
    availabilityPolicy: RescheduleAvailabilityPolicy;
    reason: string;
  }): ScheduleTransitionResult & { scheduleUpdateDraft: DraftRow | null } {
    const transition = this.db.reopenScheduleForReschedule(input);
    return { ...transition, scheduleUpdateDraft: null };
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

  closeInterviewArrangement(input: {
    caseId: string;
    reason: string;
  }) {
    return this.db.closeInterviewArrangement(input);
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
    const bundle = this.db.getCaseBundle(caseId);
    if (!bundle) throw new Error(`Case not found: ${caseId}`);
    if (bundle.interviewCase.status !== "CONFIRMED") {
      throw new Error(
        "Create a Slack schedule announcement only after the candidate has confirmed the interview schedule.",
      );
    }
    const payload = this.buildScheduleConfirmationPayload(caseId, bundle);
    return this.db.createDraft({
      caseId,
      channelId: this.requestChannelIdForCase(caseId),
      previewText: payload.text,
      blocksJson: JSON.stringify(payload.blocks),
      payloadHash: hashPayload(payload.text, payload.blocks),
      messageType: payload.messageType,
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
    const previewText = draft.previewText.replace(
      input.textToReplace,
      input.replacementText,
    );
    return this.db.replacePendingDraftText({
      draftId: draft.id,
      previewText,
      blocksJson: JSON.stringify(blocks),
      payloadHash: hashPayload(previewText, blocks),
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

  async approveAndSendAvailabilityReminder(
    draftId: string,
    client: WebClient,
  ): Promise<DraftRow> {
    return this.approveAndSendDraft(draftId, "AVAILABILITY_REMINDER", client);
  }

  async approveAndSendScheduleConfirmation(
    draftId: string,
    client: WebClient,
  ): Promise<DraftRow> {
    const draft = this.db.getDraft(draftId);
    if (
      !draft ||
      !["SCHEDULE_CONFIRMATION", "SCHEDULE_CHANGE"].includes(draft.messageType)
    ) {
      throw new Error("This draft is not a final interview schedule announcement.");
    }
    return this.approveAndSendDraft(draftId, draft.messageType, client);
  }

  async approveAndSendScheduleUpdate(
    draftId: string,
    client: WebClient,
  ): Promise<DraftRow> {
    const draft = this.db.getDraft(draftId);
    if (!draft || draft.messageType !== "SCHEDULE_CANCELLATION") {
      throw new Error("This draft is not an interview schedule cancellation draft.");
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
        : ["SCHEDULE_CONFIRMATION", "SCHEDULE_CHANGE"].includes(messageType)
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
    if (approved.status === "SENT") return approved;
    const claimed = this.db.claimDraftForSending(approved.id);
    if (!claimed) {
      const latest = this.db.getDraft(approved.id);
      if (latest?.status === "SENT") return latest;
      throw new Error("Draft is currently being sent by another operation.");
    }
    try {
      const previouslySentTs = await this.findSlackMessageForDraft(
        claimed,
        client,
        slackMetadataEventType(messageType),
      );
      if (previouslySentTs) {
        return this.db.markDraftSent(claimed.id, previouslySentTs);
      }
      const response = await client.chat.postMessage({
        channel: claimed.channelId,
        text: claimed.previewText,
        blocks: JSON.parse(claimed.blocksJson) as never,
        metadata: {
          event_type: slackMetadataEventType(messageType),
          event_payload: { draft_id: claimed.id },
        },
      });
      if (!response.ts) {
        throw new Error("Slack accepted the request but did not return a message ts.");
      }
      return this.db.markDraftSent(claimed.id, response.ts);
    } catch (error) {
      const latest = this.db.getDraft(claimed.id);
      if (latest?.status === "SENDING") this.db.resetDraftSending(claimed.id);
      throw error;
    }
  }

  private createScheduleUpdateDraft(
    bundle: CaseBundle,
    schedule: ConfirmedInterviewScheduleRow,
    messageType: "SCHEDULE_CANCELLATION",
  ): DraftRow {
    const payload = buildScheduleUpdateMessage(
      bundle,
      schedule,
      "CANCELLATION",
    );
    return this.db.createDraft({
      caseId: bundle.interviewCase.id,
      channelId: this.requestChannelIdForCase(bundle.interviewCase.id),
      previewText: payload.text,
      blocksJson: JSON.stringify(payload.blocks),
      payloadHash: hashPayload(payload.text, payload.blocks),
      messageType,
    });
  }

  private buildScheduleConfirmationPayload(caseId: string, bundle: CaseBundle): {
    text: string;
    blocks: unknown;
    messageType: "SCHEDULE_CONFIRMATION" | "SCHEDULE_CHANGE";
  } {
    const schedule = this.db.getConfirmedInterviewSchedule(caseId);
    if (!schedule) throw new Error("The confirmed schedule record is missing.");
    const isScheduleChange = Boolean(
      bundle.interviewCase.lastScheduledDate &&
      this.db.hasSentScheduleConfirmation(caseId),
    );
    const payload = buildScheduleConfirmationMessage(bundle, schedule, {
      sequentialSessions: this.getSequentialScheduleMessageSessions(caseId),
      isScheduleChange,
    });
    return {
      ...payload,
      messageType: isScheduleChange ? "SCHEDULE_CHANGE" : "SCHEDULE_CONFIRMATION",
    };
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
