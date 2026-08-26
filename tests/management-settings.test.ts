// 설치형 앱의 관리 설정 파일 갱신이 기존 비밀값과 Codex 설정을 보존하는지 검증한다.

import { describe, expect, it } from "vitest";
import {
  updateEnvValues,
  upsertCodexMcpServerConfig,
} from "../src/installation/management-settings.js";

describe("management settings", () => {
  it("updates only selected Slack channel values while retaining existing keys", () => {
    const updated = updateEnvValues(
      "SLACK_APP_TOKEN=xapp-secret\nSLACK_SOURCE_CHANNEL_ID=COLD\n# keep this comment\n",
      {
        SLACK_SOURCE_CHANNEL_ID: "CNEW123456",
        SLACK_REQUEST_CHANNEL_ID: "GNEW123456",
      },
    );

    expect(updated).toContain("SLACK_APP_TOKEN=xapp-secret");
    expect(updated).toContain("# keep this comment");
    expect(updated).toContain("SLACK_SOURCE_CHANNEL_ID=CNEW123456");
    expect(updated).toContain("SLACK_REQUEST_CHANNEL_ID=GNEW123456");
  });

  it("adds or replaces only the interview bridge Codex MCP block", () => {
    const updated = upsertCodexMcpServerConfig(
      "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other\"\n\n[mcp_servers.interview_bridge]\ncommand = \"old\"\n\n[profiles.work]\nmodel = \"work\"\n",
      "C:/Users/user/AppData/Local/Hunet Interview Ops",
    );

    expect(updated).toContain("model = \"gpt-5\"");
    expect(updated).toContain("[mcp_servers.other]\ncommand = \"other\"");
    expect(updated).toContain("[profiles.work]\nmodel = \"work\"");
    expect(updated).toContain("[mcp_servers.interview_bridge]");
    expect(updated).toContain('command = "C:/Users/user/AppData/Local/Hunet Interview Ops/runtime/node.exe"');
    expect(updated).not.toContain('command = "old"');
  });
});
