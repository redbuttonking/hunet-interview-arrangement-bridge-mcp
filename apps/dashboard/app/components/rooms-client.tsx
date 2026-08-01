"use client";
// 다우오피스 회의실 예약 블록과 로컬 인터뷰 배정을 캘린더 형태로 보여준다.

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CandidateCase, DashboardSnapshot } from "../lib/dashboard-types";

const calendarStartHour = 9;
const calendarEndHour = 18;
const calendarHours = Array.from({ length: calendarEndHour - calendarStartHour }, (_, index) => calendarStartHour + index);
const roomDisplayOrder = ["열정룸", "행복룸", "게임체인저", "의문당"];

function roomOrder(roomName: string) {
  const index = roomDisplayOrder.findIndex((name) => roomName.includes(name) || (name === "의문당" && roomName.includes("疑問堂")));
  return index === -1 ? roomDisplayOrder.length : index;
}

function toMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function formatCalendarDate(date: string) {
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(
    new Date(`${date}T00:00:00+09:00`),
  );
}

function shiftDate(date: string, amount: number) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return shifted.toISOString().slice(0, 10);
}

function todayInSeoul() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
}

function scheduleStatusLabel(status: CandidateCase["status"]) {
  return status === "CONFIRMED" ? "최종 확정" : "후보자 응답 대기";
}

function timeCardStyle(startTime: string, endTime: string) {
  const startBoundary = calendarStartHour * 60;
  const endBoundary = calendarEndHour * 60;
  const range = endBoundary - startBoundary;
  const start = Math.max(0, Math.min(range, toMinutes(startTime) - startBoundary));
  const end = Math.max(start, Math.min(range, toMinutes(endTime) - startBoundary));

  return {
    left: `${(start / range) * 100}%`,
    width: `${Math.max(((end - start) / range) * 100, 0.7)}%`,
  };
}

function RoomCalendarRow({
  roomName,
  blocks,
  scheduled,
}: {
  roomName: string;
  blocks: DashboardSnapshot["meetingRoomBlocks"];
  scheduled: CandidateCase[];
}) {
  return (
    <section className="calendar-room-row">
      <h3>{roomName}</h3>
      <div className="calendar-time-lane">
        {calendarHours.map((hour) => <span aria-hidden="true" className="calendar-hour-cell" key={hour} />)}
        {blocks.map((block) => (
          <span
            aria-label={`${block.startTime}부터 ${block.endTime}까지 인터뷰용 회의실 예약`}
            className="calendar-reservation-card"
            key={block.id}
            style={timeCardStyle(block.startTime, block.endTime)}
          >
            <strong>{block.startTime} – {block.endTime}</strong>
            <small>인터뷰 예약</small>
          </span>
        ))}
        {scheduled.map((interviewCase) => (
          <Link
            aria-label={`${interviewCase.candidateName ?? "후보자"} ${interviewCase.scheduledStartTime}부터 ${interviewCase.scheduledEndTime}까지 ${scheduleStatusLabel(interviewCase.status)}`}
            className={`calendar-interview-card ${interviewCase.status === "AWAITING_CANDIDATE_CONFIRMATION" ? "awaiting" : ""}`}
            href={`/cases/${interviewCase.id}`}
            key={interviewCase.id}
            style={timeCardStyle(interviewCase.scheduledStartTime ?? "09:00", interviewCase.scheduledEndTime ?? "09:00")}
            title={`${interviewCase.candidateName ?? "후보자 확인 필요"} · ${interviewCase.scheduledStartTime} – ${interviewCase.scheduledEndTime}`}
          >
            <strong>{interviewCase.scheduledStartTime} – {interviewCase.scheduledEndTime}</strong>
            <span>{interviewCase.candidateName ?? "후보자 확인 필요"}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function RoomsClient({ data }: { data: DashboardSnapshot }) {
  const dates = useMemo(() => [...new Set([
    ...data.meetingRoomBlocks.map((block) => block.date),
    ...data.dashboard.cases.map((interviewCase) => interviewCase.scheduledDate).filter((date): date is string => Boolean(date)),
  ])].sort(), [data]);
  const [selectedDate, setSelectedDate] = useState(dates[0] ?? todayInSeoul());
  const roomNames = useMemo(() => [...new Set([
    ...data.meetingRoomBlocks.map((block) => block.roomName),
    ...data.dashboard.cases.map((interviewCase) => interviewCase.scheduledRoomName).filter((roomName): roomName is string => Boolean(roomName)),
  ])].sort((left, right) => roomOrder(left) - roomOrder(right) || left.localeCompare(right, "ko-KR")), [data]);
  const blocks = data.meetingRoomBlocks.filter((block) => block.date === selectedDate);
  const scheduled = data.dashboard.cases.filter((interviewCase) =>
    interviewCase.scheduledDate === selectedDate &&
    ["CONFIRMED", "AWAITING_CANDIDATE_CONFIRMATION"].includes(interviewCase.status),
  );

  return (
    <main className="ops-shell room-page">
      <header className="app-header">
        <Link className="brand" href="/"><span className="brand-mark">H</span><span>HUNET <b>OPS</b></span></Link>
        <nav className="primary-nav" aria-label="대시보드 메뉴">
          <Link href="/">운영</Link>
          <Link className="active" href="/rooms">회의실</Link>
        </nav>
        <p className="room-sync-note">다우오피스 예약은 읽기 전용입니다.</p>
      </header>

      <section className="page-intro calendar-intro">
        <span className="section-kicker">ROOM CALENDAR</span>
        <h1>캘린더</h1>
        <p>회의실 예약 현황과 인터뷰 배정 시간을 한 화면에서 확인합니다.</p>
      </section>

      <section className="room-calendar" aria-label="회의실 예약 캘린더">
        <div className="calendar-toolbar">
          <div className="calendar-legend" aria-label="일정 범례">
            <span><i className="reservation-dot" />회의실 예약</span>
            <span><i className="interview-dot" />인터뷰 배정</span>
          </div>
          <div className="calendar-date-control">
            <button aria-label="이전 날짜" type="button" onClick={() => setSelectedDate((date) => shiftDate(date, -1))}>‹</button>
            <strong>{formatCalendarDate(selectedDate)}</strong>
            <button aria-label="다음 날짜" type="button" onClick={() => setSelectedDate((date) => shiftDate(date, 1))}>›</button>
            <button className="calendar-today-button" type="button" onClick={() => setSelectedDate(todayInSeoul())}>오늘</button>
          </div>
        </div>

        {roomNames.length > 0 ? (
          <div className="room-calendar-grid">
            <div className="calendar-header-row">
              <span>회의실</span>
              <div>{calendarHours.map((hour) => <span key={hour}>{String(hour).padStart(2, "0")}:00</span>)}</div>
            </div>
            {roomNames.map((roomName) => (
              <RoomCalendarRow
                blocks={blocks.filter((block) => block.roomName === roomName)}
                key={roomName}
                roomName={roomName}
                scheduled={scheduled.filter((interviewCase) => interviewCase.scheduledRoomName === roomName)}
              />
            ))}
          </div>
        ) : <p className="empty-message calendar-empty">동기화된 회의실 예약 정보가 없습니다.</p>}
      </section>
    </main>
  );
}
