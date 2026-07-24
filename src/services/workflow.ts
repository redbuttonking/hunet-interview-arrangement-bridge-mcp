import { createHash } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import type { AppConfig } from "../config.js";
import {
  BridgeDatabase,
  type DraftRow,
  type InterviewCaseRow,
} from "../db/database.js";
import { proposalDates } from "../domain/calendar.js";
import type {
  CandidateContext,
  EvaluationSummary,
  SlackNotificationInput,
} from "../domain/types.js";
import type { NinehireWorkflowAdapter } from "../ninehire/adapter.js";
import {
  buildRequestMessage,
} from "../slack/blocks.js";
import type { ParsedSlackNotification } from "../slack/parser.js";

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

function hashPayload(text: string, blocks: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ text, blocks }))
    .digest("hex");
}

export interface SlackIdentityResolver {
  lookupUserIdByEmail(email: string): Promise<string | undefined>;
}

interface EvaluationApprovalPayload {
  context: CandidateContext;
  evaluation: EvaluationSummary;
}

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

export class WorkflowService {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly config: AppConfig,
    private readonly ninehire: NinehireWorkflowAdapter,
    private readonly identityResolver?: SlackIdentityResolver,
  ) {}

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
        : "IGNORED",
    );
    if (!stored.inserted) {
      return { notificationId: stored.id, result: "DUPLICATE" };
    }
    if (input.parsed.eventType !== "EVALUATION_COMPLETED") {
      return { notificationId: stored.id, result: "IGNORED" };
    }

    try {
      const evaluation = await this.ninehire.lookupCompletedEvaluation(
        input.parsed,
      );
      if (!evaluation.context || !evaluation.summary) {
        this.db.updateNotificationStatus(stored.id, "REVIEW_REQUIRED");
        this.db.createReview({
          notificationId: stored.id,
          reviewType: "EVALUATION_LOOKUP_REQUIRED",
          reason:
            evaluation.reason ??
            "평가표를 조회했지만 검토에 필요한 정보를 만들지 못했습니다.",
        });
        return { notificationId: stored.id, result: "REVIEW_REQUIRED" };
      }
      this.db.updateNotificationStatus(stored.id, "AWAITING_START_APPROVAL");
      this.db.createReview({
        notificationId: stored.id,
        reviewType: "INTERVIEW_ARRANGEMENT_START_REQUIRED",
        reason:
          "완료된 평가표 요약을 확인한 뒤 면접 조율 시작 여부를 승인하세요.",
        summary: {
          context: evaluation.context,
          evaluation: evaluation.summary,
        },
      });
      return { notificationId: stored.id, result: "EVALUATION_READY_FOR_APPROVAL" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateNotificationStatus(stored.id, "ERROR", message);
      this.db.createReview({
        notificationId: stored.id,
        reviewType: "EVALUATION_LOOKUP_FAILED",
        reason: message,
      });
      return { notificationId: stored.id, result: "ERROR" };
    }
  }

  async approveInterviewArrangement(
    reviewId: string,
  ): Promise<{ notificationId: string; result: string; caseId: string }> {
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
    this.db.updateNotificationStatus(review.notificationId, "PROCESSED");
    this.db.resolveReview(reviewId, "INTERVIEW_ARRANGEMENT_STARTED");
    return {
      notificationId: review.notificationId,
      result: "INTERVIEW_CASE_CREATED",
      caseId: interviewCase.id,
    };
  }

  async syncCaseInterviewers(caseId: string): Promise<{
    addedOrUpdated: number;
    deactivated: number;
    missingSlackMappings: string[];
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
    if (upstream.length === 0) {
      this.db.createReview({
        caseId,
        reviewType: "INTERVIEWER_LOOKUP_REQUIRED",
        reason:
          "NineHire interviewer mapping returned no interviewers. Configure the tool mapping or add a case interviewer manually.",
      });
      return {
        addedOrUpdated: 0,
        deactivated: 0,
        missingSlackMappings: [],
      };
    }

    const missingSlackMappings: string[] = [];
    for (const person of upstream) {
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
      upstream.map((person) => person.ninehireUserId),
    );
    return {
      addedOrUpdated: upstream.length,
      deactivated,
      missingSlackMappings,
    };
  }

  async createRequestDraft(caseId: string): Promise<DraftRow> {
    if (!this.config.slack.requestChannelId) {
      throw new Error("SLACK_REQUEST_CHANNEL_ID is not configured.");
    }
    await this.syncCaseInterviewers(caseId);
    const bundle = this.db.getCaseBundle(caseId);
    if (!bundle) throw new Error(`Case not found: ${caseId}`);
    const missing = bundle.interviewers.filter(
      (person) => person.active && person.required && !person.slackUserId,
    );
    if (missing.length > 0) {
      throw new Error(
        `Slack user mapping is missing for: ${missing.map((item) => item.displayName).join(", ")}`,
      );
    }
    const payload = buildRequestMessage(bundle);
    return this.db.createDraft({
      caseId,
      channelId: this.config.slack.requestChannelId,
      previewText: payload.text,
      blocksJson: JSON.stringify(payload.blocks),
      payloadHash: hashPayload(payload.text, payload.blocks),
    });
  }

  async approveAndSendDraft(
    draftId: string,
    client: WebClient,
  ): Promise<DraftRow> {
    const existing = this.db.getDraft(draftId);
    if (!existing) throw new Error(`Draft not found: ${draftId}`);
    if (existing.status === "SENT") return existing;

    await this.syncCaseInterviewers(existing.caseId);
    const bundle = this.db.getCaseBundle(existing.caseId);
    if (!bundle) throw new Error(`Case not found: ${existing.caseId}`);
    const current = buildRequestMessage(bundle);
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
    );
    if (previouslySentTs) {
      return this.db.markDraftSent(approved.id, previouslySentTs);
    }
    const response = await client.chat.postMessage({
      channel: approved.channelId,
      text: approved.previewText,
      blocks: JSON.parse(approved.blocksJson) as never,
      metadata: {
        event_type: "interview_bridge_request",
        event_payload: { draft_id: approved.id },
      },
    });
    if (!response.ts) {
      throw new Error("Slack accepted the request but did not return a message ts.");
    }
    return this.db.markDraftSent(approved.id, response.ts);
  }

  private async findSlackMessageForDraft(
    draft: DraftRow,
    client: WebClient,
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
          metadata?.event_type === "interview_bridge_request" &&
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
