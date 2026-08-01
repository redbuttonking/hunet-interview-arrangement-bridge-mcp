"use client";
// 다우오피스 회의실 예약 블록과 로컬 인터뷰 배정을 읽기 쉬운 일정표로 보여준다.

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CandidateCase, DashboardSnapshot } from "../lib/dashboard-types";

const timelineMarkers = [9, 12, 15, 18];
const timelineStartHour = 9;
const timelineEndHour = 18;

function toMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short" }).format(
    new Date(`${date}T00:00:00+09:00`),
  );
}

function formatDuration(startTime: string, endTime: string) {
  const duration = toMinutes(endTime) - toMinutes(startTime);
  const hours = Math.floor(duration / 60);
  const minutes = duration % 60;

  if (minutes === 0) return `${hours}시간`;
  if (hours === 0) return `${minutes}분`;
  return `${hours}시간 ${minutes}분`;
}

function trackStyle(startTime: string, endTime: string) {
  const range = (timelineEndHour - timelineStartHour) * 60;
  const start = Math.max(0, Math.min(range, toMinutes(startTime) - timelineStartHour * 60));
  const end = Math.max(start, Math.min(range, toMinutes(endTime) - timelineStartHour * 60));

  return {
    left: `${(start / range) * 100}%`,
    width: `${((end - start) / range) * 100}%`,
  };
}

function isScheduledInsideBlock(
  interviewCase: CandidateCase,
  block: DashboardSnapshot["meetingRoomBlocks"][number],
) {
  if (!interviewCase.scheduledStartTime || !interviewCase.scheduledEndTime) return false;
  return interviewCase.scheduledStartTime < block.endTime && interviewCase.scheduledEndTime > block.startTime;
}

function scheduleStatusLabel(status: CandidateCase["status"]) {
  return status === "CONFIRMED" ? "최종 확정" : "후보자 응답 대기";
}

function ReservationRow({
  block,
  schedules,
}: {
  block: DashboardSnapshot["meetingRoomBlocks"][number];
  schedules: CandidateCase[];
}) {
  return (
    <article className="reservation-row">
      <div className="reservation-summary">
        <strong>{block.startTime} – {block.endTime}</strong>
        <span>인터뷰 예약 · {formatDuration(block.startTime, block.endTime)} 확보</span>
      </div>
      <div className="reservation-track-wrap">
        <div className="reservation-track" aria-hidden="true">
          <span className="reservation-track-bar" style={trackStyle(block.startTime, block.endTime)} />
        </div>
      </div>
      <div className="reservation-allocations">
        {schedules.length > 0 ? schedules.map((interviewCase) => (
          <Link href={`/cases/${interviewCase.id}`} key={interviewCase.id} className="allocation-pill">
            <strong>{interviewCase.candidateName ?? "후보자 확인 필요"}</strong>
            <span>{interviewCase.scheduledStartTime} – {interviewCase.scheduledEndTime} · {scheduleStatusLabel(interviewCase.status)}</span>
          </Link>
        )) : <span className="allocation-empty">아직 배정된 인터뷰가 없습니다.</span>}
      </div>
    </article>
  );
}

function RoomCard({
  roomName,
  blocks,
  schedules,
}: {
  roomName: string;
  blocks: DashboardSnapshot["meetingRoomBlocks"];
  schedules: CandidateCase[];
}) {
  return (
    <section className="room-card">
      <header className="room-card-header">
        <div>
          <span className="room-card-label">MEETING ROOM</span>
          <h3>{roomName}</h3>
        </div>
        <span className="room-block-count">예약 블록 {blocks.length}개</span>
      </header>
      <div className="room-time-ruler" aria-hidden="true">
        {timelineMarkers.map((hour) => <span key={hour} style={{ left: `${((hour - timelineStartHour) / (timelineEndHour - timelineStartHour)) * 100}%` }}>{String(hour).padStart(2, "0")}:00</span>)}
      </div>
      <div className="reservation-list">
        {blocks.length > 0 ? blocks.map((block) => (
          <ReservationRow
            block={block}
            key={block.id}
            schedules={schedules.filter((interviewCase) => isScheduledInsideBlock(interviewCase, block))}
          />
        )) : <p className="room-missing-reservation">다우오피스에서 동기화된 예약 블록이 없습니다.</p>}
      </div>
    </section>
  );
}

