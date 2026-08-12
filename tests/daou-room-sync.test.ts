// 다우오피스 회의실 자동 동기화 기간을 검증한다.
import { describe, expect, it } from "vitest";
import {
  DAOU_ROOM_SYNC_WINDOW_DAYS,
  upcomingKoreanDates,
} from "../src/domain/daou-room-sync.js";

describe("DaouOffice meeting room synchronization window", () => {
  it("uses today in Korea through the following thirteen days", () => {
    const dates = upcomingKoreanDates(new Date("2026-08-11T16:30:00.000Z"));

    expect(dates).toHaveLength(DAOU_ROOM_SYNC_WINDOW_DAYS);
    expect(dates[0]).toBe("2026-08-12");
    expect(dates.at(-1)).toBe("2026-08-25");
  });

  it("rejects an empty synchronization window", () => {
    expect(() => upcomingKoreanDates(new Date(), 0)).toThrow(
      "DaouOffice room sync window must contain at least one day.",
    );
  });
});
