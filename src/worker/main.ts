import { App, LogLevel } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { randomUUID } from "node:crypto";
import { getConfig, requireWorkerConfig } from "../config.js";
import { BridgeDatabase } from "../db/database.js";
import {
  INTEGRATION_RETRY_POLL_INTERVAL_MS,
} from "../domain/integration-retry.js";
import {
  INTERVIEW_BRIDGE_WORKER_KEY,
  WORKER_DOWNTIME_THRESHOLD_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_LEASE_DURATION_MS,
} from "../domain/worker-health.js";
import {
  NinehireRecruitmentWorkflowAdapter,
} from "../ninehire/adapter.js";
import { NinehireMcpGateway } from "../ninehire/gateway.js";
import { BrowserDaouOfficeReservationAdapter } from "../daou-office/adapter.js";
import { DaouOfficeBrowserController } from "../daou-office/browser.js";
import { WorkflowService, type SlackIdentityResolver } from "../services/workflow.js";
import { LocalDatabaseBackupService } from "../services/database-backup.js";
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
  clientOptions: { timeout: 30_000 },
  logLevel: LogLevel.INFO,
});
const gateway = new NinehireMcpGateway(config.ninehire);
const ninehire = new NinehireRecruitmentWorkflowAdapter(gateway);
const daouOffice = new BrowserDaouOfficeReservationAdapter(config.daouOffice);
const daouOfficeBrowser = new DaouOfficeBrowserController(config.daouOffice);

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
const databaseBackup = new LocalDatabaseBackupService(db, config.dbPath, {
  timeZone: config.timeZone,
});
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
        errors: { global_all: "인터뷰 건 정보를 읽지 못했습니다. 다시 열어주세요." },
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
let retryCycleRunning = false;
const slackReconciliationDedupeKey = config.slack.sourceChannelId;
const ninehireScheduleReconciliationDedupeKey = "NINEHIRE_CONFIRMED_SCHEDULE_RECONCILIATION";
const daouCalendarReconciliationDedupeKey = "DAOU_CALENDAR_RECONCILIATION";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function ensureDailyDatabaseBackup(): Promise<void> {
  try {
    const result = await databaseBackup.ensureDailyBackup();
    if (result.created) {
      process.stdout.write(`Database backup created: ${result.backupPath}\n`);
    }
  } catch (error) {
    process.stderr.write(`[Database backup] ${errorMessage(error)}\n`);
  }
}

async function reconcileSlackNotifications(): Promise<void> {
  try {
    await reconciler.reconcile();
    db.setCursor("sync:slack:last_success", new Date().toISOString());
    db.completePendingIntegrationRetryByDedupeKey(
      "SLACK_NOTIFICATION_RECONCILIATION",
      slackReconciliationDedupeKey,
    );
  } catch (error) {
    const message = errorMessage(error);
    db.enqueueIntegrationRetry({
      jobType: "SLACK_NOTIFICATION_RECONCILIATION",
      dedupeKey: slackReconciliationDedupeKey,
      payload: {},
    });
    throw new Error(`Slack notification reconciliation failed: ${message}`);
  }
}

async function reconcileNinehireConfirmedSchedules(): Promise<void> {
  try {
    await workflow.reconcileNinehireConfirmedSchedules();
    db.setCursor("sync:ninehire:last_success", new Date().toISOString());
    db.completePendingIntegrationRetryByDedupeKey(
      "NINEHIRE_SCHEDULE_RECONCILIATION",
      ninehireScheduleReconciliationDedupeKey,
    );
  } catch (error) {
    const message = errorMessage(error);
    db.enqueueIntegrationRetry({
      jobType: "NINEHIRE_SCHEDULE_RECONCILIATION",
      dedupeKey: ninehireScheduleReconciliationDedupeKey,
      payload: {},
    });
    throw new Error(`NineHire confirmed-schedule reconciliation failed: ${message}`);
  }
}

async function reconcileDaouCalendarConfirmedSchedules(): Promise<void> {
  const browserStatus = await daouOfficeBrowser.status();
  if (!browserStatus.connected) return;
  try {
    await workflow.reconcileDaouCalendarConfirmedSchedules(daouOffice);
    db.setCursor("sync:daou_calendar:last_success", new Date().toISOString());
    db.completePendingIntegrationRetryByDedupeKey(
      "DAOU_CALENDAR_RECONCILIATION",
      daouCalendarReconciliationDedupeKey,
    );
  } catch (error) {
    const message = errorMessage(error);
    db.enqueueIntegrationRetry({
      jobType: "DAOU_CALENDAR_RECONCILIATION",
      dedupeKey: daouCalendarReconciliationDedupeKey,
      payload: {},
    });
    throw new Error(`DaouOffice calendar reconciliation failed: ${message}`);
  }
}

