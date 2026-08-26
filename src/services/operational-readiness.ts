// 로컬 인터뷰 브릿지의 연결 설정과 운영 준비 상태를 점검한다.
import type { AppConfig } from "../config.js";
import { BridgeDatabase } from "../db/database.js";
import {
  INTERVIEW_BRIDGE_WORKER_KEY,
  WORKER_DOWNTIME_THRESHOLD_MS,
} from "../domain/worker-health.js";
import {
  isNinehireRateLimitError,
  NINEHIRE_RATE_LIMIT_UNTIL_CURSOR,
} from "../domain/integration-retry.js";

interface BrowserStatusProvider {
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
  listTools(input?: { timeoutMs?: number }): Promise<unknown[]>;
}

type CheckStatus = "READY" | "ATTENTION" | "BLOCKED" | "NOT_RUN";

const EXTERNAL_CHECK_TIMEOUT = "EXTERNAL_CHECK_TIMEOUT";

function hasRecentWorkerSync(
  sync: { value: string; updatedAt: string } | undefined,
  workerState: ReturnType<typeof workerStatus>,
  pollIntervalMs: number,
): boolean {
  if (!sync || workerState !== "RUNNING") return false;
  const syncedAt = Date.parse(sync.updatedAt);
  if (Number.isNaN(syncedAt)) return false;
  return Date.now() - syncedAt <= Math.max(pollIntervalMs * 2, 120_000);
}

function useRecentWorkerSyncWhenDirectCheckFails(
  check: { status: string; reason?: string },
  sync: { value: string; updatedAt: string } | undefined,
  workerState: ReturnType<typeof workerStatus>,
  pollIntervalMs: number,
) {
  if (check.reason === "RATE_LIMIT_COOLDOWN") return check;
  if (
    check.status !== "ATTENTION"
    || !hasRecentWorkerSync(sync, workerState, pollIntervalMs)
  ) {
    return check;
  }
  return {
    ...check,
    status: "READY" satisfies CheckStatus,
    verification: "RECENT_WORKER_SYNC",
    lastSuccessfulSyncAt: sync!.updatedAt,
    directCheckStatus: check.status,
    directCheckReason: check.reason,
  };
}

async function withExternalCheckTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(EXTERNAL_CHECK_TIMEOUT)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function workerStatus(
  health: ReturnType<BridgeDatabase["getWorkerHealth"]>,
): "RUNNING" | "STALE" | "DEGRADED" | "UNKNOWN" {
  if (!health) return "UNKNOWN";
  const heartbeatTimestamp = Date.parse(health.lastHeartbeatAt);
  if (Number.isNaN(heartbeatTimestamp)) return "UNKNOWN";
  const leaseTimestamp = health.leaseExpiresAt
    ? Date.parse(health.leaseExpiresAt)
    : Number.NaN;
  if (
    (!Number.isNaN(leaseTimestamp) && leaseTimestamp <= Date.now()) ||
    Date.now() - heartbeatTimestamp > WORKER_DOWNTIME_THRESHOLD_MS
  ) {
    return "STALE";
  }
  return health.lastErrorMessage ? "DEGRADED" : "RUNNING";
}

