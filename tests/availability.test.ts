import { describe, expect, it } from "vitest";
import type { CaseBundle } from "../src/db/database.js";
import { suggestCommonSlots } from "../src/domain/availability.js";

describe("common availability", () => {
  it("intersects required interviewers and honors variable duration", () => {
    const bundle: CaseBundle = {
      interviewCase: {
        id: "case",
        notificationId: null,
        candidateRef: null,
        candidateName: "지원자",
        recruitmentRef: null,
        recruitmentName: "채용",
        status: "READY_TO_SCHEDULE",
        durationMinutes: 90,
        proposalDates: ["2026-07-30"],
        scheduleRound: 1,
        scheduledRoomAllocationId: null,
        scheduledDate: null,
        scheduledStartTime: null,
        scheduledEndTime: null,
        internalScheduleConfirmedAt: null,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
      interviewers: [
        {
          id: "required-1",
          caseId: "case",
          ninehireUserId: "N1",
          slackUserId: "U1",
          displayName: "필수1",
          email: null,
          required: true,
          active: true,
          source: "NINEHIRE",
          status: "SUBMITTED",
          respondedAt: "2026-07-24T00:00:00.000Z",
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        },
        {
          id: "required-2",
          caseId: "case",
          ninehireUserId: "N2",
          slackUserId: "U2",
          displayName: "필수2",
          email: null,
          required: true,
          active: true,
          source: "NINEHIRE",
          status: "SUBMITTED",
          respondedAt: "2026-07-24T00:00:00.000Z",
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        },
      ],
      availability: [
        {
          interviewerId: "required-1",
          date: "2026-07-30",
          start: "09:00",
          end: "12:00",
        },
        {
          interviewerId: "required-2",
          date: "2026-07-30",
          start: "10:00",
          end: "12:00",
        },
      ],
      drafts: [],
    };

    expect(suggestCommonSlots(bundle).suggestions).toEqual([
      {
        date: "2026-07-30",
        start: "10:00",
        end: "11:30",
        optionalAvailable: [],
        optionalUnavailable: [],
      },
    ]);
  });

  it("offers half-hour starts when a case duration is thirty minutes", () => {
    const bundle: CaseBundle = {
      interviewCase: {
        id: "case",
        notificationId: null,
        candidateRef: null,
        candidateName: "지원자",
        recruitmentRef: null,
        recruitmentName: "채용",
        status: "READY_TO_SCHEDULE",
        durationMinutes: 30,
        proposalDates: ["2026-07-30"],
        scheduleRound: 1,
        scheduledRoomAllocationId: null,
        scheduledDate: null,
        scheduledStartTime: null,
        scheduledEndTime: null,
        internalScheduleConfirmedAt: null,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
      interviewers: [
        {
          id: "required-1",
          caseId: "case",
          ninehireUserId: "N1",
          slackUserId: "U1",
          displayName: "필수 면접관",
          email: null,
          required: true,
          active: true,
          source: "NINEHIRE",
          status: "SUBMITTED",
          respondedAt: "2026-07-24T00:00:00.000Z",
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        },
      ],
      availability: [
        {
          interviewerId: "required-1",
          date: "2026-07-30",
          start: "09:00",
          end: "10:00",
        },
      ],
      drafts: [],
    };

    expect(suggestCommonSlots(bundle).suggestions).toMatchObject([
      { start: "09:00", end: "09:30" },
      { start: "09:30", end: "10:00" },
    ]);
  });
});
