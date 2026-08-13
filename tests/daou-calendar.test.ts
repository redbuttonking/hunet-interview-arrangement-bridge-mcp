// 다우오피스 캘린더 인터뷰 일정 파서를 검증한다.
import { describe, expect, it } from "vitest";
import {
  parseDaouInterviewCalendarEntries,
  parseDaouInterviewCalendarText,
} from "../src/domain/daou-calendar.js";

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

  it("extracts final interview events from the calendar API ISO times", () => {
    expect(parseDaouInterviewCalendarEntries([{
      title: "[면접] B2B 기업교육 AI 강사 인터뷰 (장세환)",
      startDateTime: "2026-08-04T16:00:00.000+09:00",
      endDateTime: "2026-08-04T17:00:00.000+09:00",
      location: "[818호] 행복룸",
    }])).toMatchObject([{
      candidateName: "장세환",
      recruitmentName: "B2B 기업교육 AI 강사 인터뷰",
      date: "2026-08-04",
      startTime: "16:00",
      endTime: "17:00",
      roomName: "[818호] 행복룸",
    }]);
  });

  it("normalizes calendar room aliases to the room reservation names", () => {
    expect(parseDaouInterviewCalendarEntries([
      {
        title: "[면접] 영업대표 인터뷰 (김가람)",
        startDateTime: "2026-08-11T10:00:00.000+09:00",
        endDateTime: "2026-08-11T11:00:00.000+09:00",
        location: "열정룸",
      },
      {
        title: "[면접] 영업대표 인터뷰 (이바다)",
        startDateTime: "2026-08-11T11:00:00.000+09:00",
        endDateTime: "2026-08-11T12:00:00.000+09:00",
        location: "의문당",
      },
    ])).toMatchObject([
      { roomName: "[818호] 열정룸" },
      { roomName: "[710호] 疑問堂(의문당)" },
    ]);
  });

  it("keeps the same source identifier when the DaouOffice event time is changed", () => {
    const [before] = parseDaouInterviewCalendarEntries([
      {
        sourceEventKey: "calendar-1:event-42",
        title: "[면접] B2B 교육영업 인터뷰 (김병진)",
        startDateTime: "2026-08-20T15:00:00+09:00",
        endDateTime: "2026-08-20T16:00:00+09:00",
      },
    ]);
    const [after] = parseDaouInterviewCalendarEntries([
      {
        sourceEventKey: "calendar-1:event-42",
        title: "[면접] B2B 교육영업 인터뷰 (김병진)",
        startDateTime: "2026-08-24T16:00:00+09:00",
        endDateTime: "2026-08-24T17:00:00+09:00",
      },
    ]);

    expect(after?.sourceEventId).toBe(before?.sourceEventId);
    expect(after).toMatchObject({ date: "2026-08-24", startTime: "16:00", endTime: "17:00" });
  });
});
