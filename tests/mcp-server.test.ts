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
      "approve_interview_arrangement",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "list_in_progress_recruitments",
    );
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "open_daou_office_login",
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

    await client.close();
    await server.close();
  });
});
