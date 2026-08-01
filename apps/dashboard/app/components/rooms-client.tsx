"use client";
// 다우오피스 회의실 블록과 로컬 인터뷰 배정을 시간표로 보여준다.

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CandidateCase, DashboardSnapshot } from "../lib/dashboard-types";

const hours = Array.from({ length: 10 }, (_, index) => index + 9);

function hourIndex(value: string) {
  const hour = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  return hour - 9 + minutes / 60;
}

function gridSpan(start: string, end: string) {
  const startLine = Math.max(1, Math.floor(hourIndex(start)) + 1);
  const endLine = Math.min(11, Math.ceil(hourIndex(end)) + 1);
  return `${startLine} / ${Math.max(startLine + 1, endLine)}`;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short" }).format(
    new Date(`${date}T00:00:00+09:00`),
  );
}

function ScheduleBlock({ interviewCase }: { interviewCase: CandidateCase }) {
  if (!interviewCase.scheduledStartTime || !interviewCase.scheduledEndTime) return null;
  return (
    <Link
      href={`/cases/${interviewCase.id}`}
      className="room-schedule-block"
      style={{ gridColumn: gridSpan(interviewCase.scheduledStartTime, interviewCase.scheduledEndTime) }}
      title={`${interviewCase.candidateName ?? "후보자"} · ${interviewCase.scheduledStartTime}~${interviewCase.scheduledEndTime}`}
    >
      <strong>{interviewCase.candidateName ?? "후보자"}</strong>
      <span>{interviewCase.scheduledStartTime}~{interviewCase.scheduledEndTime}</span>
    </Link>
  );
}

export function RoomsClient({ data }: { data: DashboardSnapshot }) {
  const dates = useMemo(() => [...new Set([
    ...data.meetingRoomBlocks.map((block) => block.date),
    ...data.dashboard.cases.map((interviewCase) => interviewCase.scheduledDate).filter((date): date is string => Boolean(date)),
  ])].sort(), [data]);
  const [selectedDate, setSelectedDate] = useState(dates[0] ?? "");
  const blocks = data.meetingRoomBlocks.filter((block) => block.date === selectedDate);
  const roomNames = [...new Set(blocks.map((block) => block.roomName))];
  const scheduled = data.dashboard.cases.filter((interviewCase) =>
    interviewCase.scheduledDate === selectedDate &&
    ["CONFIRMED", "AWAITING_CANDIDATE_CONFIRMATION"].includes(interviewCase.status),
  );

  return (
    <main className="dashboard-shell room-page">
      <header className="topbar">
        <div>
          <span className="eyebrow">HUNET RECRUITING OPS</span>
          <h1>회의실·인터뷰 일정</h1>
        </div>
        <nav>
          <Link href="/">운영 보드</Link>
          <Link className="active-nav" href="/rooms">회의실·일정</Link>
        </nav>
        <p className="room-sync-note">다우오피스 예약은 읽기 전용입니다.</p>
      </header>

      <section className="room-overview">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ROOM UTILIZATION</span>
            <h2>확보된 회의실 안의 인터뷰 배정</h2>
          </div>
          <p>연한 영역은 다우오피스 예약 블록, 진한 영역은 로컬 인터뷰 확정 일정입니다.</p>
        </div>
        <div className="date-tabs">
          {dates.map((date) => (
            <button key={date} type="button" className={date === selectedDate ? "selected" : ""} onClick={() => setSelectedDate(date)}>
              {formatDate(date)}
            </button>
          ))}
        </div>
        {roomNames.length === 0 ? <p className="empty-message">동기화된 회의실 예약 블록이 없습니다.</p> : (
          <div className="room-grid-card">
            <div className="room-grid-header"><span>회의실</span><div>{hours.map((hour) => <span key={hour}>{hour}</span>)}</div></div>
            {roomNames.map((roomName) => {
              const roomBlocks = blocks.filter((block) => block.roomName === roomName);
              const roomSchedules = scheduled.filter((interviewCase) => interviewCase.scheduledRoomName === roomName);
              return (
                <section className="room-grid-row" key={roomName}>
                  <strong>{roomName}</strong>
                  <div className="room-timeline">
                    {hours.map((hour) => <span className="hour-cell" key={hour} />)}
                    {roomBlocks.map((block) => <span key={block.id} className="room-reserved-block" style={{ gridColumn: gridSpan(block.startTime, block.endTime) }} />)}
                    {roomSchedules.map((interviewCase) => <ScheduleBlock key={interviewCase.id} interviewCase={interviewCase} />)}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </section>

      <section className="upcoming-section">
        <div className="section-heading"><div><span className="eyebrow">UPCOMING</span><h2>확정 또는 후보자 응답 대기 일정</h2></div></div>
        <div className="upcoming-list">
          {scheduled.map((interviewCase) => (
            <Link href={`/cases/${interviewCase.id}`} key={interviewCase.id} className="upcoming-card">
              <strong>{interviewCase.candidateName ?? "후보자 확인 필요"}</strong>
              <span>{interviewCase.scheduledStartTime}~{interviewCase.scheduledEndTime}</span>
              <span>{interviewCase.scheduledRoomName ?? "회의실 확인 필요"}</span>
            </Link>
          ))}
          {scheduled.length === 0 ? <p className="empty-message">선택한 날짜에 확정된 인터뷰가 없습니다.</p> : null}
        </div>
      </section>
    </main>
  );
}
