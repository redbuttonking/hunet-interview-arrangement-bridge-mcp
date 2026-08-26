// 대시보드의 사용자 결정 요청을 기존 업무 서비스로 연결한다.
import { WebClient } from "@slack/web-api";
import { getConfig } from "../config.js";
import { BrowserDaouOfficeReservationAdapter } from "../daou-office/adapter.js";
import { DaouOfficeBrowserController } from "../daou-office/browser.js";
import { DAOU_ROOM_SYNC_WINDOW_DAYS, upcomingKoreanDates } from "../domain/daou-room-sync.js";
import { isNinehireRateLimitError } from "../domain/integration-retry.js";
import { BridgeDatabase, type InterviewSkillDecisionRow } from "../db/database.js";
import { NinehireRecruitmentWorkflowAdapter } from "../ninehire/adapter.js";
import { NinehireBrowserController } from "../ninehire/browser.js";
import { NinehireMcpGateway } from "../ninehire/gateway.js";
import {
  NinehireScheduleProposalBrowser,
  NinehireScheduleProposalDispatchUncertainError,
} from "../ninehire/schedule-proposal-browser.js";
import { buildCandidateScheduleProposalDraft } from "../ninehire/schedule-proposal.js";
import { OperationalReadinessService } from "../services/operational-readiness.js";
import { AutomaticSchedulingPreparationService } from "../services/automatic-scheduling-preparation.js";
import { ScheduleSelectionRevalidationService } from "../services/schedule-selection-revalidation.js";
import { SlackReconciler } from "../slack/reconciler.js";
import { WorkflowService, type SlackIdentityResolver } from "../services/workflow.js";
import { InterviewArrangementSkills } from "../skills/interview-arrangement.js";

const schedulingSelectionDecisionTypes = new Set([
  "CONFIRM_STANDARD_SCHEDULE",
  "CONFIRM_SEQUENTIAL_SCHEDULE",
]);

class DashboardSlackIdentityResolver implements SlackIdentityResolver {
  constructor(private readonly client: WebClient) {}

  async lookupUserIdByEmail(email: string): Promise<string | undefined> {
    try {
      const response = await this.client.users.lookupByEmail({ email });
      return response.user?.id;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "data" in error
          ? String((error as { data?: { error?: string } }).data?.error)
          : "";
      if (code === "users_not_found") return undefined;
      throw error;
    }
  }
}

function createRuntime() {
  const config = getConfig();
  const db = new BridgeDatabase(config.dbPath);
  const gateway = new NinehireMcpGateway(config.ninehire);
  const ninehire = new NinehireRecruitmentWorkflowAdapter(gateway);
  const slackClient = config.slack.botToken
    ? new WebClient(config.slack.botToken, { timeout: 30_000 })
    : undefined;
  const readinessSlackClient = config.slack.botToken
    ? new WebClient(config.slack.botToken, {
      timeout: 12_000,
      retryConfig: { retries: 0 },
    })
    : undefined;
  const workflow = new WorkflowService(
    db,
    config,
    ninehire,
    slackClient ? new DashboardSlackIdentityResolver(slackClient) : undefined,
  );
  const readiness = new OperationalReadinessService(
    config,
    db,
    gateway,
    new DaouOfficeBrowserController(config.daouOffice),
    new NinehireBrowserController(config.ninehire),
    readinessSlackClient,
    12_000,
  );
  const skills = new InterviewArrangementSkills(db, workflow, readiness);
  const daouOfficeBrowser = new DaouOfficeBrowserController(config.daouOffice);
  const ninehireBrowser = new NinehireBrowserController(config.ninehire);
  const ninehireScheduleProposal = new NinehireScheduleProposalBrowser(config.ninehire);
  const daouOffice = new BrowserDaouOfficeReservationAdapter(config.daouOffice);
  const scheduleSelectionRevalidation = new ScheduleSelectionRevalidationService(
    db,
    daouOffice,
    skills,
  );
  return {
    config,
    db,
    skills,
    workflow,
    readiness,
    slackClient,
    daouOfficeBrowser,
    ninehireBrowser,
    ninehireScheduleProposal,
    daouOffice,
    scheduleSelectionRevalidation,
  };
}

