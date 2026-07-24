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

  it("recognizes a submitted score sheet in a legacy Slack attachment", () => {
    const parsed = parseNinehireSlackMessage({
      text: "",
      attachments: [
        {
          fallback: "평가표 제출이 완료되었습니다.",
          title: "평가표 제출이 완료되었습니다.\nㅤ",
          fields: [
            {
              value:
                "*<https://app.ninehire.com/recruitment/R1/applicants?applicantProgressId=A1|테스트 지원자>*",
              title: "지원자:",
            },
            { value: "서류전형 평가표", title: "평가표:" },
            { value: "인터뷰 어레인지 자동화 테스트 채용", title: "채용:" },
          ],
        },
      ],
    });

    expect(parsed.eventType).toBe("EVALUATION_COMPLETED");
    expect(parsed.title).toBe("평가표 제출이 완료되었습니다.");
    expect(parsed.candidateName).toBe("테스트 지원자");
    expect(parsed.candidateRef).toContain("applicantProgressId=A1");
    expect(parsed.recruitmentName).toBe("인터뷰 어레인지 자동화 테스트 채용");
  });

  it("does not confuse an expired evaluation deadline with completion", () => {
    const parsed = parseNinehireSlackMessage({
      text: "평가 기한이 만료되었습니다.\n지원자: 홍길동",
    });
    expect(parsed.eventType).toBe("EVALUATION_DEADLINE_EXPIRED");
  });
});
