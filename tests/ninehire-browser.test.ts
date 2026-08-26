// 나인하이어 자동화 전용 Chrome 프로필의 실행 인수를 검증한다.
import { describe, expect, it } from "vitest";
import {
  ninehireChromeLaunchArguments,
  ninehireDebugUrl,
} from "../src/ninehire/browser.js";

describe("NineHire browser profile", () => {
  it("uses a local-only debug port and dedicated user data directory", () => {
    const args = ninehireChromeLaunchArguments({
      url: "https://api.ninehire.com/developer/mcp",
      appUrl: "https://app.ninehire.com/workspace",
      apiKey: undefined,
      authHeader: "Authorization",
      authScheme: "Bearer",
      timeoutMs: 30_000,
      browserProfileDir: "C:/temp/ninehire-profile",
      remoteDebugPort: 9223,
      chromeExecutablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    });

    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9223");
    expect(args).toContain("--user-data-dir=C:/temp/ninehire-profile");
    expect(args).toContain("--disable-gpu");
    expect(args).toContain("--disable-gpu-compositing");
    expect(args).toContain("--in-process-gpu");
    expect(args).toContain("--start-maximized");
    expect(args.at(-1)).toBe("https://app.ninehire.com/workspace");
    expect(ninehireDebugUrl(9223)).toBe("http://127.0.0.1:9223");
  });
});