export class OperationalReadinessService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: BridgeDatabase,
    private readonly ninehire: NinehireGateway,
    private readonly daouOfficeBrowser: BrowserStatusProvider,
    private readonly ninehireBrowser: BrowserStatusProvider,
    private readonly slackClient?: SlackAuthClient,
    private readonly externalCheckTimeoutMs = 8_000,
  ) {}

  async inspect(input: { checkExternal?: boolean } = {}) {
    const checkExternal = input.checkExternal === true;
    const missingSlackConfiguration = [
      ["SLACK_APP_TOKEN", this.config.slack.appToken],
      ["SLACK_BOT_TOKEN", this.config.slack.botToken],
      ["SLACK_SOURCE_CHANNEL_ID", this.config.slack.sourceChannelId],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    const health = this.db.getWorkerHealth(INTERVIEW_BRIDGE_WORKER_KEY);
    const currentWorkerStatus = workerStatus(health);
    const sourceCursor = this.config.slack.sourceChannelId
      ? this.db.getCursorInfo(`slack:${this.config.slack.sourceChannelId}:latest_ts`)
      : undefined;
    const daouOffice = await this.daouOfficeBrowser.status();
    const ninehireBrowser = await this.ninehireBrowser.status();
    const slackSync = this.db.getCursorInfo("sync:slack:last_success");
    const ninehireSync = this.db.getCursorInfo("sync:ninehire:last_success");
    const ninehireRateLimitUntilTimestamp = Date.parse(
      this.db.getCursor(NINEHIRE_RATE_LIMIT_UNTIL_CURSOR) ?? "",
    );
    const ninehireRateLimitUntil = Number.isFinite(ninehireRateLimitUntilTimestamp)
      && ninehireRateLimitUntilTimestamp > Date.now()
      ? new Date(ninehireRateLimitUntilTimestamp)
      : undefined;
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
        rateLimitUntil: ninehireRateLimitUntil?.toISOString() ?? null,
      },
      worker: {
        status: currentWorkerStatus,
        lastStartedAt: health?.lastStartedAt ?? null,
        lastHeartbeatAt: health?.lastHeartbeatAt ?? null,
        leaseExpiresAt: health?.leaseExpiresAt ?? null,
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
      ninehireBrowser: {
        status: ninehireBrowser.connected ? "READY" : "ATTENTION",
        connected: ninehireBrowser.connected,
        profileDir: ninehireBrowser.profileDir,
        debugUrl: ninehireBrowser.debugUrl,
        loginVerified: false,
      },
    };

    const external: Record<string, Record<string, unknown>> = {
      slack: { status: "NOT_RUN" satisfies CheckStatus },
      ninehire: { status: "NOT_RUN" satisfies CheckStatus },
    };
    if (checkExternal) {
      const [slackCheck, ninehireCheck] = await Promise.all([
        (async () => {
          if (!this.slackClient || missingSlackConfiguration.length > 0) {
            return { status: "BLOCKED" satisfies CheckStatus, reason: "MISSING_CONFIGURATION" };
          }
          try {
            await withExternalCheckTimeout(
              this.slackClient.auth.test(),
              this.externalCheckTimeoutMs,
            );
            return { status: "READY" satisfies CheckStatus };
          } catch (error) {
            return {
              status: "ATTENTION" satisfies CheckStatus,
              reason:
                error instanceof Error && error.message === EXTERNAL_CHECK_TIMEOUT
                  ? "AUTH_TEST_TIMEOUT"
                  : "AUTH_TEST_FAILED",
            };
          }
        })(),
        (async () => {
          if (!this.ninehire.isConfigured()) {
            return { status: "BLOCKED" satisfies CheckStatus, reason: "MISSING_CONFIGURATION" };
          }
          if (ninehireRateLimitUntil) {
            return {
              status: "ATTENTION" satisfies CheckStatus,
              reason: "RATE_LIMIT_COOLDOWN",
              retryAfter: ninehireRateLimitUntil.toISOString(),
            };
          }
          try {
            const tools = await withExternalCheckTimeout(
              this.ninehire.listTools({ timeoutMs: this.externalCheckTimeoutMs }),
              this.externalCheckTimeoutMs,
            );
            return {
              status: "READY" satisfies CheckStatus,
              availableToolCount: tools.length,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (isNinehireRateLimitError(message)) {
              const retryAfter = new Date(
                Date.now() + (this.config.ninehire.evaluationRateLimitCooldownMs ?? 15 * 60_000),
              );
              this.db.setCursor(NINEHIRE_RATE_LIMIT_UNTIL_CURSOR, retryAfter.toISOString());
              return {
                status: "ATTENTION" satisfies CheckStatus,
                reason: "RATE_LIMIT_COOLDOWN",
                retryAfter: retryAfter.toISOString(),
              };
            }
            return {
              status: "ATTENTION" satisfies CheckStatus,
              reason:
                error instanceof Error && error.message === EXTERNAL_CHECK_TIMEOUT
                  ? "TOOL_LIST_TIMEOUT"
                  : "TOOL_LIST_FAILED",
            };
          }
        })(),
      ]);
      external.slack = useRecentWorkerSyncWhenDirectCheckFails(
        slackCheck,
        slackSync,
        currentWorkerStatus,
        this.config.pollIntervalMs,
      );
      external.ninehire = useRecentWorkerSyncWhenDirectCheckFails(
        ninehireCheck,
        ninehireSync,
        currentWorkerStatus,
        this.config.pollIntervalMs,
      );
    }

    const nextActions: string[] = [];
    if (missingSlackConfiguration.length > 0) nextActions.push("CONFIGURE_SLACK");
    if (!this.ninehire.isConfigured()) nextActions.push("CONFIGURE_NINEHIRE");
    if (currentWorkerStatus !== "RUNNING") nextActions.push("RESTART_OR_INSPECT_WORKER");
    if (!daouOffice.connected) nextActions.push("OPEN_DAOU_OFFICE_LOGIN");
    if (!ninehireBrowser.connected) nextActions.push("OPEN_NINEHIRE_LOGIN");
    if (checkExternal && external.slack?.status !== "READY") nextActions.push("CHECK_SLACK_CONNECTION");
    if (
      checkExternal
      && external.ninehire?.status !== "READY"
      && external.ninehire?.reason !== "RATE_LIMIT_COOLDOWN"
    ) {
      nextActions.push("CHECK_NINEHIRE_CONNECTION");
    }
    const hasBlocked =
      missingSlackConfiguration.length > 0 ||
      !this.ninehire.isConfigured();
    const hasAttention =
      currentWorkerStatus !== "RUNNING" ||
      !daouOffice.connected ||
      !ninehireBrowser.connected ||
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
