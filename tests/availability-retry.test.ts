// 공통 일정이 없을 때 다음 주 일정 요청 초안만 생성하는 흐름을 검증한다.
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { BridgeDatabase } from "../src/db/database.js";
import { WorkflowService } from "../src/services/workflow.js";

const config: AppConfig = {
  dbPath: ":memory:",
  pollIntervalMs: 300_000,
  timeZone: "Asia/Seoul",
  daouOffice: {
    url: "https://hug.hunet.co.kr/app/asset",
    browserProfileDir: "C:/temp/daou-profile",
    remoteDebugPort: 9222,
    chromeExecutablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  },
  slack: {},
  ninehire: {
    url: "https://example.invalid/mcp",
    authHeader: "Authorization",
    authScheme: "Bearer",
    timeoutMs: 30_000,
  },
};

describe("next-week availability retry", () => {
  it("다음 주 일정 요청 초안을 만들되 Slack에는 발송하지 않는다", async () => {
    const db = new BridgeDatabase(":memory:");
    try {
      db.upsertRecruitmentSlackChannel({
        recruitmentId: "R1",
        recruitmentName: "테스트 채용",
        channelId: "C1",
      });
      db.upsertIdentityMapping({
        ninehireUserId: "N1",
        slackUserId: "U1",
        displayName: "면접관",
      });
      const interviewCase = db.createInterviewCase({
        candidateRef: "A1",
        candidateName: "테스트 후보자",
        recruitmentRef: "R1",
        recruitmentName: "테스트 채용",
        proposalDates: ["2026-08-18", "2026-08-19", "2026-08-20"],
      });
      const interviewer = db.addOrUpdateInterviewer({
        caseId: interviewCase.id,
        ninehireUserId: "N1",
        slackUserId: "U1",
        displayName: "면접관",
        source: "NINEHIRE",
      });
      db.setCaseStatus(interviewCase.id, "REQUEST_SENT");
      db.replaceAvailabilityForInterviewer(interviewCase.id, interviewer.id, [
        { date: "2026-08-18", start: "10:00", end: "11:00" },
      ]);
      const workflow = new WorkflowService(db, config, {
        async lookupCompletedEvaluation() {
          return {};
        },
        async listInterviewers() {
          return {
            interviewers: [
              {
                ninehireUserId: "N1",
                displayName: "면접관",
                required: true,
              },
            ],
            unresolvedUserGroups: [],
          };
        },
        async listInProgressRecruitments() {
          return { count: 0, limit: 100, offset: 0, recruitments: [] };
        },
      });

      const result = await workflow.createNextWeekAvailabilityRetryDraft(interviewCase.id);

      expect(result.interviewCase).toMatchObject({
        status: "DRAFT_CREATED",
        scheduleRound: 2,
        proposalDates: ["2026-08-25", "2026-08-26", "2026-08-27"],
      });
      expect(result.draft).toMatchObject({
        messageType: "INTERVIEWER_REQUEST",
        status: "DRAFT",
        channelId: "C1",
        slackMessageTs: null,
      });
      expect(db.getCaseBundle(interviewCase.id)?.availability).toEqual([]);
      expect(db.getInterviewer(interviewer.id)?.status).toBe("PENDING");
    } finally {
      db.close();
    }
  });
});
