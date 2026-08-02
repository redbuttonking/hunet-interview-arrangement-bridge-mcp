// 대시보드의 사용자 결정 요청을 기존 업무 서비스로 연결한다.
import { WebClient } from "@slack/web-api";
import { getConfig } from "../config.js";
import { DaouOfficeBrowserController } from "../daou-office/browser.js";
import { BridgeDatabase, type InterviewSkillDecisionRow } from "../db/database.js";
import { NinehireRecruitmentWorkflowAdapter } from "../ninehire/adapter.js";
import { NinehireMcpGateway } from "../ninehire/gateway.js";
import { OperationalReadinessService } from "../services/operational-readiness.js";
import { WorkflowService, type SlackIdentityResolver } from "../services/workflow.js";
import { InterviewArrangementSkills } from "../skills/interview-arrangement.js";

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
  const slackClient = config.slack.botToken ? new WebClient(config.slack.botToken) : undefined;
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
    slackClient,
  );
  const skills = new InterviewArrangementSkills(db, workflow, readiness);
  return { db, skills, workflow, slackClient };
}

export async function createDashboardReviewDecision(reviewId: string) {
  const runtime = createRuntime();
  try {
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
    } else if (review.reviewType === "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED") {
      decision = runtime.skills.createCandidateScheduleResponseDecision(reviewId);
    } else {
      throw new Error(`Dashboard decision is not available for review type: ${review.reviewType}`);
    }
    return { decision, dismissOnClose: true };
  } finally {
    runtime.db.close();
  }
}

export async function createDashboardTriageDecision(reviewId: string) {
  return createDashboardReviewDecision(reviewId);
}

export async function createDashboardCaseDecision(input: {
  caseId: string;
  skillKey: "AVAILABILITY_COLLECTION" | "INTERVIEW_SCHEDULING";
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
    } else {
      decision = runtime.skills.createInterviewSchedulingDecision(input.caseId);
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

export async function resolveDashboardDecision(input: {
  decisionId: string;
  optionId: string;
  note?: string;
}) {
  const runtime = createRuntime();
  try {
    const resolved = await runtime.skills.resolveDecision(input);
    const caseId = resolved.decision.caseId;
    const nextAction = resolved.outcome.nextAction;
    let followUp: unknown;
    if (
      caseId
      && resolved.decision.decisionType === "SYNC_INTERVIEWERS"
      && input.optionId === "SYNC_INTERVIEWERS"
    ) {
      followUp = runtime.skills.createAvailabilityCollectionDecision(caseId);
    }
    if (caseId && nextAction === "CREATE_AVAILABILITY_COLLECTION_DECISION") {
      followUp = runtime.skills.createAvailabilityCollectionDecision(caseId);
    }
    if (caseId && nextAction === "CREATE_INTERVIEW_SCHEDULING_DECISION") {
      followUp = runtime.skills.createInterviewSchedulingDecision(caseId);
    }
    if (caseId && nextAction === "CREATE_INTERVIEWER_SCHEDULE_CONFIRMATION_DRAFT") {
      followUp = runtime.workflow.createScheduleConfirmationDraft(caseId);
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
      return runtime.workflow.approveAndSendInterviewerRequest(draftId, runtime.slackClient);
    }
    if (draft.messageType === "SCHEDULE_CONFIRMATION") {
      return runtime.workflow.approveAndSendScheduleConfirmation(draftId, runtime.slackClient);
    }
    if (draft.messageType === "AVAILABILITY_RECOVERY") {
      return runtime.workflow.approveAndSendAvailabilityRecovery(draftId, runtime.slackClient);
    }
    if (["SCHEDULE_CHANGE", "SCHEDULE_CANCELLATION"].includes(draft.messageType)) {
      return runtime.workflow.approveAndSendScheduleUpdate(draftId, runtime.slackClient);
    }
    throw new Error(`Dashboard sending is not available for draft type: ${draft.messageType}`);
  } finally {
    runtime.db.close();
  }
}
