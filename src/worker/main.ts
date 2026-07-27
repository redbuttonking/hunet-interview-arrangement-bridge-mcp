import { App, LogLevel } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { getConfig, requireWorkerConfig } from "../config.js";
import { BridgeDatabase } from "../db/database.js";
import {
  INTERVIEW_BRIDGE_WORKER_KEY,
  WORKER_DOWNTIME_THRESHOLD_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
} from "../domain/worker-health.js";
import {
  NinehireRecruitmentWorkflowAdapter,
} from "../ninehire/adapter.js";
import { NinehireMcpGateway } from "../ninehire/gateway.js";
import { WorkflowService, type SlackIdentityResolver } from "../services/workflow.js";
import {
  AVAILABILITY_VIEW_CALLBACK,
  DECLINE_INTERVIEW_ACTION,
  OPEN_AVAILABILITY_ACTION,
  availabilityFromViewState,
  buildAvailabilityModal,
} from "../slack/blocks.js";
import { SlackReconciler } from "../slack/reconciler.js";

const config = getConfig();
requireWorkerConfig(config);
const requestChannelId = config.slack.requestChannelId;
const db = new BridgeDatabase(config.dbPath);
const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true,
  logLevel: LogLevel.INFO,
});
const gateway = new NinehireMcpGateway(config.ninehire);
const ninehire = new NinehireRecruitmentWorkflowAdapter(gateway);

class SlackEmailIdentityResolver implements SlackIdentityResolver {
  constructor(private readonly client: WebClient) {}

