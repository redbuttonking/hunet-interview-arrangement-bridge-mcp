// 나인하이어 전용 Chrome 프로필의 로그인과 연결 상태를 관리한다.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import type { AppConfig } from "../config.js";

export interface NinehireBrowserStatus {
  connected: boolean;
  profileDir: string;
  debugUrl: string;
}

export function ninehireDebugUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function ninehireChromeLaunchArguments(config: AppConfig["ninehire"]): string[] {
  return [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${config.remoteDebugPort ?? 9223}`,
    `--user-data-dir=${config.browserProfileDir ?? "./data/ninehire-chrome-profile"}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    config.appUrl ?? "https://app.ninehire.com",
  ];
}

export class NinehireBrowserController {
  constructor(private readonly config: AppConfig["ninehire"]) {}

  async status(): Promise<NinehireBrowserStatus> {
    const debugUrl = ninehireDebugUrl(this.config.remoteDebugPort ?? 9223);
    try {
      const response = await fetch(`${debugUrl}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      return {
        connected: response.ok,
        profileDir: this.profileDir(),
        debugUrl,
      };
    } catch {
      return {
        connected: false,
        profileDir: this.profileDir(),
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
    const url = this.config.appUrl ?? "https://app.ninehire.com";
    if (current.connected) {
      return { alreadyRunning: true, profileDir: current.profileDir, url };
    }
    const executablePath = this.executablePath();
    if (!existsSync(executablePath)) {
      throw new Error(
        `Google Chrome executable was not found: ${executablePath}`,
      );
    }
    mkdirSync(this.profileDir(), { recursive: true });
    const child = this.launch();
    child.unref();
    return { alreadyRunning: false, profileDir: this.profileDir(), url };
  }

  private launch(): ChildProcess {
    return spawn(
      this.executablePath(),
      ninehireChromeLaunchArguments(this.config),
      { detached: true, stdio: "ignore", windowsHide: false },
    );
  }

  private profileDir(): string {
    return this.config.browserProfileDir ?? "./data/ninehire-chrome-profile";
  }

  private executablePath(): string {
    return this.config.chromeExecutablePath
      ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  }
}
