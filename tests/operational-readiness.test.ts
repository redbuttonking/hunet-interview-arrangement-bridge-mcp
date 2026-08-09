// 로컬 설정과 선택적 외부 연결 사전점검 결과를 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { BridgeDatabase } from "../src/db/database.js";
import { INTERVIEW_BRIDGE_WORKER_KEY } from "../src/domain/worker-health.js";
import { OperationalReadinessService } from "../src/services/operational-readiness.js";

let db: BridgeDatabase | undefined;

afterEach(() => db?.close());

const config: AppConfig = {
  dbPath: ":memory:",
  pollIntervalMs: 300_000,
  timeZone: "Asia/Seoul",
  daouOffice: {
    url: "https://hug.hunet.co.kr/app/asset",
    browserProfileDir: "C:/temp/daou-profile",
    remoteDebugPort: 9222,
    edgeExecutablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  },
  slack: {
    appToken: "xapp-test",
    botToken: "xoxb-test",
    sourceChannelId: "C1",
    requestChannelId: "C2",
  },
  ninehire: {
    url: "https://example.invalid/mcp",
    apiKey: "test-key",
    authHeader: "Authorization",
    authScheme: "Bearer",
    timeoutMs: 30_000,
  },
};

describe("operational readiness", () => {
  it("checks only local state unless external checks are explicitly requested", async () => {
    db = new BridgeDatabase(":memory:");
    db.registerWorkerStart({ workerKey: INTERVIEW_BRIDGE_WORKER_KEY });
    db.setCursor("slack:C1:latest_ts", "100.0");
    let slackAuthCalls = 0;
    let ninehireCalls = 0;
    const service = new OperationalReadinessService(
      config,
      db,
      {
        isConfigured: () => true,
        async listTools() {
          ninehireCalls += 1;
          return [{ name: "get_recruitment" }];
        },
      },
      {
        async status() {
          return {
            connected: true,
            profileDir: "C:/temp/daou-profile",
            debugUrl: "http://127.0.0.1:9222",
          };
        },
      },
      {
        auth: {
          async test() {
            slackAuthCalls += 1;
            return {};
          },
        },
      },
    );

    const local = await service.inspect();

    expect(local).toMatchObject({
      overallStatus: "READY",
      externalChecks: { performed: false, checks: { slack: { status: "NOT_RUN" } } },
      checks: { slack: { latestReconciledMessage: { value: "100.0" } } },
    });
    expect(slackAuthCalls).toBe(0);
    expect(ninehireCalls).toBe(0);

    const external = await service.inspect({ checkExternal: true });

    expect(external).toMatchObject({
      overallStatus: "READY",
      externalChecks: {
        performed: true,
        checks: {
          slack: { status: "READY" },
          ninehire: { status: "READY", availableToolCount: 1 },
        },
      },
    });
    expect(slackAuthCalls).toBe(1);
    expect(ninehireCalls).toBe(1);
  });

  it("finishes an external check when a provider does not respond", async () => {
    db = new BridgeDatabase(":memory:");
    const service = new OperationalReadinessService(
      config,
      db,
      {
        isConfigured: () => true,
        async listTools() {
          return [];
        },
      },
      {
        async status() {
          return {
            connected: true,
            profileDir: "C:/temp/daou-profile",
            debugUrl: "http://127.0.0.1:9222",
          };
        },
      },
      {
        auth: {
          async test() {
            return await new Promise<unknown>(() => undefined);
          },
        },
      },
      10,
    );

    const result = await service.inspect({ checkExternal: true });

    expect(result.externalChecks.checks.slack).toMatchObject({
      status: "ATTENTION",
      reason: "AUTH_TEST_TIMEOUT",
    });
    expect(result.externalChecks.checks.ninehire).toMatchObject({
      status: "READY",
    });
  });
});
