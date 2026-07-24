import { describe, expect, it } from "vitest";
import { parseNinehireSlackMessage } from "../src/slack/parser.js";

describe("NineHire Slack parser", () => {
  it("recognizes an evaluation-completed notification and extracts links", () => {
    const parsed = parseNinehireSlackMessage({
      bot_id: "B_NINEHIRE",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              "*서류 평가가 완료되었습니다.*",
              "",
              "지원자:",
              "<https://app.ninehire.com/applicants/A123|홍길동>",
              "채용:",
              "<https://app.ninehire.com/jobs/J456|백엔드 엔지니어>",
            ].join("\n"),
          },
        },
      ],
    });

    expect(parsed.eventType).toBe("EVALUATION_COMPLETED");
    expect(parsed.candidateName).toBe("홍길동");
    expect(parsed.candidateRef).toContain("/A123");
    expect(parsed.recruitmentName).toBe("백엔드 엔지니어");
    expect(parsed.recruitmentRef).toContain("/J456");
  });

  it("does not confuse an expired evaluation deadline with completion", () => {
    const parsed = parseNinehireSlackMessage({
      text: "평가 기한이 만료되었습니다.\n지원자: 홍길동",
    });
    expect(parsed.eventType).toBe("EVALUATION_DEADLINE_EXPIRED");
  });
});
