import { describe, expect, it } from "vitest";
import {
  buildAvailabilityModal,
  buildRequestMessage,
  buildScheduleConfirmationMessage,
} from "../src/slack/blocks.js";
import type {
  CaseBundle,
  CaseInterviewPlanRow,
  ConfirmedInterviewScheduleRow,
  InterviewCaseRow,
  InterviewerRow,
} from "../src/db/database.js";

const interviewCase: InterviewCaseRow = {
  id: "11111111-1111-4111-8111-111111111111",
  notificationId: null,
  candidateRef: null,
  candidateName: "홍길동",
  recruitmentRef: null,
  recruitmentName: "백엔드 엔지니어",
  status: "READY_FOR_DRAFT",
  durationMinutes: 60,
  proposalDates: [
    "2026-07-30",
    "2026-08-03",
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
  ],
  scheduleRound: 1,
  scheduledRoomAllocationId: null,
  scheduledRoomName: null,
  scheduledDate: null,
  scheduledStartTime: null,
  scheduledEndTime: null,
  internalScheduleConfirmedAt: null,
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
};

const interviewer: InterviewerRow = {
  id: "22222222-2222-4222-8222-222222222222",
  caseId: interviewCase.id,
  ninehireUserId: "N1",
  slackUserId: "U1",
  displayName: "면접관",
  email: "interviewer@example.com",
  required: true,
  active: true,
  source: "NINEHIRE",
  status: "PENDING",
  respondedAt: null,
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
};

describe("availability modal", () => {
  it("has one all-day option plus nine hourly options per date", () => {
    const modal = buildAvailabilityModal(interviewCase, interviewer);
    const dateBlocks = modal.blocks.filter(
      (block) => "block_id" in block && block.block_id?.startsWith("date_"),
    );
    expect(dateBlocks).toHaveLength(5);
    for (const block of dateBlocks) {
      if (
        block.type !== "input" ||
        !("element" in block) ||
        block.element.type !== "checkboxes"
      ) {
        throw new Error("Expected checkbox input block.");
      }
      expect(block.element.options).toHaveLength(10);
    }
    expect(modal.blocks.length).toBeLessThanOrEqual(100);
  });

  it("shows each sequential interview stage and its assigned interviewer", () => {
    const secondInterviewer: InterviewerRow = {
      ...interviewer,
      id: "33333333-3333-4333-8333-333333333333",
      slackUserId: "U2",
      displayName: "면접관 2",
    };
    const bundle: CaseBundle = {
      interviewCase,
      interviewers: [interviewer, secondInterviewer],
      availability: [],
      drafts: [],
    };
    const plan: CaseInterviewPlanRow = {
      caseId: interviewCase.id,
      source: "CANDIDATE_OVERRIDE",
      mode: "SEQUENTIAL",
      stepIds: ["S1", "S2"],
      stepNames: ["1차 인터뷰", "2차 인터뷰"],
      interviewerIds: [interviewer.id, secondInterviewer.id],
      sessions: [
        {
          stepId: "S1",
          stepName: "1차 인터뷰",
          interviewerIds: [interviewer.id],
        },
        {
          stepId: "S2",
          stepName: "2차 인터뷰",
          interviewerIds: [secondInterviewer.id],
        },
      ],
      durationMinutes: 120,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    };
    const schedule: ConfirmedInterviewScheduleRow = {
      caseId: interviewCase.id,
      roomAllocationId: null,
      date: "2026-07-30",
      startTime: "13:00",
      endTime: "15:00",
      roomName: "행복룸 → 열정룸",
      confirmedAt: "2026-07-24T00:00:00.000Z",
    };

    const request = buildRequestMessage(bundle, { plan });
    const confirmation = buildScheduleConfirmationMessage(bundle, schedule, {
      sequentialSessions: [
        {
          ...plan.sessions[0]!,
          startTime: "13:00",
          endTime: "14:00",
          roomName: "행복룸",
        },
        {
          ...plan.sessions[1]!,
          startTime: "14:00",
          endTime: "15:00",
          roomName: "열정룸",
        },
      ],
    });

    expect(JSON.stringify(request.blocks)).toContain("단계별 인터뷰 및 면접관");
    expect(JSON.stringify(request.blocks)).toContain("1차 인터뷰");
    expect(JSON.stringify(request.blocks)).toContain("<@U1>");
    expect(JSON.stringify(request.blocks)).toContain("<@U2>");
    expect(JSON.stringify(confirmation.blocks)).toContain("단계별 인터뷰 일정");
    expect(JSON.stringify(confirmation.blocks)).toContain("13:00~14:00 · 행복룸");
    expect(JSON.stringify(confirmation.blocks)).toContain("14:00~15:00 · 열정룸");
  });
});
