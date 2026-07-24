// 평가표 확인 후 사용자 승인으로 면접 조율 건을 만드는 흐름을 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { BridgeDatabase } from "../src/db/database.js";
import type { NinehireWorkflowAdapter } from "../src/ninehire/adapter.js";
import { WorkflowService } from "../src/services/workflow.js";
import type { ParsedSlackNotification } from "../src/slack/parser.js";

let db: BridgeDatabase | undefined;
afterEach(() => db?.close());

const config: AppConfig = {
  dbPath: ":memory:",
  pollIntervalMs: 300_000,
  timeZone: "Asia/Seoul",
  slack: {},
  ninehire: {
    url: "https://example.invalid/mcp",
    authHeader: "Authorization",
    authScheme: "Bearer",
  },
};

describe("evaluation approval workflow", () => {
  it("waits for user approval before creating an interview case", async () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return {
          context: {
            candidateRef: "A123",
            candidateName: "김지원",
            recruitmentRef: "J456",
            recruitmentName: "백엔드 엔지니어",
          },
          summary: {
            applicantProgressId: "A123",
            recruitmentId: "J456",
            scoreSheets: [
              {
                scoreSheetId: "S1",
                title: "서류 평가표",
                participants: ["평가자"],
                evaluators: [],
              },
            ],
          },
        };
      },
      async listInterviewers() {
        return { interviewers: [], unresolvedUserGroups: [] };
      },
    };
    const workflow = new WorkflowService(db, config, ninehire);
    const parsed: ParsedSlackNotification = {
      eventType: "EVALUATION_COMPLETED",
      title: "서류 평가가 완료되었습니다.",
      text: "서류 평가가 완료되었습니다.",
      links: [],
      payloadHash: "hash",
      payloadJson: "{}",
      candidateName: "김지원",
      recruitmentName: "백엔드 엔지니어",
    };

    const ingested = await workflow.ingestSlackNotification({
      channelId: "C1",
      messageTs: "1.0",
      parsed,
    });
    expect(ingested.result).toBe("EVALUATION_READY_FOR_APPROVAL");
    expect(db.listCases()).toHaveLength(0);

    const review = db.listOpenReviews()[0];
    expect(review?.reviewType).toBe("INTERVIEW_ARRANGEMENT_START_REQUIRED");
    expect(review?.summary).toMatchObject({
      evaluation: { scoreSheets: [{ title: "서류 평가표" }] },
    });

    const approved = await workflow.approveInterviewArrangement(review!.id);
    expect(approved.result).toBe("INTERVIEW_CASE_CREATED");
    expect(db.getCase(approved.caseId)).toMatchObject({
      candidateRef: "A123",
      recruitmentRef: "J456",
      status: "READY_FOR_DRAFT",
    });
  });

  it("adds direct recruitment participants and flags unresolved user groups", async () => {
    db = new BridgeDatabase(":memory:");
    const ninehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return { reason: "이 테스트에서는 사용하지 않습니다." };
      },
      async listInterviewers() {
        return {
          interviewers: [
            {
              ninehireUserId: "N1",
              displayName: "면접관",
              email: "interviewer@example.com",
              required: true,
            },
          ],
          unresolvedUserGroups: ["개발팀"],
        };
      },
    };
    const workflow = new WorkflowService(db, config, ninehire);
    const interviewCase = db.createInterviewCase({
      candidateName: "김지원",
      recruitmentRef: "J456",
      recruitmentName: "백엔드 엔지니어",
      proposalDates: ["2026-07-30"],
    });

    const result = await workflow.syncCaseInterviewers(interviewCase.id);

    expect(result).toMatchObject({
      addedOrUpdated: 1,
      unresolvedUserGroups: ["개발팀"],
    });
    expect(db.listInterviewers(interviewCase.id)).toMatchObject([
      { displayName: "면접관", required: true },
    ]);
    expect(db.listOpenReviews()).toMatchObject([
      { reviewType: "INTERVIEWER_GROUP_MEMBERS_REQUIRED" },
    ]);

    await workflow.syncCaseInterviewers(interviewCase.id);
    expect(db.listOpenReviews()).toHaveLength(1);
  });
});
