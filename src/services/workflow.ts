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
  EvaluationDecision,
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

function contextFromNotification(row: Record<string, unknown>): CandidateContext {
  const optional = (name: string): string | undefined => {
    const value = row[name];
    return value === null || value === undefined ? undefined : String(value);
  };
  return {
    candidateRef: optional("candidate_ref"),
    candidateName: optional("candidate_name"),
    recruitmentRef: optional("recruitment_ref"),
    recruitmentName: optional("recruitment_name"),
  };
}

export interface SlackIdentityResolver {
  lookupUserIdByEmail(email: string): Promise<string | undefined>;
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
      const evaluation = await this.ninehire.lookupEvaluation(input.parsed);
      return await this.applyEvaluationDecision(
        stored.id,
        input.parsed,
        evaluation.decision,
        evaluation.reason,
      );
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

  async resolveEvaluationReview(
    reviewId: string,
    decision: Exclude<EvaluationDecision, "REVIEW_REQUIRED">,
  ): Promise<{ notificationId: string; result: string; caseId?: string }> {
    const review = this.db.getReview(reviewId);
    if (!review || review.status !== "OPEN" || !review.notificationId) {
      throw new Error(`Open evaluation review not found: ${reviewId}`);
    }
    const row = this.db.getNotification(review.notificationId);
    if (!row) throw new Error("The review's Slack notification is missing.");
    const result = await this.applyEvaluationDecision(
      review.notificationId,
      contextFromNotification(row),
      decision,
      "Manually resolved by user.",
    );
    this.db.resolveReview(reviewId, decision);
    return result;
  }

  private async applyEvaluationDecision(
    notificationId: string,
    context: CandidateContext,
    decision: EvaluationDecision,
    reason?: string,
  ): Promise<{ notificationId: string; result: string; caseId?: string }> {
    if (decision === "FAIL") {
      this.db.updateNotificationStatus(notificationId, "PROCESSED");
      return { notificationId, result: "EVALUATION_FAILED" };
    }
    if (decision === "REVIEW_REQUIRED") {
      this.db.updateNotificationStatus(notificationId, "REVIEW_REQUIRED");
      this.db.createReview({
        notificationId,
        reviewType: "EVALUATION_DECISION_REQUIRED",
        reason: reason ?? "NineHire did not return a mapped evaluation result.",
      });
      return { notificationId, result: "REVIEW_REQUIRED" };
    }

    const interviewCase = this.db.createInterviewCase({
      notificationId,
      candidateRef: context.candidateRef,
      candidateName: context.candidateName,
      recruitmentRef: context.recruitmentRef,
      recruitmentName: context.recruitmentName,
      proposalDates: proposalDates(todayInKorea()),
    });
    this.db.updateNotificationStatus(notificationId, "PROCESSED");
    await this.syncCaseInterviewers(interviewCase.id);
    return {
      notificationId,
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
