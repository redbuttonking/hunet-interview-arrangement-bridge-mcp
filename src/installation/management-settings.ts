// 설치형 인터뷰 운영 앱의 사용자별 설정과 Codex MCP 연결 정보를 관리한다.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getApplicationRoot, getConfig, getLocalEnvPath } from "../config.js";
import { BridgeDatabase } from "../db/database.js";
import { NinehireRecruitmentWorkflowAdapter } from "../ninehire/adapter.js";
import { NinehireMcpGateway } from "../ninehire/gateway.js";

const execFileAsync = promisify(execFile);
const WORKER_TASK_NAME = "Hunet Interview Ops Worker";

export type ManagementSettings = {
  slackSourceChannelId: string;
  recruitmentChannels: RecruitmentChannelMapping[];
  workerRestartRequired: boolean;
  codex: {
    installed: boolean;
    connected: boolean;
  };
};

export type RecruitmentChannelMapping = {
  recruitmentId: string;
  recruitmentName: string;
  channelId: string;
};

export type InProgressRecruitment = {
  recruitmentId: string;
  recruitmentName: string;
};

export type ManagementSettingsInput = {
  slackSourceChannelId: string;
};

export type RecruitmentChannelMappingInput = {
  recruitmentId: string;
  recruitmentName: string;
  channelId: string;
};

function valueFromEnv(source: string, key: string): string {
  const line = source
    .split(/\r?\n/u)
    .find((item) => item.trimStart().startsWith(`${key}=`));
  return line ? line.slice(line.indexOf("=") + 1).trim() : "";
}

function assertSlackChannelId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[CG][A-Z0-9]{8,}$/u.test(normalized)) {
    throw new Error(`${label}은 Slack 채널 ID 형식으로 입력해 주세요.`);
  }
  return normalized;
}

export function updateEnvValues(
  source: string,
  values: Record<string, string>,
): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/u);

  for (const [key, value] of Object.entries(values)) {
    const lineIndex = lines.findIndex((line) => line.trimStart().startsWith(`${key}=`));
    const nextLine = `${key}=${value}`;
    if (lineIndex >= 0) {
      lines[lineIndex] = nextLine;
    } else {
      if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
      lines.push(nextLine);
    }
  }

  return lines.join(newline);
}

function codexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return join(codexHome || join(homedir(), ".codex"), "config.toml");
}

function tomlValue(value: string): string {
  return value.replaceAll("\\", "/").replaceAll('"', '\\"');
}

