// 설치형 패키지의 DB 백업과 실행 안정성 구성을 검증한다.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../src/db/database.js";

let temporaryDirectory: string | undefined;

afterEach(() => {
  if (!temporaryDirectory) return;
  rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("installer packaging", () => {
  it("creates a readable database snapshot before updating an existing installation", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "hunet-installer-backup-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    const backupDirectory = join(temporaryDirectory, "backups");
    const database = new BridgeDatabase(databasePath);
    database.createInterviewCase({
      candidateName: "테스트 후보자",
      recruitmentRef: "R-INSTALLER",
      recruitmentName: "설치 검증 채용",
      proposalDates: ["2026-08-31"],
    });
    database.close();

    execFileSync(
      process.execPath,
      ["packaging/app/scripts/backup-existing-database.mjs", databasePath, backupDirectory],
      { cwd: process.cwd(), stdio: "pipe" },
    );

    const backupName = readdirSync(backupDirectory).find((entry) => entry.endsWith(".db"));
    expect(backupName).toBeDefined();
    const backupPath = join(backupDirectory, backupName!);
    expect(existsSync(backupPath)).toBe(true);

    const backup = new BridgeDatabase(backupPath);
    try {
      expect(backup.listCases(undefined, 10)).toEqual(expect.arrayContaining([
        expect.objectContaining({ candidateName: "테스트 후보자" }),
      ]));
    } finally {
      backup.close();
    }
  });

  it("waits for installer creation and keeps the current installer until a candidate is complete", () => {
    const script = readFileSync("scripts/build-installer.ps1", "utf8");
    expect(script).toContain("HunetInterviewOps-Setup.new.exe");
    expect(script).toContain("Wait-Process -Id $iexpressProcess.Id -Timeout 600");
    expect(script).toContain("HunetInterviewOps-Setup.previous.exe");
  });

  it("starts the dashboard only after readiness is checked and captures local logs", () => {
    const launcher = readFileSync("packaging/app/Hunet Interview Ops.cmd", "utf8");
    const worker = readFileSync("packaging/app/scripts/start-worker.cmd", "utf8");
    const dashboard = readFileSync("packaging/app/scripts/start-dashboard.cmd", "utf8");

    expect(launcher).toContain("http://127.0.0.1:3100/login");
    expect(launcher).toContain("for /L %%I in (1,1,30)");
    expect(worker).toContain("worker.log");
    expect(dashboard).toContain("dashboard.log");
  });
});