export function RoomsClient({ data }: { data: DashboardSnapshot }) {
  const dates = useMemo(() => [...new Set([
    ...data.meetingRoomBlocks.map((block) => block.date),
    ...data.dashboard.cases.map((interviewCase) => interviewCase.scheduledDate).filter((date): date is string => Boolean(date)),
  ])].sort(), [data]);
  const [selectedDate, setSelectedDate] = useState(dates[0] ?? "");
  const blocks = data.meetingRoomBlocks.filter((block) => block.date === selectedDate);
  const scheduled = data.dashboard.cases.filter((interviewCase) =>
    interviewCase.scheduledDate === selectedDate &&
    ["CONFIRMED", "AWAITING_CANDIDATE_CONFIRMATION"].includes(interviewCase.status),
  );
  const roomNames = [...new Set([
    ...blocks.map((block) => block.roomName),
    ...scheduled.map((interviewCase) => interviewCase.scheduledRoomName).filter((roomName): roomName is string => Boolean(roomName)),
  ])].sort();

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

      <section className="page-intro">
        <span className="section-kicker">ROOM SCHEDULE</span>
        <h1>회의실과 인터뷰 일정</h1>
        <p>회의실을 확보한 시간과 그 안에 배정된 인터뷰를 함께 확인합니다.</p>
      </section>

      <section className="room-overview">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ROOM UTILIZATION</span>
            <h2>확보 시간과 인터뷰 배정</h2>
          </div>
          <p>예약 블록은 시간 범위를, 진한 일정 카드는 실제 인터뷰 배정을 보여줍니다.</p>
        </div>
        <div className="date-tabs" aria-label="회의실 일정 날짜 선택">
          {dates.map((date) => (
            <button key={date} type="button" className={date === selectedDate ? "selected" : ""} onClick={() => setSelectedDate(date)}>
              {formatDate(date)}
            </button>
          ))}
        </div>

        <div className="room-schedule-layout">
          <div className="room-card-list">
            {roomNames.length > 0 ? roomNames.map((roomName) => (
              <RoomCard
                blocks={blocks.filter((block) => block.roomName === roomName)}
                key={roomName}
                roomName={roomName}
                schedules={scheduled.filter((interviewCase) => interviewCase.scheduledRoomName === roomName)}
              />
            )) : <p className="empty-message">선택한 날짜에 동기화된 회의실 예약 블록이 없습니다.</p>}
          </div>

          <aside className="daily-agenda">
            <div className="daily-agenda-header">
              <div>
                <span className="eyebrow">DAILY AGENDA</span>
                <h2>선택한 날짜 인터뷰</h2>
              </div>
              <strong>{scheduled.length}<small>건</small></strong>
            </div>
            <div className="daily-agenda-list">
              {scheduled.map((interviewCase) => (
                <Link href={`/cases/${interviewCase.id}`} key={interviewCase.id} className="daily-agenda-item">
                  <span>{interviewCase.scheduledStartTime} – {interviewCase.scheduledEndTime}</span>
                  <strong>{interviewCase.candidateName ?? "후보자 확인 필요"}</strong>
                  <small>{interviewCase.scheduledRoomName ?? "회의실 확인 필요"} · {scheduleStatusLabel(interviewCase.status)}</small>
                </Link>
              ))}
              {scheduled.length === 0 ? <p className="empty-message">확정되었거나 후보자 응답을 기다리는 인터뷰가 없습니다.</p> : null}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
