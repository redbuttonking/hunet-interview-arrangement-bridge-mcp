import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { BridgeDatabase } from "../src/db/database.js";
import { createBridgeMcpServer } from "../src/mcp/server.js";
import type { NinehireWorkflowAdapter } from "../src/ninehire/adapter.js";

let db: BridgeDatabase | undefined;

afterEach(() => db?.close());

describe("bridge MCP server", () => {
  it("lists tools and serves local bridge status over MCP", async () => {
    const config: AppConfig = {
      dbPath: ":memory:",
      pollIntervalMs: 300_000,
      timeZone: "Asia/Seoul",
      daouOffice: {
        url: "https://hug.hunet.co.kr/app/asset",
        browserProfileDir: "C:/temp/daou-profile",
        remoteDebugPort: 9222,
        edgeExecutablePath:
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      },
      slack: {},
      ninehire: {
        url: "https://example.invalid/mcp",
        authHeader: "Authorization",
        authScheme: "Bearer",
      },
    };
    const fakeNinehire: NinehireWorkflowAdapter = {
      async lookupCompletedEvaluation() {
        return { reason: "평가표 조회 전 테스트입니다." };
      },
      async listInterviewers() {
        return { interviewers: [], unresolvedUserGroups: [] };
      },
      async listInProgressRecruitments() {
        return {
          count: 1,
          limit: 100,
          offset: 0,
          recruitments: [
            {
              recruitmentId: "R1",
              title: "진행 중 채용",
              status: "진행 중",
              isPrivate: false,
            },
          ],
        };
      },
    };
    db = new BridgeDatabase(":memory:");
    const server = createBridgeMcpServer(config, db, {
      ninehire: fakeNinehire,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("bridge_status");
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "approve_and_send_interviewer_request",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "create_availability_recovery_draft",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "approve_and_send_availability_recovery",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "approve_interview_arrangement",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "record_manual_confirmed_interview",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "list_in_progress_recruitments",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "preview_recruitment_interview_template",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "approve_recruitment_interview_template",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "set_case_combined_interview_plan",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "open_daou_office_login",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "sync_daou_meeting_room_blocks",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "suggest_interview_slots_with_rooms",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "confirm_internal_interview_schedule",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "create_interviewer_schedule_confirmation_draft",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "approve_and_send_interviewer_schedule_confirmation",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "reopen_interview_schedule_for_reschedule",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "cancel_interview_arrangement",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "approve_and_send_interviewer_schedule_update",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "reprocess_schedule_confirmation_notifications",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "reprocess_interview_arrangement_eligibility_reviews",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "reprocess_candidate_interview_absence_notifications",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "resolve_candidate_interview_absence_review",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "replace_pending_message_draft_text",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "backfill_cancellation_external_follow_ups",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "list_cancellation_external_follow_ups",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "resolve_cancellation_external_follow_up",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "get_interview_operations_dashboard",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "list_integration_retry_jobs",
    );

    const status = await client.callTool({ name: "bridge_status" });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      database: { activeCases: 0 },
      integrations: { daouOffice: { mode: "DEDICATED_EDGE_PROFILE" } },
    });

    const recruitments = await client.callTool({
      name: "list_in_progress_recruitments",
      arguments: {},
    });
    expect(recruitments.isError).not.toBe(true);
    expect(recruitments.structuredContent).toMatchObject({
      count: 1,
      recruitments: [{ recruitmentId: "R1", title: "진행 중 채용" }],
    });

    const confirmedCase = db.createInterviewCase({
      candidateName: "운영 현황 후보자",
      proposalDates: ["2026-08-04"],
    });
    db.setCaseStatus(confirmedCase.id, "CONFIRMED");
    const cancelledCase = db.createInterviewCase({
      candidateName: "취소 이력 후보자",
      proposalDates: ["2026-08-04"],
    });
    db.cancelInterviewArrangement({
      caseId: cancelledCase.id,
      reason: "테스트 취소",
    });

    const defaultCases = await client.callTool({
      name: "list_interview_cases",
      arguments: {},
    });
    expect(defaultCases.structuredContent).toMatchObject({
      cases: [{ id: confirmedCase.id, status: "CONFIRMED" }],
    });
    const cancelledCases = await client.callTool({
      name: "list_interview_cases",
      arguments: { status: "CANCELLED" },
    });
    expect(cancelledCases.structuredContent).toMatchObject({
      cases: [{ id: cancelledCase.id, status: "CANCELLED" }],
    });

    await client.close();
    await server.close();
  });
});