function createOpenReviewDecision(
  runtime: ReturnType<typeof createRuntime>,
  reviewId: string,
) {
  const review = runtime.db.getReview(reviewId);
  if (!review || review.status !== "OPEN") {
    throw new Error(`Open review not found: ${reviewId}`);
  }
  const existing = runtime.db
    .listInterviewSkillDecisions({ status: "PENDING" })
    .find((decision) => decision.reviewId === reviewId);
  if (existing) return { decision: existing, dismissOnClose: false };
  let decision: InterviewSkillDecisionRow;
  if (
    [
      "INTERVIEW_ARRANGEMENT_START_REQUIRED",
      "RECRUITMENT_TEMPLATE_UPDATE_REQUIRED",
      "RECRUITMENT_TEMPLATE_CHECK_REQUIRED",
    ].includes(review.reviewType)
  ) {
    decision = runtime.skills.createCandidateTriageDecision(reviewId);
  } else if (
    [
      "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED",
      "CANDIDATE_MESSAGE_REVIEW_REQUIRED",
      "NINEHIRE_SCHEDULE_DELETION_DETECTED",
    ].includes(review.reviewType)
  ) {
    decision = runtime.skills.createCandidateScheduleResponseDecision(reviewId);
  } else if (review.reviewType === "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED") {
    decision = runtime.skills.createAvailabilityRecoveryDecision(reviewId);
  } else if (review.reviewType === "INTERVIEWER_NO_RESPONSE") {
    decision = runtime.skills.createInterviewerNoResponseDecision(reviewId);
  } else if (review.reviewType === "NINEHIRE_SCHEDULE_PROPOSAL_CONFIRMATION_REQUIRED") {
    decision = runtime.skills.createCandidateScheduleProposalReconciliationDecision(reviewId);
  } else {
    throw new Error(`Dashboard decision is not available for review type: ${review.reviewType}`);
  }
  return { decision, dismissOnClose: true };
}

export async function createDashboardReviewDecision(reviewId: string) {
  const runtime = createRuntime();
  try {
    return createOpenReviewDecision(runtime, reviewId);
  } finally {
    runtime.db.close();
  }
}

export async function createDashboardTriageDecision(reviewId: string) {
  return createDashboardReviewDecision(reviewId);
}

export async function createDashboardCaseDecision(input: {
  caseId: string;
  skillKey:
    | "AVAILABILITY_COLLECTION"
    | "INTERVIEW_SCHEDULING"
    | "CANDIDATE_SCHEDULE_PROPOSAL"
    | "CANDIDATE_SCHEDULE_RESPONSE";
}) {
  const runtime = createRuntime();
  try {
    const existing = runtime.db
      .listInterviewSkillDecisions({ status: "PENDING" })
      .find((decision) => decision.caseId === input.caseId && decision.skillKey === input.skillKey);
    if (existing) return { decision: existing, dismissOnClose: false };
    let decision: InterviewSkillDecisionRow;
    if (input.skillKey === "AVAILABILITY_COLLECTION") {
      decision = runtime.skills.createAvailabilityCollectionDecision(input.caseId);
    } else if (input.skillKey === "INTERVIEW_SCHEDULING") {
      decision = runtime.skills.createInterviewSchedulingDecision(input.caseId);
    } else if (input.skillKey === "CANDIDATE_SCHEDULE_PROPOSAL") {
      decision = runtime.skills.createCandidateScheduleProposalDecision(input.caseId);
    } else {
      const interviewCase = runtime.db.getCase(input.caseId);
      if (!interviewCase || interviewCase.status !== "AWAITING_CANDIDATE_CONFIRMATION") {
        throw new Error("후보자 일정 제안 이후 응답 대기 상태에서만 응답 조치를 시작할 수 있습니다.");
      }
      const review = runtime.db
        .listOpenReviews(1_000)
        .find((item) => item.caseId === input.caseId && [
          "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED",
          "CANDIDATE_MESSAGE_REVIEW_REQUIRED",
        ].includes(item.reviewType));
      const reviewId = review?.id ?? runtime.db.createReview({
        caseId: input.caseId,
        reviewType: "CANDIDATE_MESSAGE_REVIEW_REQUIRED",
        reason: "사용자가 후보자의 일정 변경, 취소 또는 보류 여부를 검토하도록 요청했습니다.",
        summary: {
          scheduledDate: interviewCase.scheduledDate,
          scheduledStartTime: interviewCase.scheduledStartTime,
          scheduledEndTime: interviewCase.scheduledEndTime,
          scheduledRoomName: interviewCase.scheduledRoomName,
        },
      });
      return createOpenReviewDecision(runtime, reviewId);
    }
    return { decision, dismissOnClose: true };
  } finally {
    runtime.db.close();
  }
}

