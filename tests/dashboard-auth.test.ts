// 대시보드 관리자 로그인과 비밀번호 변경의 세션 보호를 검증한다.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticateDashboardAdmin,
  changeDashboardPassword,
  validateDashboardSession,
} from "../src/installation/dashboard-auth.js";

const environmentKeys = ["INTERVIEW_BRIDGE_ROOT", "BRIDGE_DB_PATH"] as const;
const previousEnvironment = new Map<string, string | undefined>();
let temporaryDirectory: string | undefined;

afterEach(() => {
  for (const key of environmentKeys) {
    const previousValue = previousEnvironment.get(key);
    if (previousValue === undefined) delete process.env[key];
    else process.env[key] = previousValue;
  }
  previousEnvironment.clear();
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("dashboard administrator authentication", () => {
  it("initializes the single administrator, protects sessions, and revokes old sessions after a password change", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "interview-bridge-dashboard-auth-"));
    for (const key of environmentKeys) previousEnvironment.set(key, process.env[key]);
    process.env.INTERVIEW_BRIDGE_ROOT = temporaryDirectory;
    process.env.BRIDGE_DB_PATH = "./data/bridge.db";

    await expect(authenticateDashboardAdmin({
      email: "hr@hunet.co.kr",
      password: "incorrect-password",
    })).resolves.toBeUndefined();

    const firstSession = await authenticateDashboardAdmin({
      email: "hr@hunet.co.kr",
      password: "hunetno1!",
    });
    expect(firstSession).toBeDefined();
    expect(validateDashboardSession(firstSession?.token)).toBe(true);

    const nextSession = await changeDashboardPassword({
      currentPassword: "hunetno1!",
      nextPassword: "new-safe-password",
    });
    expect(nextSession).toBeDefined();
    expect(validateDashboardSession(firstSession?.token)).toBe(false);
    expect(validateDashboardSession(nextSession?.token)).toBe(true);
    await expect(authenticateDashboardAdmin({
      email: "hr@hunet.co.kr",
      password: "hunetno1!",
    })).resolves.toBeUndefined();
  });
});