  async lookupUserIdByEmail(email: string): Promise<string | undefined> {
    try {
      const result = await this.client.users.lookupByEmail({ email });
      return result.user?.id;
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

const identityResolver = new SlackEmailIdentityResolver(app.client);
const workflow = new WorkflowService(
  db,
  config,
  ninehire,
  identityResolver,
);
const reconciler = new SlackReconciler(db, config, app.client, workflow);

function actionContext(body: unknown): {
  caseId?: string;
  scheduleRound?: number;
} {
  if (!body || typeof body !== "object") return {};
  const actions = (body as { actions?: Array<{ value?: string }> }).actions;
  const value = actions?.[0]?.value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as {
      caseId?: unknown;
      scheduleRound?: unknown;
    };
    return {
      ...(typeof parsed.caseId === "string" ? { caseId: parsed.caseId } : {}),
      ...(typeof parsed.scheduleRound === "number"
        ? { scheduleRound: parsed.scheduleRound }
        : {}),
    };
  } catch {
    return { caseId: value };
  }
}

function acceptsAvailabilityResponse(
  interviewCase: { status: string; scheduleRound: number },
  scheduleRound: number | undefined,
): boolean {
  const legacyFirstRound = scheduleRound === undefined && interviewCase.scheduleRound === 1;
  const matchingRound = scheduleRound === interviewCase.scheduleRound || legacyFirstRound;
  return (
    matchingRound &&
    ["REQUEST_SENT", "COLLECTING_AVAILABILITY", "READY_TO_SCHEDULE"].includes(
      interviewCase.status,
    )
  );
}

app.message(async ({ message, context, logger }) => {
  const channelId =
    typeof message === "object" &&
    message !== null &&
    "channel" in message &&
    typeof message.channel === "string"
      ? message.channel
      : undefined;
  if (!channelId) return;
  try {
    await reconciler.ingestMessage(
      channelId,
      message as unknown as Record<string, unknown>,
    );
  } catch (error) {
    logger.error(error);
  }
});

app.action(OPEN_AVAILABILITY_ACTION, async ({ ack, body, client, respond }) => {
  await ack();
  const { caseId, scheduleRound } = actionContext(body);
  const slackUserId =
    "user" in body && body.user && "id" in body.user
      ? String(body.user.id)
      : undefined;
  const triggerId =
    "trigger_id" in body ? String(body.trigger_id) : undefined;
  if (!caseId || !slackUserId || !triggerId) return;

  const interviewCase = db.getCase(caseId);
  const interviewer = db.findActiveInterviewerBySlackUser(
    caseId,
    slackUserId,
  );
  if (
    !interviewCase ||
    !interviewer ||
    !acceptsAvailabilityResponse(interviewCase, scheduleRound)
  ) {
    await respond({
      response_type: "ephemeral",
      text:
        "이전 일정 요청이거나 현재 면접관 정보와 일치하지 않습니다. 최신 일정 요청을 확인해 주세요.",
    });
    return;
  }
  await client.views.open({
    trigger_id: triggerId,
    view: buildAvailabilityModal(interviewCase, interviewer),
  });
});

app.action(DECLINE_INTERVIEW_ACTION, async ({ ack, body, respond }) => {
  await ack();
  const { caseId, scheduleRound } = actionContext(body);
  const slackUserId =
    "user" in body && body.user && "id" in body.user
      ? String(body.user.id)
      : undefined;
  if (!caseId || !slackUserId) return;
  try {
    const interviewCase = db.getCase(caseId);
    if (!interviewCase || !acceptsAvailabilityResponse(interviewCase, scheduleRound)) {
      await respond({
        response_type: "ephemeral",
        text: "이전 일정 요청에는 응답할 수 없습니다. 최신 일정 요청을 확인해 주세요.",
      });
      return;
    }
    db.markInterviewerDeclined(caseId, slackUserId);
    await respond({
      response_type: "ephemeral",
      text:
        "참여 어려움으로 접수했습니다. 채용 담당자가 면접관 변경 또는 제외 여부를 검토합니다.",
    });
  } catch (error) {
    await respond({
      response_type: "ephemeral",
      text: error instanceof Error ? error.message : String(error),
    });
  }
});

app.view(AVAILABILITY_VIEW_CALLBACK, async ({ ack, body, view }) => {
  let metadata: {
    caseId?: string;
    slackUserId?: string;
    scheduleRound?: number;
  };
  try {
    metadata = JSON.parse(view.private_metadata) as {
      caseId?: string;
      slackUserId?: string;
      scheduleRound?: number;
    };
  } catch {
    await ack({
      response_action: "errors",
      errors: { global_all: "면접 건 정보를 읽지 못했습니다. 다시 열어주세요." },
    });
    return;
  }
  const caseId = metadata.caseId;
  const slackUserId = body.user.id;
  const interviewCase = caseId ? db.getCase(caseId) : undefined;
  if (
    !caseId ||
    !interviewCase ||
    metadata.slackUserId !== slackUserId ||
    !acceptsAvailabilityResponse(interviewCase, metadata.scheduleRound)
  ) {
    await ack({
      response_action: "errors",
      errors: { global_all: "이전 일정 요청이거나 면접관 정보가 일치하지 않습니다." },
    });
    return;
  }
  const values = view.state.values as Record<
    string,
    Record<string, unknown>
  >;
  const slots = availabilityFromViewState(interviewCase, values);
  if (slots.length === 0) {
    await ack({
      response_action: "errors",
      errors: { global_all: "가능한 시간을 한 개 이상 선택해 주세요." },
    });
    return;
  }
  db.replaceAvailability(caseId, slackUserId, slots);
  await ack();
});

app.error(async (error) => {
  process.stderr.write(`[Slack worker] ${error.stack ?? error.message}\n`);
});

let cycleRunning = false;
async function runCycle(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    await reconciler.reconcile();
    const dueBeforeRefresh = db.listDueReminders();
    const caseIds = [...new Set(dueBeforeRefresh.map((item) => item.caseId))];
    for (const caseId of caseIds) {
      await workflow.syncCaseInterviewers(caseId);
    }
    for (const reminder of db.listDueReminders()) {
      const ordinal = reminder.reminderNumber === 1 ? "1차" : "2차(최종)";
      await app.client.chat.postMessage({
        channel: requestChannelId,
        text: `<@${reminder.slackUserId}> 인터뷰 가능 일정 입력 ${ordinal} 리마인드입니다. 기존 요청 메시지의 [가능 일정 입력] 버튼을 눌러 주세요.`,
      });
      db.markReminderSent(reminder.id);
    }
    db.recordWorkerCycleSuccess(INTERVIEW_BRIDGE_WORKER_KEY);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    db.recordWorkerCycleFailure(INTERVIEW_BRIDGE_WORKER_KEY, message);
    process.stderr.write(`[Worker cycle] ${message}\n`);
  } finally {
    cycleRunning = false;
  }
}

await app.start();
const workerStart = db.registerWorkerStart({
  workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
  downtimeThresholdMs: WORKER_DOWNTIME_THRESHOLD_MS,
});
if (workerStart.downtime) {
  const recovery = workflow.createWorkerDowntimeReviews(workerStart.downtime);
  process.stdout.write(
    `Worker downtime detected. Impacted availability cases: ${recovery.impactedCaseIds.length}\n`,
  );
}
process.stdout.write(
  `Interview bridge worker started. Reconciliation interval: ${config.pollIntervalMs}ms\n`,
);
const heartbeatInterval = setInterval(
  () => db.recordWorkerHeartbeat(INTERVIEW_BRIDGE_WORKER_KEY),
  WORKER_HEARTBEAT_INTERVAL_MS,
);
await runCycle();
const interval = setInterval(() => void runCycle(), config.pollIntervalMs);

async function shutdown(signal: string): Promise<void> {
  clearInterval(interval);
  clearInterval(heartbeatInterval);
  process.stdout.write(`Received ${signal}; stopping worker.\n`);
  await app.stop();
  db.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