export function upsertCodexMcpServerConfig(source: string, applicationRoot: string): string {
  const header = "[mcp_servers.interview_bridge]";
  const block = [
    header,
    "enabled = true",
    "required = true",
    `command = "${tomlValue(join(applicationRoot, "runtime", "node.exe"))}"`,
    'args = ["dist/src/mcp/main.js"]',
    `cwd = "${tomlValue(applicationRoot)}"`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 120.0",
  ];
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === header);
  if (startIndex < 0) {
    const prefix = lines.length === 1 && lines[0] === "" ? [] : lines;
    return [...prefix, ...(prefix.length > 0 ? [""] : []), ...block, ""].join("\n");
  }

  let endIndex = startIndex + 1;
  while (endIndex < lines.length && !/^\s*\[[^\]]+\]\s*$/u.test(lines[endIndex]!)) {
    endIndex += 1;
  }
  lines.splice(startIndex, endIndex - startIndex, ...block);
  return lines.join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function isCodexInstalled(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    await execFileAsync("where.exe", ["codex"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function hasCodexMcpServer(source: string): boolean {
  return source.split(/\r?\n/u).some((line) => line.trim() === "[mcp_servers.interview_bridge]");
}

async function atomicallyWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

export async function getManagementSettings(): Promise<ManagementSettings> {
  const envPath = getLocalEnvPath();
  const envSource = await fileExists(envPath) ? await readFile(envPath, "utf8") : "";
  const configPath = codexConfigPath();
  const codexSource = await fileExists(configPath) ? await readFile(configPath, "utf8") : "";
  const config = getConfig();
  const db = new BridgeDatabase(config.dbPath);
  const recruitmentChannels = db.listRecruitmentSlackChannels().map((channel) => ({
    recruitmentId: channel.recruitmentId,
    recruitmentName: channel.recruitmentName,
    channelId: channel.channelId,
  }));
  db.close();
  return {
    slackSourceChannelId: valueFromEnv(envSource, "SLACK_SOURCE_CHANNEL_ID"),
    recruitmentChannels,
    workerRestartRequired: false,
    codex: {
      installed: await isCodexInstalled(),
      connected: hasCodexMcpServer(codexSource),
    },
  };
}

export async function saveRecruitmentChannelMapping(
  input: RecruitmentChannelMappingInput,
): Promise<RecruitmentChannelMapping> {
  const recruitmentId = input.recruitmentId.trim();
  const recruitmentName = input.recruitmentName.trim();
  if (!recruitmentId || !recruitmentName) {
    throw new Error("나인하이어 채용을 선택해 주세요.");
  }
  const config = getConfig();
  const db = new BridgeDatabase(config.dbPath);
  try {
    const saved = db.upsertRecruitmentSlackChannel({
      recruitmentId,
      recruitmentName,
      channelId: assertSlackChannelId(input.channelId, "면접관 일정 요청 채널 ID"),
    });
    return {
      recruitmentId: saved.recruitmentId,
      recruitmentName: saved.recruitmentName,
      channelId: saved.channelId,
    };
  } finally {
    db.close();
  }
}

export async function listInProgressRecruitmentsForManagement(): Promise<InProgressRecruitment[]> {
  const config = getConfig();
  const gateway = new NinehireMcpGateway(config.ninehire);
  const ninehire = new NinehireRecruitmentWorkflowAdapter(gateway);
  const result = await ninehire.listInProgressRecruitments({ limit: 100, offset: 0 });
  return result.recruitments.map((recruitment) => ({
    recruitmentId: recruitment.recruitmentId,
    recruitmentName: recruitment.title,
  }));
}

export async function saveManagementSettings(
  input: ManagementSettingsInput,
): Promise<ManagementSettings> {
  const slackSourceChannelId = assertSlackChannelId(
    input.slackSourceChannelId,
    "나인하이어 알림 채널 ID",
  );
  const envPath = getLocalEnvPath();
  const source = await fileExists(envPath) ? await readFile(envPath, "utf8") : "";
  await atomicallyWrite(envPath, updateEnvValues(source, {
    SLACK_SOURCE_CHANNEL_ID: slackSourceChannelId,
  }));
  process.env.SLACK_SOURCE_CHANNEL_ID = slackSourceChannelId;

  const settings = await getManagementSettings();
  return { ...settings, workerRestartRequired: true };
}

export async function connectCodexMcpServer(): Promise<ManagementSettings["codex"]> {
  const configPath = codexConfigPath();
  const source = await fileExists(configPath) ? await readFile(configPath, "utf8") : "";
  await atomicallyWrite(
    configPath,
    upsertCodexMcpServerConfig(source, getApplicationRoot()),
  );
  return {
    installed: await isCodexInstalled(),
    connected: true,
  };
}

export function openCodexConversation(): void {
  if (process.platform !== "win32") {
    throw new Error("Codex 대화 창은 Windows 설치형 앱에서 열 수 있습니다.");
  }
  const launcherPath = join(getApplicationRoot(), "scripts", "open-codex.cmd");
  if (!existsSync(launcherPath)) {
    throw new Error("Codex 대화 실행 파일을 찾지 못했습니다. 설치 파일을 다시 실행해 주세요.");
  }
  const child = spawn(
    "cmd.exe",
    ["/d", "/c", `start "" "${launcherPath}"`],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}

export async function restartManagedWorker(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("설치형 워커 재시작은 Windows에서만 사용할 수 있습니다.");
  }
  try {
    await execFileAsync("schtasks.exe", ["/End", "/TN", WORKER_TASK_NAME], {
      windowsHide: true,
    });
  } catch {
    // 실행 중이 아닌 작업도 바로 다시 시작할 수 있다.
  }
  await execFileAsync("schtasks.exe", ["/Run", "/TN", WORKER_TASK_NAME], {
    windowsHide: true,
  });
}

export function isManagedWorkerInstalled(): boolean {
  return existsSync(join(getApplicationRoot(), "runtime", "node.exe"));
}
