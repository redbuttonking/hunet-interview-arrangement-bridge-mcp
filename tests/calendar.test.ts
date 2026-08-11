import { describe, expect, it } from "vitest";
import {
  firstReminderAt,
  nextProposalWeekDates,
  normalizeSlots,
  proposalDates,
  secondReminderAt,
} from "../src/domain/calendar.js";

describe("proposalDates", () => {
  it("uses this Thursday and next Monday through Thursday on Monday", () => {
    expect(proposalDates("2026-07-27")).toEqual([
      "2026-07-30",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
    ]);
  });

  it("uses next Monday through Thursday on other weekdays", () => {
    expect(proposalDates("2026-07-24")).toEqual([
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
    ]);
  });

  it("keeps the proposed weekday pattern when moving to the next week", () => {
    expect(nextProposalWeekDates(["2026-08-18", "2026-08-19", "2026-08-20"])).toEqual([
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
    ]);
  });

  it("skips past proposal weeks while preserving the weekday pattern", () => {
    expect(
      nextProposalWeekDates(["2026-08-18", "2026-08-19", "2026-08-20"], "2026-09-01"),
    ).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });
});

describe("availability normalization", () => {
  it("deduplicates and combines contiguous one-hour slots", () => {
    expect(
      normalizeSlots([
        { date: "2026-07-30", start: "09:00", end: "10:00" },
        { date: "2026-07-30", start: "10:00", end: "11:00" },
        { date: "2026-07-30", start: "10:00", end: "11:00" },
        { date: "2026-07-31", start: "13:00", end: "14:00" },
      ]),
    ).toEqual([
      { date: "2026-07-30", start: "09:00", end: "11:00" },
      { date: "2026-07-31", start: "13:00", end: "14:00" },
    ]);
  });
});

describe("reminder policy", () => {
  it("schedules two business hours and next-business-day 10:00", () => {
    const sentAt = new Date("2026-07-27T01:00:00.000Z"); // Monday 10:00 KST
    const first = firstReminderAt(sentAt);
    expect(first.toISOString()).toBe("2026-07-27T03:00:00.000Z");
    expect(secondReminderAt(sentAt, first).toISOString()).toBe(
      "2026-07-28T01:00:00.000Z",
    );
  });

  it("carries business minutes over a weekend", () => {
    const sentAt = new Date("2026-07-24T08:30:00.000Z"); // Friday 17:30 KST
    const first = firstReminderAt(sentAt);
    expect(first.toISOString()).toBe("2026-07-27T01:30:00.000Z");
    expect(secondReminderAt(sentAt, first).toISOString()).toBe(
      "2026-07-28T01:00:00.000Z",
    );
  });
});
