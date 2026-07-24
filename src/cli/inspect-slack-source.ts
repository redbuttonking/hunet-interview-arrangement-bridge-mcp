import { WebClient } from "@slack/web-api";
import { getConfig } from "../config.js";
import { parseNinehireSlackMessage } from "../slack/parser.js";

const config = getConfig();
if (!config.slack.botToken || !config.slack.sourceChannelId) {
  throw new Error(
    "SLACK_BOT_TOKEN and SLACK_SOURCE_CHANNEL_ID must be configured.",
  );
}

const client = new WebClient(config.slack.botToken);
const response = await client.conversations.history({
  channel: config.slack.sourceChannelId,
  limit: 20,
});
const summaries = (response.messages ?? []).map((message) => {
  const parsed = parseNinehireSlackMessage(message);
  return {
    ts: message.ts,
    botId: message.bot_id,
    appId: message.app_id,
    eventType: parsed.eventType,
    title: parsed.title,
  };
});
process.stdout.write(`${JSON.stringify({ messages: summaries }, null, 2)}\n`);
