// 다우오피스 캘린더 인터뷰 일정 파서를 검증한다.
import { describe, expect, it } from "vitest";
import { parseDaouInterviewCalendarText } from "../src/domain/daou-calendar.js";

describe("DaouOffice interview calendar parser", () => {
  it("extracts interview title, candidate, date, and Korean time range", () => {
    expect(parseDaouInterviewCalendarText(`
      2026년 8월 4일 화요일
      [면접] B2B 기업교육 AI 강사 인터뷰 (장세환)
      오후 04:00 ~ 오후 05:00
    `)).toMatchObject([{
      title: "[면접] B2B 기업교육 AI 강사 인터뷰 (장세환)",
      recruitmentName: "B2B 기업교육 AI 강사 인터뷰",
      candidateName: "장세환",
      date: "2026-08-04",
      startTime: "16:00",
      endTime: "17:00",
    }]);
  });

  it("deduplicates repeated calendar nodes and ignores non-interview events", () => {
    const events = parseDaouInterviewCalendarText(`
      2026. 08. 04
      [회의] 운영 회의 (홍길동)
      오후 02:00 ~ 오후 03:00
      [면접] 데이터 엔지니어 인터뷰 (김누리)
      16:00 ~ 17:00
      [면접] 데이터 엔지니어 인터뷰 (김누리)
      16:00 ~ 17:00
    `);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ date: "2026-08-04", startTime: "16:00", endTime: "17:00" });
  });

  it("handles an event title and time rendered on one line", () => {
    expect(parseDaouInterviewCalendarText(`2026-08-04 [면접] 데이터 엔지니어 인터뷰 (김누리) 16:00 ~ 17:00`)).toMatchObject([{
      candidateName: "김누리",
      date: "2026-08-04",
      startTime: "16:00",
      endTime: "17:00",
    }]);
  });
});
