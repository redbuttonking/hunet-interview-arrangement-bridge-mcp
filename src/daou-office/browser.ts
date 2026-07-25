// 다우오피스 전용 Edge 프로필을 열고 로컬 디버그 연결 상태를 확인한다.
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

export function edgeLaunchArguments(config: AppConfig["daouOffice"]): string[] {
  return [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${config.remoteDebugPort}`,
    `--user-data-dir=${config.browserProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
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
      return {
        alreadyRunning: true,
        profileDir: current.profileDir,
        url: this.config.url,
      };
    }
    if (!existsSync(this.config.edgeExecutablePath)) {
      throw new Error(
        `Microsoft Edge executable was not found: ${this.config.edgeExecutablePath}`,
      );
    }
    mkdirSync(this.config.browserProfileDir, { recursive: true });
    const child = this.launch();
    child.unref();
    return {
      alreadyRunning: false,
      profileDir: this.config.browserProfileDir,
      url: this.config.url,
    };
  }

  private launch(): ChildProcess {
    return spawn(this.config.edgeExecutablePath, edgeLaunchArguments(this.config), {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
  }
}
