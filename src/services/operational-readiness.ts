// 로컬 인터뷰 브릿지의 연결 설정과 운영 준비 상태를 점검한다.
import type { AppConfig } from "../config.js";
import { BridgeDatabase } from "../db/database.js";
import {
  INTERVIEW_BRIDGE_WORKER_KEY,
  WORKER_DOWNTIME_THRESHOLD_MS,
} from "../domain/worker-health.js";

interface DaouOfficeBrowserStatusProvider {
  status(): Promise<{
    connected: boolean;
    profileDir: string;
    debugUrl: string;
  }>;
}

interface SlackAuthClient {
  auth: {
    test(): Promise<unknown>;
  };
}

interface NinehireGateway {
  isConfigured(): boolean;
  listTools(): Promise<unknown[]>;
}

type CheckStatus = "READY" | "ATTENTION" | "BLOCKED" | "NOT_RUN";

function workerStatus(
  health: ReturnType<BridgeDatabase["getWorkerHealth"]>,
): "RUNNING" | "STALE" | "DEGRADED" | "UNKNOWN" {
  if (!health) return "UNKNOWN";
  if (Date.now() - Date.parse(health.lastHeartbeatAt) > WORKER_DOWNTIME_THRESHOLD_MS) {
    return "STALE";
  }
  return health.lastErrorMessage ? "DEGRADED" : "RUNNING";
}

export class OperationalReadinessService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: BridgeDatabase,
    private readonly ninehire: NinehireGateway,
    private readonly daouOfficeBrowser: DaouOfficeBrowserStatusProvider,
    private readonly slackClient?: SlackAuthClient,
  ) {}

  async inspect(input: { checkExternal?: boolean } = {}) {
    const checkExternal = input.checkExternal === true;
    const missingSlackConfiguration = [
      ["SLACK_APP_TOKEN", this.config.slack.appToken],
      ["SLACK_BOT_TOKEN", this.config.slack.botToken],
      ["SLACK_SOURCE_CHANNEL_ID", this.config.slack.sourceChannelId],
      ["SLACK_REQUEST_CHANNEL_ID", this.config.slack.requestChannelId],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    const health = this.db.getWorkerHealth(INTERVIEW_BRIDGE_WORKER_KEY);
    const currentWorkerStatus = workerStatus(health);
    const sourceCursor = this.config.slack.sourceChannelId
      ? this.db.getCursorInfo(`slack:${this.config.slack.sourceChannelId}:latest_ts`)
      : undefined;
    const daouOffice = await this.daouOfficeBrowser.status();
    const checks: Record<string, Record<string, unknown>> = {
      localDatabase: {
        status: "READY" satisfies CheckStatus,
        schemaVersion: this.db.getLatestSchemaVersion(),
        ...this.db.getStatus(),
      },
      slack: {
        status: missingSlackConfiguration.length === 0 ? "READY" : "BLOCKED",
        missingConfiguration: missingSlackConfiguration,
        latestReconciledMessage: sourceCursor ?? null,
      },
      ninehire: {
        status: this.ninehire.isConfigured() ? "READY" : "BLOCKED",
        configured: this.ninehire.isConfigured(),
      },
      worker: {
        status: currentWorkerStatus,
        lastStartedAt: health?.lastStartedAt ?? null,
        lastHeartbeatAt: health?.lastHeartbeatAt ?? null,
        lastSuccessfulCycleAt: health?.lastSuccessfulCycleAt ?? null,
        lastErrorMessage: health?.lastErrorMessage ?? null,
      },
      daouOfficeBrowser: {
        status: daouOffice.connected ? "READY" : "ATTENTION",
        connected: daouOffice.connected,
        profileDir: daouOffice.profileDir,
        debugUrl: daouOffice.debugUrl,
        latestMeetingRoomSyncAt: this.db.getLatestMeetingRoomSyncAt() ?? null,
        loginVerified: false,
      },
    };

    const external: Record<string, Record<string, unknown>> = {
      slack: { status: "NOT_RUN" satisfies CheckStatus },
      ninehire: { status: "NOT_RUN" satisfies CheckStatus },
    };
    if (checkExternal) {
      if (this.slackClient && missingSlackConfiguration.length === 0) {
        try {
          await this.slackClient.auth.test();
          external.slack = { status: "READY" satisfies CheckStatus };
        } catch {
          external.slack = { status: "ATTENTION" satisfies CheckStatus, reason: "AUTH_TEST_FAILED" };
        }
      } else {
        external.slack = { status: "BLOCKED" satisfies CheckStatus, reason: "MISSING_CONFIGURATION" };
      }
      if (this.ninehire.isConfigured()) {
        try {
          const tools = await this.ninehire.listTools();
          external.ninehire = {
            status: "READY" satisfies CheckStatus,
            availableToolCount: tools.length,
          };
        } catch {
          external.ninehire = { status: "ATTENTION" satisfies CheckStatus, reason: "TOOL_LIST_FAILED" };
        }
      } else {
        external.ninehire = { status: "BLOCKED" satisfies CheckStatus, reason: "MISSING_CONFIGURATION" };
      }
    }

    const nextActions: string[] = [];
    if (missingSlackConfiguration.length > 0) nextActions.push("CONFIGURE_SLACK");
    if (!this.ninehire.isConfigured()) nextActions.push("CONFIGURE_NINEHIRE");
    if (currentWorkerStatus !== "RUNNING") nextActions.push("RESTART_OR_INSPECT_WORKER");
    if (!daouOffice.connected) nextActions.push("OPEN_DAOU_OFFICE_LOGIN");
    if (checkExternal && external.slack?.status !== "READY") nextActions.push("CHECK_SLACK_CONNECTION");
    if (checkExternal && external.ninehire?.status !== "READY") nextActions.push("CHECK_NINEHIRE_CONNECTION");
    const hasBlocked =
      missingSlackConfiguration.length > 0 ||
      !this.ninehire.isConfigured();
    const hasAttention =
      currentWorkerStatus !== "RUNNING" ||
      (checkExternal && Object.values(external).some((check) => check.status === "ATTENTION"));

    return {
      overallStatus: hasBlocked ? "BLOCKED" : hasAttention ? "ATTENTION" : "READY",
      checkedAt: new Date().toISOString(),
      checks,
      externalChecks: {
        performed: checkExternal,
        checks: external,
      },
      nextActions,
    };
  }
}