async function runIntegrationRetryCycle(): Promise<void> {
  if (retryCycleRunning || cycleRunning) return;
  if (!db.renewWorkerLease({
    workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
    ownerToken: workerOwnerToken,
    leaseDurationMs: WORKER_LEASE_DURATION_MS,
  })) {
    return;
  }
  retryCycleRunning = true;
  let failure: string | undefined;
  try {
    const jobs = db.listIntegrationRetryJobs({
      status: "PENDING",
      dueBefore: new Date(),
      limit: 20,
    });
    for (const job of jobs) {
      try {
        if (job.jobType === "SLACK_NOTIFICATION_RECONCILIATION") {
          await reconciler.reconcile();
          db.setCursor("sync:slack:last_success", new Date().toISOString());
        } else if (job.jobType === "NINEHIRE_SCHEDULE_RECONCILIATION") {
          await workflow.reconcileNinehireConfirmedSchedules();
          db.setCursor("sync:ninehire:last_success", new Date().toISOString());
        } else if (job.jobType === "DAOU_CALENDAR_RECONCILIATION") {
          await reconcileDaouCalendarConfirmedSchedules();
        } else {
          await workflow.processIntegrationRetryJob(job);
        }
        db.completeIntegrationRetryJob(job.id);
      } catch (error) {
        const message = errorMessage(error);
        const failed = db.failIntegrationRetryJob(job.id, message);
        if (failed.status === "FAILED") {
          workflow.handleIntegrationRetryExhausted(failed);
        }
        failure ??= message;
      }
    }
    if (failure) {
      db.recordWorkerCycleFailure(INTERVIEW_BRIDGE_WORKER_KEY, failure, new Date(), workerOwnerToken);
      process.stderr.write(`[Integration retry] ${failure}\n`);
    } else if (jobs.length > 0) {
      db.recordWorkerCycleSuccess(INTERVIEW_BRIDGE_WORKER_KEY, new Date(), workerOwnerToken);
    }
  } finally {
    retryCycleRunning = false;
  }
}

async function runCycle(): Promise<void> {
  if (cycleRunning || retryCycleRunning) return;
  if (!db.renewWorkerLease({
    workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
    ownerToken: workerOwnerToken,
    leaseDurationMs: WORKER_LEASE_DURATION_MS,
  })) {
    return;
  }
  cycleRunning = true;
  const failures: string[] = [];
  const runStep = async (label: string, step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (error) {
      failures.push(`${label}: ${errorMessage(error)}`);
    }
  };
  try {
    await ensureDailyDatabaseBackup();
    await runStep("Slack 동기화", reconcileSlackNotifications);
    await runStep("나인하이어 일정 동기화", reconcileNinehireConfirmedSchedules);
    await runStep("다우오피스 캘린더 동기화", reconcileDaouCalendarConfirmedSchedules);
    const dueBeforeRefresh = db.listDueReminders();
    const caseIds = [...new Set(dueBeforeRefresh.map((item) => item.caseId))];
    for (const caseId of caseIds) {
      await runStep(`면접관 동기화 ${caseId}`, () => workflow.syncCaseInterviewers(caseId));
    }
    for (const reminder of db.listDueReminders()) {
      await runStep(`리마인드 발송 ${reminder.id}`, async () => {
        if (!db.renewWorkerLease({
          workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
          ownerToken: workerOwnerToken,
          leaseDurationMs: WORKER_LEASE_DURATION_MS,
        })) {
          throw new Error("워커 임대를 잃어 리마인드 발송을 중단했습니다.");
        }
        if (!db.claimReminder(reminder.id)) return;
        const ordinal = reminder.reminderNumber === 1 ? "1차" : "2차(최종)";
        try {
          await app.client.chat.postMessage({
            channel: requestChannelId,
            text: `<@${reminder.slackUserId}> 인터뷰 가능 일정 입력 ${ordinal} 리마인드입니다. 기존 요청 메시지의 [가능 일정 입력] 버튼을 눌러 주세요.`,
          });
          db.markReminderSent(reminder.id);
        } catch (error) {
          db.releaseReminder(reminder.id);
          throw error;
        }
      });
    }
    if (failures.length > 0) {
      throw new Error(failures.join(" | "));
    }
    db.recordWorkerCycleSuccess(INTERVIEW_BRIDGE_WORKER_KEY, new Date(), workerOwnerToken);
  } catch (error) {
    const message = errorMessage(error);
    db.recordWorkerCycleFailure(INTERVIEW_BRIDGE_WORKER_KEY, message, new Date(), workerOwnerToken);
    process.stderr.write(`[Worker cycle] ${message}\n`);
  } finally {
    cycleRunning = false;
  }
}

const workerOwnerToken = randomUUID();
const workerStart = db.acquireWorkerLease({
  workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
  ownerToken: workerOwnerToken,
  leaseDurationMs: WORKER_LEASE_DURATION_MS,
  downtimeThresholdMs: WORKER_DOWNTIME_THRESHOLD_MS,
});
if (!workerStart.acquired) {
  process.stderr.write(
    "Another interview bridge worker already owns the active lease. This process will stop.\n",
  );
  db.close();
} else {
try {
  await app.start();
} catch (error) {
  db.releaseWorkerLease(INTERVIEW_BRIDGE_WORKER_KEY, workerOwnerToken);
  db.close();
  throw error;
}
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
  () => {
    const renewed = db.renewWorkerLease({
      workerKey: INTERVIEW_BRIDGE_WORKER_KEY,
      ownerToken: workerOwnerToken,
      leaseDurationMs: WORKER_LEASE_DURATION_MS,
    });
    if (!renewed) {
      process.stderr.write("Worker lease was lost. Stopping the worker.\n");
      void shutdown("worker lease lost");
    }
  },
  WORKER_HEARTBEAT_INTERVAL_MS,
);
await runCycle();
const interval = setInterval(() => void runCycle(), config.pollIntervalMs);
const retryInterval = setInterval(
  () => void runIntegrationRetryCycle(),
  INTEGRATION_RETRY_POLL_INTERVAL_MS,
);
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(interval);
  clearInterval(retryInterval);
  clearInterval(heartbeatInterval);
  process.stdout.write(`Received ${signal}; stopping worker.\n`);
  await app.stop();
  db.releaseWorkerLease(INTERVIEW_BRIDGE_WORKER_KEY, workerOwnerToken);
  db.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
