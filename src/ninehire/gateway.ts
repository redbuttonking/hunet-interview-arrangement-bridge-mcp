import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppConfig } from "../config.js";

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export class NinehireMcpGateway {
  constructor(private readonly config: AppConfig["ninehire"]) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  private async connect(): Promise<Client> {
    if (!this.config.apiKey) {
      throw new Error(
        "NINEHIRE_MCP_API_KEY is not configured. Put it in the local .env file.",
      );
    }
    const headers = new Headers();
    const authValue = this.config.authScheme
      ? `${this.config.authScheme} ${this.config.apiKey}`
      : this.config.apiKey;
    headers.set(this.config.authHeader, authValue);

    const transport = new StreamableHTTPClientTransport(
      new URL(this.config.url),
      { requestInit: { headers } },
    );
    const client = new Client({
      name: "interview-arrangement-bridge",
      version: "0.1.0",
    });
    await client.connect(transport);
    return client;
  }

  async listTools(): Promise<UpstreamTool[]> {
    const client = await this.connect();
    try {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as Record<string, unknown>,
        ...(tool.outputSchema
          ? { outputSchema: tool.outputSchema as Record<string, unknown> }
          : {}),
        ...(tool.annotations
          ? { annotations: tool.annotations as Record<string, unknown> }
          : {}),
      }));
    } finally {
      await client.close();
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const client = await this.connect();
    try {
      const result = await client.callTool({ name, arguments: args });
      if ("isError" in result && result.isError) {
        throw new Error(
          `NineHire tool ${name} returned an error: ${JSON.stringify(result.content)}`,
        );
      }
      return result as Record<string, unknown>;
    } finally {
      await client.close();
    }
  }
}