export async function dismissDashboardDecision(decisionId: string) {
  const runtime = createRuntime();
  try {
    return runtime.db.discardPendingInterviewSkillDecision(decisionId);
  } finally {
    runtime.db.close();
  }
}

export async function resumeDashboardHeldReview(reviewId: string) {
  const runtime = createRuntime();
  try {
    runtime.db.reopenHeldReview(reviewId);
    return createOpenReviewDecision(runtime, reviewId);
  } finally {
    runtime.db.close();
  }
}

export async function resumeDashboardHeldCase(caseId: string) {
  const runtime = createRuntime();
  try {
    const resumed = runtime.db.resumeHeldInterviewCase(caseId);
    const heldReview = resumed.heldReviewId
      ? runtime.db.getReview(resumed.heldReviewId)
      : undefined;
    if (
      heldReview
      && heldReview.status === "RESOLVED"
      && heldReview.resolution === "HOLD"
      && [
        "INTERVIEW_ARRANGEMENT_START_REQUIRED",
        "RECRUITMENT_TEMPLATE_UPDATE_REQUIRED",
        "RECRUITMENT_TEMPLATE_CHECK_REQUIRED",
        "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED",
        "CANDIDATE_MESSAGE_REVIEW_REQUIRED",
        "NINEHIRE_SCHEDULE_DELETION_DETECTED",
      ].includes(heldReview.reviewType)
    ) {
      runtime.db.reopenHeldReview(heldReview.id);
      return { ...resumed, ...createOpenReviewDecision(runtime, heldReview.id) };
    }
    return resumed;
  } finally {
    runtime.db.close();
  }
}

