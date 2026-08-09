// 다우오피스 전용 Chrome 실행 인수와 상태 표현을 검증한다.
import { describe, expect, it } from "vitest";
import {
  daouOfficeDebugUrl,
  chromeLaunchArguments,
} from "../src/daou-office/browser.js";

describe("DaouOffice browser profile", () => {
  it("uses a local-only debug port and dedicated user data directory", () => {
    const args = chromeLaunchArguments({
      url: "https://hug.hunet.co.kr/app/asset",
      browserProfileDir: "C:/temp/daou-profile",
      remoteDebugPort: 9222,
      chromeExecutablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    });

    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9222");
    expect(args).toContain("--user-data-dir=C:/temp/daou-profile");
    expect(args.at(-1)).toBe("https://hug.hunet.co.kr/app/asset");
    expect(daouOfficeDebugUrl(9222)).toBe("http://127.0.0.1:9222");
  });
});
