// 대시보드 결정 요청의 중복 처리 동작을 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeDatabase } from "../src/db/database.js";
import { resolveDashboardDecision } from "../src/dashboard/runtime.js";

let temporaryDirectory: string | undefined;
let previousDatabasePath: string | undefined;

afterEach(() => {
  if (previousDatabasePath === undefined) {
    delete process.env.BRIDGE_DB_PATH;
  } else {
    process.env.BRIDGE_DB_PATH = previousDatabasePath;
  }
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("dashboard runtime", () => {
  it("treats a repeated submission of the same resolved decision as idempotent", async () => {
    previousDatabasePath = process.env.BRIDGE_DB_PATH;
    temporaryDirectory = mkdtempSync(join(tmpdir(), "interview-bridge-dashboard-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    const db = new BridgeDatabase(databasePath);
    const decision = db.createOrGetPendingInterviewSkillDecision({
      skillKey: "AVAILABILITY_COLLECTION",
      decisionType: "SYNC_INTERVIEWERS",
      fingerprint: "test:dashboard-runtime:idempotent",
      title: "Interviewer lookup",
      prompt: "Refresh interviewers.",
      selectionMode: "SINGLE",
      options: [
        { id: "SYNC_INTERVIEWERS", label: "Refresh", description: "Refresh interviewers." },
        { id: "HOLD", label: "Hold", description: "Keep this work pending." },
      ],
      context: {},
    });
    db.resolveInterviewSkillDecision({
      decisionId: decision.id,
      optionId: "SYNC_INTERVIEWERS",
      resolution: { action: "SYNC_INTERVIEWERS", nextAction: "NONE" },
    });
    db.close();

    process.env.BRIDGE_DB_PATH = databasePath;
    const result = await resolveDashboardDecision({
      decisionId: decision.id,
      optionId: "SYNC_INTERVIEWERS",
    });

    expect(result.decision.status).toBe("RESOLVED");
    expect(result.decision.selectedOptionId).toBe("SYNC_INTERVIEWERS");
  });
});
