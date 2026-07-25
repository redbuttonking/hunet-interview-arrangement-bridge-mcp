import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";

export interface AppConfig {
  dbPath: string;
  pollIntervalMs: number;
  timeZone: string;
  daouOffice: {
    url: string;
    browserProfileDir: string;
    remoteDebugPort: number;
    edgeExecutablePath: string;
  };
  slack: {
    appToken?: string;
    botToken?: string;
    sourceChannelId?: string;
    requestChannelId?: string;
    ninehireBotId?: string;
  };
  ninehire: {
    url: string;
    apiKey?: string;
    authHeader: string;
    authScheme: string;
  };
}

let envLoaded = false;

export function loadLocalEnv(envPath = resolve(".env")): void {
  if (envLoaded) return;
  if (existsSync(envPath)) {
    loadEnvFile(envPath);
  }
  envLoaded = true;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function port(name: string, fallback: number): number {
  const value = positiveInteger(name, fallback);
  if (value > 65_535) {
    throw new Error(`${name} must be between 1 and 65535.`);
  }
  return value;
}

export function getConfig(): AppConfig {
  loadLocalEnv();
  const dbPath = resolve(optional("BRIDGE_DB_PATH") ?? "./data/bridge.db");
  mkdirSync(dirname(dbPath), { recursive: true });

  return {
    dbPath,
    pollIntervalMs: positiveInteger("BRIDGE_POLL_INTERVAL_MS", 300_000),
    timeZone: optional("BRIDGE_TIME_ZONE") ?? "Asia/Seoul",
    daouOffice: {
      url: optional("DAOU_OFFICE_URL") ?? "https://hug.hunet.co.kr/app/asset",
      browserProfileDir: resolve(
        optional("DAOU_BROWSER_PROFILE_DIR") ?? "./data/daou-office-profile",
      ),
      remoteDebugPort: port("DAOU_BROWSER_REMOTE_DEBUG_PORT", 9222),
      edgeExecutablePath:
        optional("DAOU_EDGE_EXECUTABLE_PATH") ??
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    },
    slack: {
      appToken: optional("SLACK_APP_TOKEN"),
      botToken: optional("SLACK_BOT_TOKEN"),
      sourceChannelId: optional("SLACK_SOURCE_CHANNEL_ID"),
      requestChannelId: optional("SLACK_REQUEST_CHANNEL_ID"),
      ninehireBotId: optional("SLACK_NINEHIRE_BOT_ID"),
    },
    ninehire: {
      url:
        optional("NINEHIRE_MCP_URL") ??
        "https://api.ninehire.com/developer/mcp",
      apiKey: optional("NINEHIRE_MCP_API_KEY"),
      authHeader: optional("NINEHIRE_MCP_AUTH_HEADER") ?? "Authorization",
      authScheme:
        process.env.NINEHIRE_MCP_AUTH_SCHEME === undefined
          ? "Bearer"
          : process.env.NINEHIRE_MCP_AUTH_SCHEME.trim(),
    },
  };
}

export function requireWorkerConfig(config: AppConfig): asserts config is AppConfig & {
  slack: {
    appToken: string;
    botToken: string;
    sourceChannelId: string;
    requestChannelId: string;
    ninehireBotId?: string;
  };
} {
  const missing = [
    ["SLACK_APP_TOKEN", config.slack.appToken],
    ["SLACK_BOT_TOKEN", config.slack.botToken],
    ["SLACK_SOURCE_CHANNEL_ID", config.slack.sourceChannelId],
    ["SLACK_REQUEST_CHANNEL_ID", config.slack.requestChannelId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing worker configuration: ${missing.join(", ")}`);
  }
}