export async function resolveDashboardDecision(input: {
  decisionId: string;
  optionId?: string;
  optionIds?: string[];
  note?: string;
}) {
  const runtime = createRuntime();
  let didResolve = false;
  let candidateScheduleProposalSentExternally = false;
  let resolvedCaseId: string | undefined;
  try {
    const optionIds = [...new Set(
      input.optionIds?.filter((optionId) => optionId.trim())
      ?? (input.optionId ? [input.optionId] : []),
    )];
    const primaryOptionId = optionIds[0];
    if (!primaryOptionId) {
      throw new Error("Select at least one interview skill decision option.");
    }
    const existing = runtime.db.getInterviewSkillDecision(input.decisionId);
    if (existing?.status === "RESOLVED") {
      if (existing.selectedOptionId !== primaryOptionId) {
        throw new Error(
          `Interview skill decision was already resolved with option: ${existing.selectedOptionId ?? "unknown"}`,
        );
      }
      return {
        decision: existing,
        outcome: existing.resolution ?? { action: primaryOptionId, nextAction: "NONE" },
        followUp: undefined,
      };
    }
    if (existing) {
      if (
        existing.caseId
        && schedulingSelectionDecisionTypes.has(existing.decisionType)
      ) {
        const interviewCase = runtime.db.getCase(existing.caseId);
        if (interviewCase?.status === "AWAITING_CANDIDATE_CONFIRMATION") {
          runtime.db.discardPendingInterviewSkillDecision(existing.id);
          if (runtime.db.hasCandidateScheduleProposalSent(existing.caseId)) {
            return {
              decision: existing,
              outcome: {
                action: "SCHEDULE_ALREADY_PROPOSED_TO_CANDIDATE",
                nextAction: "NONE",
              },
              followUp: undefined,
            };
          }
          const followUp = runtime.skills.createCandidateScheduleProposalDecision(existing.caseId);
          return {
            decision: followUp,
            outcome: {
              action: "SCHEDULE_ALREADY_CONFIRMED",
              nextAction: "CREATE_CANDIDATE_SCHEDULE_PROPOSAL_DECISION",
            },
            followUp,
          };
        }
      }
      let refreshedDecision: InterviewSkillDecisionRow | undefined;
      try {
        refreshedDecision = await runtime.scheduleSelectionRevalidation.refreshIfNeeded(existing);
      } catch {
        throw new Error(
          "회의실 예약 현황을 다시 확인하지 못했습니다. 다우오피스 연결을 확인한 뒤 다시 시도해 주세요.",
        );
      }
      if (refreshedDecision) {
        return {
          decision: refreshedDecision,
          outcome: {
            action: "SCHEDULE_RECOMMENDATION_REFRESHED",
            nextAction: "RESELECT_SCHEDULE",
          },
          followUp: refreshedDecision,
        };
      }
    }
    const resolved = await runtime.skills.resolveDecision({
      ...input,
      optionId: primaryOptionId,
      optionIds,
    });
    didResolve = true;
    const caseId = resolved.decision.caseId;
    resolvedCaseId = caseId;
    const nextAction = resolved.outcome.nextAction;
    let followUp: unknown;
    if (
      caseId
      && resolved.decision.decisionType === "SYNC_INTERVIEWERS"
      && primaryOptionId === "SYNC_INTERVIEWERS"
    ) {
      followUp = runtime.skills.createAvailabilityCollectionDecision(caseId);
    }
    if (caseId && nextAction === "CREATE_AVAILABILITY_COLLECTION_DECISION") {
      followUp = runtime.skills.createAvailabilityCollectionDecision(caseId);
    }
    if (caseId && nextAction === "CREATE_AVAILABILITY_REMINDER_DRAFT") {
      followUp = {
        kind: "AVAILABILITY_REMINDER_DRAFT_CREATED",
        draft: runtime.workflow.createAvailabilityReminderDraft(
          caseId,
          resolved.decision.reviewId ?? undefined,
        ),
      };
    }
    if (caseId && nextAction === "CREATE_INTERVIEW_SCHEDULING_DECISION") {
      followUp = runtime.skills.createInterviewSchedulingDecision(caseId);
    }
    if (nextAction === "CHOOSE_CANDIDATE_RESCHEDULE_METHOD") {
      if (!resolved.decision.reviewId) {
        throw new Error("후보자 응답 검토 정보를 찾지 못했습니다.");
      }
      followUp = runtime.skills.createCandidateRescheduleMethodDecision(
        resolved.decision.reviewId,
      );
    }
    if (caseId && nextAction === "MAP_INTERVIEWER_TO_SLACK") {
      const bundle = runtime.db.getCaseBundle(caseId);
      if (!bundle) throw new Error(`Case not found: ${caseId}`);
      followUp = {
        kind: "INTERVIEWER_SLACK_MAPPING",
        caseId,
        interviewers: bundle.interviewers
          .filter(
            (interviewer) =>
              interviewer.active &&
              interviewer.required &&
              !interviewer.slackUserId &&
              interviewer.ninehireUserId,
          )
          .map((interviewer) => ({
            ninehireUserId: interviewer.ninehireUserId!,
            displayName: interviewer.displayName,
            email: interviewer.email,
          })),
      };
    }
    if (caseId && nextAction === "CREATE_CANDIDATE_SCHEDULE_PROPOSAL_DECISION") {
      followUp = runtime.skills.createCandidateScheduleProposalDecision(caseId);
    }
    if (caseId && nextAction === "SEND_NINEHIRE_CANDIDATE_SCHEDULE_PROPOSAL") {
      const bundle = runtime.db.getCaseBundle(caseId);
      if (!bundle) throw new Error("후보자 일정 제안에 필요한 조율 건을 찾지 못했습니다.");
      const proposal = buildCandidateScheduleProposalDraft({
        interviewCase: bundle.interviewCase,
        plan: runtime.db.getCaseInterviewPlan(caseId),
        proposalOptions: runtime.db.listCurrentCandidateScheduleOptions(caseId),
        interviewers: bundle.interviewers,
        appUrl: runtime.config.ninehire.appUrl,
      });
      const sent = await runtime.ninehireScheduleProposal.send(proposal);
      candidateScheduleProposalSentExternally = true;
      const interviewCase = runtime.db.recordCandidateScheduleProposalSent(caseId);
      followUp = {
        kind: "NINEHIRE_SCHEDULE_PROPOSAL_SENT",
        candidateName: proposal.candidateName,
        proposalOptions: proposal.proposalOptions,
        emailTemplateName: sent.emailTemplateName,
        interviewCase,
      };
    }
    if (caseId && nextAction === "SYNC_DAOU_MEETING_ROOM_BLOCKS") {
      const interviewCase = runtime.db.getCase(caseId);
      if (!interviewCase) throw new Error(`Case not found: ${caseId}`);
      const blocks = await runtime.daouOffice.listMeetingRoomBlocks(
        interviewCase.proposalDates,
      );
      const synced = runtime.db.syncMeetingRoomBlocks(
        interviewCase.proposalDates,
        blocks,
      );
      followUp = {
        kind: "DAOU_MEETING_ROOM_SYNC",
        blockCount: synced.filter((block) => block.active).length,
        decision: runtime.skills.createInterviewSchedulingDecision(caseId),
      };
    }
    if (nextAction === "PREVIEW_RECRUITMENT_INTERVIEW_TEMPLATE") {
      const context = resolved.outcome.context;
      const recruitmentId =
        typeof context === "object" && context !== null && "recruitmentRef" in context
          ? (context as { recruitmentRef?: unknown }).recruitmentRef
          : undefined;
      if (typeof recruitmentId !== "string" || !recruitmentId) {
        throw new Error("채용 인터뷰 규칙을 확인할 채용 정보를 찾지 못했습니다.");
      }
      followUp = {
        kind: "RECRUITMENT_TEMPLATE_PREVIEW",
        preview: await runtime.workflow.previewRecruitmentInterviewTemplate(recruitmentId),
      };
    }
    return { ...resolved, followUp };
  } catch (error) {
    const decision = runtime.db.getInterviewSkillDecision(input.decisionId);
    if (error instanceof NinehireScheduleProposalDispatchUncertainError) {
      const caseId = resolvedCaseId ?? decision?.caseId;
      if (caseId) {
        runtime.db.createReview({
          caseId,
          reviewType: "NINEHIRE_SCHEDULE_PROPOSAL_CONFIRMATION_REQUIRED",
          reason: "Candidate schedule proposal dispatch result could not be verified.",
          summary: { decisionId: input.decisionId },
        });
      }
      throw error;
    }
    if (candidateScheduleProposalSentExternally) {
      throw new Error(
        "나인하이어 메일 발송은 완료됐지만 로컬 기록을 마치지 못했습니다. 같은 발송 버튼을 다시 누르지 말고 나인하이어 발송 이력을 확인해 주세요.",
        { cause: error },
      );
    }
    if (
      !didResolve
      && decision?.status === "RESOLVED"
      && decision.selectedOptionId === (input.optionIds?.[0] ?? input.optionId)
    ) {
      return {
        decision,
        outcome: decision.resolution ?? { action: input.optionIds?.[0] ?? input.optionId ?? "UNKNOWN", nextAction: "NONE" },
        followUp: undefined,
      };
    }
    if (didResolve && decision?.status === "RESOLVED") {
      runtime.db.reopenResolvedInterviewSkillDecision(
        decision.id,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  } finally {
    runtime.db.close();
  }
}

export async function getDashboardOperationalReadiness(input?: {
  checkExternal?: boolean;
}) {
  const runtime = createRuntime();
  try {
    return {
      readiness: await runtime.readiness.inspect({
        checkExternal: input?.checkExternal === true,
      }),
      retryJobs: runtime.db.listIntegrationRetryJobs({ limit: 20 }).map((job) => ({
        id: job.id,
        jobType: job.jobType,
        status: job.status,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        nextAttemptAt: job.nextAttemptAt,
        lastError: job.lastError ? "연동 작업이 실패했습니다. 로컬 로그를 확인해 주세요." : null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
    };
  } finally {
    runtime.db.close();
  }
}

export async function refreshDashboardExternalData(): Promise<{
  completedAt: string;
  steps: Array<{
    id: "SLACK" | "NINEHIRE" | "DAOU_CALENDAR" | "DAOU_ROOMS" | "SCHEDULING";
    label: string;
    status: "COMPLETED" | "DEFERRED" | "FAILED";
    detail: string;
  }>;
}> {
  const runtime = createRuntime();
  const steps: Array<{
    id: "SLACK" | "NINEHIRE" | "DAOU_CALENDAR" | "DAOU_ROOMS" | "SCHEDULING";
    label: string;
    status: "COMPLETED" | "DEFERRED" | "FAILED";
    detail: string;
  }> = [];
  const runStep = async (
    id: (typeof steps)[number]["id"],
    label: string,
    operation: () => Promise<string>,
  ) => {
    try {
      steps.push({ id, label, status: "COMPLETED", detail: await operation() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isNinehireRateLimitError(message)) {
        const until = runtime.workflow.deferNinehireRequestsAfterRateLimit();
        steps.push({
          id,
          label,
          status: "DEFERRED",
          detail: `나인하이어 요청 한도 보호 중입니다. ${until.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 이후 자동으로 다시 확인합니다.`,
        });
        return;
      }
      steps.push({
        id,
        label,
        status: "FAILED",
        detail: message,
      });
    }
  };

  try {
    await runStep("SLACK", "Slack 알림과 평가 완료 상태", async () => {
      if (!runtime.slackClient) throw new Error("Slack 봇 토큰이 설정되어 있지 않습니다.");
      const reconciler = new SlackReconciler(
        runtime.db,
        runtime.config,
        runtime.slackClient,
        runtime.workflow,
      );
      await reconciler.reconcile();
      await runtime.workflow.reconcileNonSchedulingCandidateMessageReviews();
      const rateLimitUntil = runtime.workflow.getNinehireRateLimitUntil();
      if (rateLimitUntil) {
        runtime.db.setCursor("sync:slack:last_success", new Date().toISOString());
        return `Slack 알림을 확인했습니다. 나인하이어 평가는 ${rateLimitUntil.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 이후 자동으로 다시 확인합니다.`;
      }
      await runtime.workflow.reconcileReceiptEvaluationCompletions();
      await runtime.workflow.refreshOpenInterviewArrangementReviewStages();
      runtime.db.setCursor("sync:slack:last_success", new Date().toISOString());
      return "나인하이어 Slack 알림과 후보자·면접관 상태를 확인했습니다.";
    });
    const rateLimitUntil = runtime.workflow.getNinehireRateLimitUntil();
    if (rateLimitUntil) {
      steps.push({
        id: "NINEHIRE",
        label: "나인하이어 확정 인터뷰 일정",
        status: "DEFERRED",
        detail: `나인하이어 요청 한도 보호 중입니다. ${rateLimitUntil.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 이후 자동으로 다시 확인합니다.`,
      });
    } else {
      await runStep("NINEHIRE", "나인하이어 확정 인터뷰 일정", async () => {
        const result = await runtime.workflow.reconcileNinehireConfirmedSchedules();
        runtime.db.setCursor("sync:ninehire:last_success", new Date().toISOString());
        return result.scheduleDeletionDetected > 0
          ? `확정 일정 ${result.discoveredSchedules}건을 확인했고, 일정 삭제 감지 ${result.scheduleDeletionDetected}건을 등록했습니다.`
          : `확정 일정 ${result.discoveredSchedules}건을 확인했습니다.`;
      });
    }
    await runStep("DAOU_CALENDAR", "다우오피스 인터뷰 캘린더", async () => {
      const result = await runtime.workflow.reconcileDaouCalendarConfirmedSchedules(runtime.daouOffice);
      runtime.db.setCursor("sync:daou_calendar:last_success", new Date().toISOString());
      return `오늘 이후 인터뷰 일정 ${result.recordedEvents}건을 확인했습니다.`;
    });
    await runStep("DAOU_ROOMS", "다우오피스 회의실 예약", async () => {
      const dates = upcomingKoreanDates(new Date(), DAOU_ROOM_SYNC_WINDOW_DAYS);
      const blocks = await runtime.daouOffice.listMeetingRoomBlocks(dates);
      runtime.db.syncMeetingRoomBlocks(dates, blocks);
      runtime.db.setCursor("sync:daou_rooms:last_success", new Date().toISOString());
      return `${dates.length}일 범위의 회의실 예약 ${blocks.length}건을 확인했습니다.`;
    });
    await runStep("SCHEDULING", "일정 추천 준비", async () => {
      const preparation = new AutomaticSchedulingPreparationService(
        runtime.db,
        runtime.daouOffice,
        runtime.skills,
      );
      const prepared = await preparation.prepareReadyCases();
      return prepared.length > 0
        ? `일정 선택이 가능한 인터뷰 ${prepared.length}건을 준비했습니다.`
        : "새로 준비할 일정 선택 건이 없습니다.";
    });
    return { completedAt: new Date().toISOString(), steps };
  } finally {
    runtime.db.close();
  }
}

export function retryDashboardIntegrationJob(jobId: string) {
  const runtime = createRuntime();
  try {
    const result = runtime.workflow.requeueIntegrationRetryJob(jobId);
    return {
      queued: result.queued,
      retryJob: {
        id: result.job.id,
        jobType: result.job.jobType,
        status: result.job.status,
        attemptCount: result.job.attemptCount,
        maxAttempts: result.job.maxAttempts,
        nextAttemptAt: result.job.nextAttemptAt,
      },
    };
  } finally {
    runtime.db.close();
  }
}

export async function openDashboardDaouOfficeLogin() {
  const runtime = createRuntime();
  try {
    return runtime.daouOfficeBrowser.openLoginWindow();
  } finally {
    runtime.db.close();
  }
}

export async function openDashboardNinehireLogin() {
  const runtime = createRuntime();
  try {
    return runtime.ninehireBrowser.openLoginWindow();
  } finally {
    runtime.db.close();
  }
}

export async function syncDashboardDaouMeetingRooms(caseId: string) {
  const runtime = createRuntime();
  try {
    const interviewCase = runtime.db.getCase(caseId);
    if (!interviewCase) throw new Error(`Case not found: ${caseId}`);
    const blocks = await runtime.daouOffice.listMeetingRoomBlocks(
      interviewCase.proposalDates,
    );
    const synced = runtime.db.syncMeetingRoomBlocks(interviewCase.proposalDates, blocks);
    return {
      caseId,
      blockCount: synced.filter((block) => block.active).length,
      dates: interviewCase.proposalDates,
    };
  } finally {
    runtime.db.close();
  }
}

export async function searchDashboardSlackUsers(query: string) {
  const runtime = createRuntime();
  try {
    if (!runtime.slackClient) {
      throw new Error("Slack bot token is not configured.");
    }
    const normalized = query.trim().toLocaleLowerCase("ko-KR");
    if (normalized.length < 2) {
      throw new Error("Enter at least two characters to search Slack users.");
    }
    type SlackMember = NonNullable<Awaited<ReturnType<WebClient["users"]["list"]>>["members"]>[number];
    const members: SlackMember[] = [];
    let cursor: string | undefined;
    do {
      const response = await runtime.slackClient.users.list({
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      members.push(...(response.members ?? []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return members
      .flatMap((member) => {
        const name = member.real_name ?? member.name;
        const email = member.profile?.email;
        const haystack = [name, member.name, email]
          .filter((value): value is string => Boolean(value))
          .join(" ")
          .toLocaleLowerCase("ko-KR");
        if (
          !member.id ||
          !name ||
          member.deleted ||
          member.is_bot ||
          !haystack.includes(normalized)
        ) return [];
        return [{ id: member.id, name, email: email ?? null }];
      })
      .slice(0, 20);
  } finally {
    runtime.db.close();
  }
}

export async function mapDashboardInterviewerToSlack(input: {
  caseId: string;
  ninehireUserId: string;
  slackUserId: string;
  displayName: string;
  email?: string | null;
}) {
  const runtime = createRuntime();
  try {
    runtime.db.upsertIdentityMapping({
      ninehireUserId: input.ninehireUserId,
      slackUserId: input.slackUserId,
      displayName: input.displayName,
      ...(input.email ? { email: input.email } : {}),
    });
    const synced = await runtime.workflow.syncCaseInterviewers(input.caseId);
    return { mapped: true, synced };
  } finally {
    runtime.db.close();
  }
}

export async function setDashboardCaseInterviewPlan(input: {
  caseId: string;
  mode: "COMBINED" | "SEQUENTIAL";
  stepIds?: string[];
  interviewerIds?: string[];
  sessions?: Array<{ stepId: string; interviewerIds: string[] }>;
}) {
  const runtime = createRuntime();
  try {
    if (input.mode === "COMBINED") {
      if (!input.stepIds || !input.interviewerIds) {
        throw new Error("Combined interview stages and interviewers are required.");
      }
      return runtime.workflow.setCaseCombinedInterviewPlan({
        caseId: input.caseId,
        stepIds: input.stepIds,
        interviewerIds: input.interviewerIds,
      });
    }
    if (!input.sessions) {
      throw new Error("Sequential interview sessions are required.");
    }
    return runtime.workflow.setCaseSequentialInterviewPlan({
      caseId: input.caseId,
      sessions: input.sessions,
    });
  } finally {
    runtime.db.close();
  }
}

export async function resetDashboardCaseInterviewPlanToTemplate(input: {
  caseId: string;
}) {
  const runtime = createRuntime();
  try {
    return runtime.workflow.resetCaseInterviewPlanToTemplate(input.caseId);
  } finally {
    runtime.db.close();
  }
}

export async function approveDashboardRecruitmentInterviewTemplate(input: {
  recruitmentId: string;
  reviewId?: string | null;
  steps: Array<{
    stepId: string;
    mode: "STANDARD" | "COMBINED";
    durationMinutes: number;
  }>;
}) {
  const runtime = createRuntime();
  try {
    const template = await runtime.workflow.approveRecruitmentInterviewTemplate({
      recruitmentId: input.recruitmentId,
      steps: input.steps,
    });
    const review = input.reviewId
      ? runtime.db.getReview(input.reviewId)
      : undefined;

    if (!review || review.status !== "OPEN") {
      return { template };
    }

    if (review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED") {
      return {
        template,
        decision: runtime.skills.createCandidateTriageDecision(review.id),
      };
    }

    if (
      [
        "RECRUITMENT_TEMPLATE_UPDATE_REQUIRED",
        "RECRUITMENT_TEMPLATE_CHECK_REQUIRED",
      ].includes(review.reviewType)
    ) {
      runtime.db.resolveReview(review.id, "RECRUITMENT_TEMPLATE_APPROVED");
    }

    return { template };
  } finally {
    runtime.db.close();
  }
}

export async function approveDashboardDraft(draftId: string) {
  const runtime = createRuntime();
  try {
    if (!runtime.slackClient) {
      throw new Error("Slack 봇 토큰이 설정되지 않아 메시지를 발송할 수 없습니다.");
    }
    const draft = runtime.db.getDraft(draftId);
    if (!draft) throw new Error(`Draft not found: ${draftId}`);
    if (draft.messageType === "INTERVIEWER_REQUEST") {
      return await runtime.workflow.approveAndSendInterviewerRequest(
        draftId,
        runtime.slackClient,
      );
    }
    if (["SCHEDULE_CONFIRMATION", "SCHEDULE_CHANGE"].includes(draft.messageType)) {
      return await runtime.workflow.approveAndSendScheduleConfirmation(
        draftId,
        runtime.slackClient,
      );
    }
    if (draft.messageType === "AVAILABILITY_RECOVERY") {
      return await runtime.workflow.approveAndSendAvailabilityRecovery(
        draftId,
        runtime.slackClient,
      );
    }
    if (draft.messageType === "AVAILABILITY_REMINDER") {
      return await runtime.workflow.approveAndSendAvailabilityReminder(
        draftId,
        runtime.slackClient,
      );
    }
    if (draft.messageType === "SCHEDULE_CANCELLATION") {
      return await runtime.workflow.approveAndSendScheduleUpdate(
        draftId,
        runtime.slackClient,
      );
    }
    throw new Error(`Dashboard sending is not available for draft type: ${draft.messageType}`);
  } finally {
    runtime.db.close();
  }
}
