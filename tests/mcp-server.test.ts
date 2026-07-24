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
      slack: {},
      ninehire: {
        url: "https://example.invalid/mcp",
        authHeader: "Authorization",
        authScheme: "Bearer",
        evaluation: {
          passValues: ["합격"],
          failValues: ["불합격"],
        },
        interviewers: {
          idPath: "id",
          namePath: "name",
          emailPath: "email",
        },
      },
    };
    const fakeNinehire: NinehireWorkflowAdapter = {
      async lookupEvaluation() {
        return { decision: "REVIEW_REQUIRED" };
      },
      async listInterviewers() {
        return [];
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

    const status = await client.callTool({ name: "bridge_status" });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      database: { activeCases: 0 },
      integrations: { daouOffice: "DEFERRED" },
    });

    await client.close();
    await server.close();
  });
});
