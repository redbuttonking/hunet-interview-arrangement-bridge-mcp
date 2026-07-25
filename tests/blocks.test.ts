import { describe, expect, it } from "vitest";
import { buildAvailabilityModal } from "../src/slack/blocks.js";
import type {
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
});
