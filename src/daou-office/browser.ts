// 다우오피스 전용 Chrome 프로필을 열고 로컬 디버그 연결 상태를 확인한다.
import { existsSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type { AppConfig } from "../config.js";

export interface DaouOfficeBrowserStatus {
  connected: boolean;
  profileDir: string;
  debugUrl: string;
}

export function daouOfficeDebugUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function chromeLaunchArguments(config: AppConfig["daouOffice"]): string[] {
  return [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${config.remoteDebugPort}`,
    `--user-data-dir=${config.browserProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--in-process-gpu",
    "--disable-software-rasterizer",
    "--new-window",
    "--start-maximized",
    config.url,
  ];
}

export class DaouOfficeBrowserController {
  constructor(private readonly config: AppConfig["daouOffice"]) {}

  async status(): Promise<DaouOfficeBrowserStatus> {
    const debugUrl = daouOfficeDebugUrl(this.config.remoteDebugPort);
    try {
      const response = await fetch(`${debugUrl}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      return {
        connected: response.ok,
        profileDir: this.config.browserProfileDir,
        debugUrl,
      };
    } catch {
      return {
        connected: false,
        profileDir: this.config.browserProfileDir,
        debugUrl,
      };
    }
  }

  async openLoginWindow(): Promise<{
    alreadyRunning: boolean;
    profileDir: string;
    url: string;
  }> {
    const current = await this.status();
    if (current.connected) {
      this.openVisibleWindow();
      return {
        alreadyRunning: true,
        profileDir: current.profileDir,
        url: this.config.url,
      };
    }
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(
        `Google Chrome executable was not found: ${this.config.chromeExecutablePath}`,
      );
    }
    mkdirSync(this.config.browserProfileDir, { recursive: true });
    const child = this.launch();
    const launchError = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(error));
    });
    child.unref();
    await Promise.race([this.waitForDebugConnection(), launchError]);
    return {
      alreadyRunning: false,
      profileDir: this.config.browserProfileDir,
      url: this.config.url,
    };
  }

  private launch(): ChildProcess {
    return spawn(this.config.chromeExecutablePath, chromeLaunchArguments(this.config), {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
  }

  private openVisibleWindow(): void {
    const child = spawn(this.config.chromeExecutablePath, [
      `--user-data-dir=${this.config.browserProfileDir}`,
      "--new-window",
      "--start-maximized",
      this.config.url,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  }

  private async waitForDebugConnection(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await this.status()).connected) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `다우오피스 전용 Chrome이 실행되지 않았습니다. 디버깅 포트 ${this.config.remoteDebugPort}가 열리지 않았습니다.`,
    );
  }
}
