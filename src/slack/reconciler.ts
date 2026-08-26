import type { WebClient } from "@slack/web-api";
import type { AppConfig } from "../config.js";
import { BridgeDatabase } from "../db/database.js";
import { WorkflowService } from "../services/workflow.js";
import { parseNinehireSlackMessage } from "./parser.js";

interface SlackMessage {
  ts?: string;
  bot_id?: string;
  subtype?: string;
  [key: string]: unknown;
}

export class SlackReconciler {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly config: AppConfig,
    private readonly client: WebClient,
    private readonly workflow: WorkflowService,
  ) {}

  async ingestMessage(
    channelId: string,
    message: SlackMessage,
  ): Promise<void> {
    if (channelId !== this.config.slack.sourceChannelId || !message.ts) return;
    if (!message.bot_id) return;
    if (
      this.config.slack.ninehireBotId &&
      message.bot_id !== this.config.slack.ninehireBotId
    ) {
      return;
    }
    if (message.subtype && message.subtype !== "bot_message") return;
    const parsed = parseNinehireSlackMessage(message);
    if (parsed.eventType === "OTHER") return;
    await this.workflow.ingestSlackNotification({
      channelId,
      messageTs: message.ts,
      sourceBotId: message.bot_id,
      parsed,
    }, { deferEvaluationLookup: true });
  }

  async reconcile(): Promise<{ scanned: number; latestTs?: string }> {
    const channelId = this.config.slack.sourceChannelId;
    if (!channelId) {
      throw new Error("SLACK_SOURCE_CHANNEL_ID is not configured.");
    }
    const cursorKey = `slack:${channelId}:latest_ts`;
    const oldest = this.db.getCursor(cursorKey);
    let pageCursor: string | undefined;
    const messages: SlackMessage[] = [];

    do {
      const response = await this.client.conversations.history({
        channel: channelId,
        limit: 100,
        ...(oldest ? { oldest, inclusive: false } : {}),
        ...(pageCursor ? { cursor: pageCursor } : {}),
      });
      messages.push(...((response.messages ?? []) as SlackMessage[]));
      pageCursor = response.response_metadata?.next_cursor || undefined;
    } while (pageCursor);

    messages.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
    for (const message of messages) {
      await this.ingestMessage(channelId, message);
    }

    const latestTs = messages.at(-1)?.ts;
    if (latestTs) this.db.setCursor(cursorKey, latestTs);
    return { scanned: messages.length, ...(latestTs ? { latestTs } : {}) };
  }
}
