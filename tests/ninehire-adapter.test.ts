// 나인하이어 평가표 조회와 승인용 요약 생성을 검증한다.
import { describe, expect, it } from "vitest";
import { NinehireRecruitmentWorkflowAdapter } from "../src/ninehire/adapter.js";

describe("NineHire approval adapter", () => {
  it("finds only receipt-stage candidates whose score sheets are all complete", async () => {
    const adapter = new NinehireRecruitmentWorkflowAdapter({
      async callTool(name, args) {
        expect(name).toBe("get_applicant_progresses");
        expect(args).toEqual({
          recruitmentId: "R1",
          status: ["progressing"],
          limit: 100,
        });
        return {
          structuredContent: {
            results: [
              {
                applicantProgressId: "A1",
                applicantName: "완료 지원자",
                stepType: { code: "receipt" },
                scoreSheets: [{ status: { code: "done" } }],
              },
              {
                applicantProgressId: "A2",
                applicantName: "평가 중 지원자",
                stepType: { code: "receipt" },
                scoreSheets: [{ status: { code: "waiting" } }],
              },
              {
                applicantProgressId: "A3",
                applicantName: "인터뷰 단계 지원자",
                stepType: { code: "interview" },
                scoreSheets: [{ status: { code: "done" } }],
              },
            ],
          },
        };
      },
    });

    await expect(
      adapter.listReceiptCandidatesWithCompletedScoreSheets({
        recruitments: [{ recruitmentId: "R1", recruitmentName: "테스트 채용" }],
      }),
    ).resolves.toEqual([
      {
        candidateRef: "A1",
        candidateName: "완료 지원자",
        recruitmentRef: "R1",
        recruitmentName: "테스트 채용",
      },
    ]);
  });

  it("lists only in-progress recruitments", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const adapter = new NinehireRecruitmentWorkflowAdapter({
      async callTool(name, args) {
        calls.push({ name, args });
        if (name !== "get_recruitments") {
          throw new Error(`Unexpected tool: ${name}`);
        }
        return {
          structuredContent: {
            count: 2,
            limit: 100,
            offset: 0,
            results: [
              {
                recruitmentId: "R1",
                title: "진행 중 채용",
                externalTitle: "진행 중 공개 채용",
                status: { code: "in_progress", name: "진행 중" },
                deadlineType: { code: "until_filled", name: "채용 시 마감" },
                deadlineValue: null,
                isPrivate: false,
              },
              {
                recruitmentId: "R2",
                title: "종료 채용",
                status: { code: "closed", name: "종료" },
                isPrivate: true,
              },
            ],
          },
        };
      },
    });

    await expect(
      adapter.listInProgressRecruitments({
        keyword: "공개",
        limit: 100,
        offset: 0,
      }),
    ).resolves.toEqual({
      count: 1,
      limit: 100,
      offset: 0,
      recruitments: [
        {
          recruitmentId: "R1",
          title: "진행 중 채용",
          externalTitle: "진행 중 공개 채용",
          status: "진행 중",
          deadlineType: "채용 시 마감",
          isPrivate: false,
        },
      ],
    });
    expect(calls).toEqual([
      {
        name: "get_recruitments",
        args: {
          status: "in_progress",
          keyword: "공개",
          limit: 100,
          offset: 0,
        },
      },
    ]);
  });

  it("lists only closed recruitments with their close time", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const adapter = new NinehireRecruitmentWorkflowAdapter({
      async callTool(name, args) {
        calls.push({ name, args });
        if (name !== "get_recruitments") {
          throw new Error(`Unexpected tool: ${name}`);
        }
        return {
          structuredContent: {
            count: 2,
            limit: 100,
            offset: 0,
            results: [
              {
                recruitmentId: "R1",
                title: "Closed recruitment",
                status: { code: "closed", name: "Closed" },
                closedAt: "2026-07-29T04:16:16.000Z",
                deadlineType: { code: "until_filled", name: "Until filled" },
                isPrivate: false,
              },
              {
                recruitmentId: "R2",
                title: "In-progress recruitment",
                status: { code: "in_progress", name: "In progress" },
                isPrivate: true,
              },
            ],
          },
        };
      },
    });

    await expect(
      adapter.listClosedRecruitments({
        keyword: "closed",
        limit: 100,
        offset: 0,
      }),
    ).resolves.toEqual({
      count: 1,
      limit: 100,
      offset: 0,
      recruitments: [
        {
          recruitmentId: "R1",
          title: "Closed recruitment",
          status: "Closed",
          closedAt: "2026-07-29T04:16:16.000Z",
          deadlineType: "Until filled",
          isPrivate: false,
        },
      ],
    });
    expect(calls).toEqual([
      {
        name: "get_recruitments",
        args: {
          status: "closed",
          keyword: "closed",
          limit: 100,
          offset: 0,
        },
      },
    ]);
  });

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

  it("uses recruitment and applicant IDs embedded in a NineHire applicant link", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const adapter = new NinehireRecruitmentWorkflowAdapter({
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "get_recruitment") {
          return {
            structuredContent: {
              recruitmentId: "R1",
              title: "Duplicate recruitment title",
            },
          };
        }
        if (name === "get_applicant_progress") {
          return {
            structuredContent: {
              applicantProgressId: "A1",
              name: "Candidate",
              scoreSheets: [
                {
                  scoreSheetId: "S1",
                  title: "Document review",
                  status: { code: "done", name: "Done" },
                  participants: [],
                  scorings: [],
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected tool: ${name}`);
      },
    });

    await expect(
      adapter.lookupCompletedEvaluation({
        candidateRef:
          "https://app.ninehire.com/workspace/recruitment/R1/applicants?applicantProgressId=A1",
        candidateName: "Candidate",
        recruitmentName: "Duplicate recruitment title",
      }),
    ).resolves.toMatchObject({
      context: {
        candidateRef: "A1",
        recruitmentRef: "R1",
      },
    });

    expect(calls).toEqual([
      { name: "get_recruitment", args: { recruitmentId: "R1" } },
      { name: "get_applicant_progress", args: { applicantProgressId: "A1" } },
      { name: "get_applicant_progress", args: { applicantProgressId: "A1" } },
    ]);
  });

  it("uses participants in the active score sheet and leaves user groups unresolved", async () => {
    const adapter = new NinehireRecruitmentWorkflowAdapter({
      async callTool(name) {
        if (name !== "get_applicant_progress") {
          throw new Error(`Unexpected tool: ${name}`);
        }
        return {
          structuredContent: {
            applicantProgressId: "A1",
            name: "Candidate",
            scoreSheets: [
              {
                status: { code: "waiting", name: "Waiting" },
                participants: [
                  {
                    userId: "N1",
                    name: "Interviewer",
                    email: "interviewer@example.com",
                  },
                  {
                    type: { code: "user_group", name: "User group" },
                    userGroup: { userGroupId: "G1", name: "Engineering" },
                  },
                ],
              },
            ],
          },
        };
      },
    });

    const lookup = await adapter.listInterviewers({
      recruitmentRef: "J456",
      candidateRef: "A1",
      candidateName: "Candidate",
    });

    expect(lookup.interviewers).toEqual([
      {
        ninehireUserId: "N1",
        displayName: "Interviewer",
        email: "interviewer@example.com",
        required: true,
      },
    ]);
    expect(lookup.unresolvedUserGroups).toEqual(["Engineering"]);
  });

  it("does not fall back to recruitment-wide participants when no active score sheet exists", async () => {
    const adapter = new NinehireRecruitmentWorkflowAdapter({
      async callTool(name) {
        if (name !== "get_applicant_progress") {
          throw new Error(`Unexpected tool: ${name}`);
        }
        return {
          structuredContent: {
            applicantProgressId: "A1",
            name: "Candidate",
            scoreSheets: [
              {
                status: { code: "done", name: "완료" },
                participants: [
                  { userId: "N1", name: "이전 평가자" },
                ],
              },
            ],
          },
        };
      },
    });

    await expect(
      adapter.listInterviewers({
        recruitmentRef: "R1",
        candidateRef: "A1",
        candidateName: "Candidate",
      }),
    ).resolves.toEqual({
      interviewers: [],
      unresolvedUserGroups: [],
      reason: "현재 단계에 배정된 미완료 평가표를 찾지 못했습니다.",
    });
  });

  it("uses only active score sheets marked as interview evaluations", async () => {
    const adapter = new NinehireRecruitmentWorkflowAdapter({
      async callTool(name) {
        if (name !== "get_applicant_progress") {
          throw new Error(`Unexpected tool: ${name}`);
        }
        return {
          structuredContent: {
            applicantProgressId: "A2",
            name: "Candidate",
            scoreSheets: [
              {
                status: { code: "waiting" },
                title: "서류 평가표",
                participants: [{ userId: "N-DOC", name: "채용 담당자" }],
              },
              {
                status: { code: "waiting" },
                title: "1차 인터뷰 평가표",
                participants: [{ userId: "N-INT", name: "실무 면접관" }],
              },
            ],
          },
        };
      },
    });

    await expect(adapter.listInterviewers({
      recruitmentRef: "J456",
      candidateRef: "A2",
      candidateName: "Candidate",
    })).resolves.toMatchObject({
      interviewers: [{ ninehireUserId: "N-INT", displayName: "실무 면접관" }],
    });
  });

  it("reads an ordered recruitment pipeline from NineHire", async () => {
    const adapter = new NinehireRecruitmentWorkflowAdapter({
      async callTool(name, args) {
        expect(name).toBe("get_recruitment");
        expect(args).toEqual({ recruitmentId: "R1" });
        return {
          structuredContent: {
            recruitmentId: "R1",
            title: "Recruitment",
            steps: [
              {
                stepId: "S2",
                title: "Second interview",
                name: "Second interview",
                order: 2,
                applicantCount: 3,
              },
              {
                stepId: "S1",
                title: "First interview",
                name: "First interview",
                order: 1,
                applicantCount: 4,
              },
            ],
          },
        };
      },
    });

    await expect(adapter.getRecruitmentPipeline("R1")).resolves.toEqual({
      recruitmentId: "R1",
      recruitmentName: "Recruitment",
      steps: [
        {
          stepId: "S1",
          title: "First interview",
          name: "First interview",
          order: 1,
          applicantCount: 4,
        },
        {
          stepId: "S2",
          title: "Second interview",
          name: "Second interview",
          order: 2,
          applicantCount: 3,
        },
      ],
    });
  });

  it("reads direct candidate schedules in Korea time without retaining contact details", async () => {
    const adapter = new NinehireRecruitmentWorkflowAdapter({
      async callTool(name, args) {
        expect(name).toBe("get_applicant_progresses");
        expect(args).toEqual({
          recruitmentId: "R1",
          applicantProgressIds: ["A1"],
          limit: 100,
        });
        return {
          structuredContent: {
            results: [
              {
                applicantProgressId: "A1",
                applicantEmail: "candidate@example.com",
                applicantPhone: "010-0000-0000",
                events: [
                  {
                    eventId: "E1",
                    type: { code: "single", name: "개별 일정" },
                    location: "회의실 미지정",
                    startAt: "2099-08-04T07:00:00.000Z",
                    endAt: "2099-08-04T08:00:00.000Z",
                    attendees: [{ name: "면접관" }],
                  },
                ],
              },
            ],
          },
        };
      },
    });

    await expect(
      adapter.listCandidateSchedules([
        {
          candidateRef: "A1",
          candidateName: "지원자",
          recruitmentRef: "R1",
          recruitmentName: "채용",
        },
      ]),
    ).resolves.toEqual([
      {
        eventId: "E1",
        candidateRef: "A1",
        candidateName: "지원자",
        recruitmentRef: "R1",
        recruitmentName: "채용",
        date: "2099-08-04",
        startTime: "16:00",
        endTime: "17:00",
        location: "회의실 미지정",
        attendeeNames: ["면접관"],
      },
    ]);
  });
});
