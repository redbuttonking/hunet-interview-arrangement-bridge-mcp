// 나인하이어 평가표 조회와 승인용 요약 생성을 검증한다.
import { describe, expect, it } from "vitest";
import { NinehireRecruitmentWorkflowAdapter } from "../src/ninehire/adapter.js";

describe("NineHire approval adapter", () => {
  it("builds an approval summary from completed score sheets", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const adapter = new NinehireRecruitmentWorkflowAdapter({
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "get_recruitment") {
          return {
            structuredContent: {
              recruitmentId: "J456",
              title: "백엔드 엔지니어",
            },
          };
        }
        if (name === "get_applicant_progress") {
          return {
            structuredContent: {
              applicantProgressId: "A123",
              name: "김지원",
              scoreSheets: [
                {
                  scoreSheetId: "S1",
                  title: "서류 평가표",
                  evaluationMethod: { code: "final_evaluation", name: "최종 평가" },
                  status: { code: "done", name: "완료" },
                  doneAt: "2026-07-24T00:00:00.000Z",
                  participants: [{ name: "평가자" }],
                  scorings: [
                    {
                      user: { name: "평가자" },
                      createdAt: "2026-07-24T00:00:00.000Z",
                      comment: "인터뷰 진행을 권장합니다.",
                      items: [
                        {
                          title: "종합 의견",
                          finalEvaluation: true,
                          options: [
                            { title: "합격", score: 5, checked: true },
                            { title: "보류", score: 3, checked: false },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected tool: ${name}`);
      },
    });

    const lookup = await adapter.lookupCompletedEvaluation({
      candidateRef: "https://app.ninehire.com/applicants/A123",
      candidateName: "김지원",
      recruitmentRef: "https://app.ninehire.com/jobs/J456",
      recruitmentName: "백엔드 엔지니어",
    });

    expect(calls.map((call) => call.name)).toEqual([
      "get_recruitment",
      "get_applicant_progress",
      "get_applicant_progress",
    ]);
    expect(lookup.context).toEqual({
      candidateRef: "A123",
      candidateName: "김지원",
      recruitmentRef: "J456",
      recruitmentName: "백엔드 엔지니어",
    });
    expect(lookup.summary?.scoreSheets[0]).toMatchObject({
      title: "서류 평가표",
      participants: ["평가자"],
      evaluators: [
        {
          name: "평가자",
          items: [
            {
              title: "종합 의견",
              selectedOptions: [{ title: "합격", score: 5 }],
            },
          ],
        },
      ],
    });
  });

  it("uses direct recruitment participants and leaves user groups unresolved", async () => {
    const adapter = new NinehireRecruitmentWorkflowAdapter({
      async callTool(name) {
        if (name !== "get_recruitment") {
          throw new Error(`Unexpected tool: ${name}`);
        }
        return {
          structuredContent: {
            participants: [
              {
                type: { code: "user", name: "개별 멤버" },
                user: {
                  userId: "N1",
                  name: "면접관",
                  email: "interviewer@example.com",
                },
                userGroup: null,
              },
              {
                type: { code: "user_group", name: "유저 그룹" },
                user: null,
                userGroup: { userGroupId: "G1", name: "개발팀" },
              },
            ],
          },
        };
      },
    });

    const lookup = await adapter.listInterviewers({
      recruitmentRef: "J456",
    });

    expect(lookup.interviewers).toEqual([
      {
        ninehireUserId: "N1",
        displayName: "면접관",
        email: "interviewer@example.com",
        required: true,
      },
    ]);
    expect(lookup.unresolvedUserGroups).toEqual(["개발팀"]);
  });
});
