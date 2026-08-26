// 설치형 실행 환경에서 설정 파일과 데이터 경로의 기준 폴더를 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getConfig } from "../src/config.js";

const environmentKeys = [
  "INTERVIEW_BRIDGE_ROOT",
  "BRIDGE_DB_PATH",
  "DAOU_CHROME_PROFILE_DIR",
  "NINEHIRE_CHROME_PROFILE_DIR",
] as const;
const previousEnvironment = new Map<string, string | undefined>();
let temporaryDirectory: string | undefined;

afterEach(() => {
  for (const key of environmentKeys) {
    const previousValue = previousEnvironment.get(key);
    if (previousValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
  }
  previousEnvironment.clear();
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("configuration", () => {
  it("uses the packaged application root for relative data and browser paths", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "interview-bridge-config-"));
    for (const key of environmentKeys) {
      previousEnvironment.set(key, process.env[key]);
    }
    process.env.INTERVIEW_BRIDGE_ROOT = temporaryDirectory;
    process.env.BRIDGE_DB_PATH = "./data/bridge.db";
    process.env.DAOU_CHROME_PROFILE_DIR = "./data/daou-profile";
    process.env.NINEHIRE_CHROME_PROFILE_DIR = "./data/ninehire-profile";

    const config = getConfig();

    expect(config.dbPath).toBe(resolve(temporaryDirectory, "data/bridge.db"));
    expect(config.daouOffice.browserProfileDir).toBe(
      resolve(temporaryDirectory, "data/daou-profile"),
    );
    expect(config.ninehire.browserProfileDir).toBe(
      resolve(temporaryDirectory, "data/ninehire-profile"),
    );
  });
});
