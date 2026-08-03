"use client";
// 다우오피스 회의실 예약과 인터뷰 배정을 공통 캘린더 화면으로 보여준다.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, UsersRound } from "lucide-react";
import { AppHeader, PageHeader } from "./app-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
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
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(
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

type ScheduledCalendarItem = Pick<
  CandidateCase,
  "id" | "candidateName" | "status" | "scheduledRoomName" | "scheduledStartTime" | "scheduledEndTime"
> & { caseId: string };

function RoomCalendarRow({
  roomName,
  blocks,
  scheduled,
}: {
  roomName: string;
  blocks: DashboardSnapshot["meetingRoomBlocks"];
  scheduled: ScheduledCalendarItem[];
}) {
  return (
    <section className="grid min-w-[1140px] grid-cols-[180px_minmax(960px,1fr)] border-t border-slate-200 first:border-t-0">
      <h3 className="flex items-center border-r border-slate-200 bg-slate-50 px-5 text-base font-semibold tracking-tight text-slate-900">{roomName}</h3>
      <div className="relative grid min-h-32 grid-cols-9 overflow-hidden">
        {calendarHours.map((hour) => <span aria-hidden="true" className="border-r border-slate-100 bg-linear-to-b from-slate-50/80 to-white" key={hour} />)}
        {blocks.map((block) => (
          <span
            aria-label={`${block.startTime}부터 ${block.endTime}까지 인터뷰용 회의실 예약`}
            className="absolute top-3 grid h-9 min-w-1 overflow-hidden rounded-md border border-slate-300 bg-slate-100 px-2.5 text-sm font-semibold leading-8 text-slate-700 shadow-xs"
            key={block.id}
            style={timeCardStyle(block.startTime, block.endTime)}
          >
            <span className="truncate">{block.startTime} – {block.endTime}</span>
          </span>
        ))}
        {scheduled.map((interviewCase) => (
          <Link
            aria-label={`${interviewCase.candidateName ?? "후보자"} ${interviewCase.scheduledStartTime}부터 ${interviewCase.scheduledEndTime}까지 ${scheduleStatusLabel(interviewCase.status)}`}
            className={`absolute top-14 bottom-3 grid min-w-1 content-center gap-1 overflow-hidden rounded-lg border px-3 py-2 shadow-sm transition-transform hover:z-10 hover:-translate-y-0.5 ${interviewCase.status === "AWAITING_CANDIDATE_CONFIRMATION" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-blue-300 bg-blue-50 text-blue-950"}`}
            href={`/cases/${interviewCase.caseId}`}
            key={interviewCase.id}
            style={timeCardStyle(interviewCase.scheduledStartTime ?? "09:00", interviewCase.scheduledEndTime ?? "09:00")}
            title={`${interviewCase.candidateName ?? "후보자 확인 필요"} · ${interviewCase.scheduledStartTime} – ${interviewCase.scheduledEndTime}`}
          >
            <strong className="truncate text-sm font-semibold">{interviewCase.scheduledStartTime} – {interviewCase.scheduledEndTime}</strong>
            <span className="truncate text-sm">{interviewCase.candidateName ?? "후보자 확인 필요"}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function RoomsClient({ data }: { data: DashboardSnapshot }) {
  const dates = useMemo(() => [...new Set([
    ...data.meetingRoomBlocks.map((block) => block.date),
    ...data.dashboard.cases.flatMap((interviewCase) => interviewCase.scheduledSegments.map((segment) => segment.date)),
  ])].sort(), [data]);
  const preferredDate = useMemo(() => {
    const today = todayInSeoul();
    return dates.includes(today) ? today : dates.find((date) => date >= today) ?? dates[0] ?? today;
  }, [dates]);
  const [selectedDate, setSelectedDate] = useState(preferredDate);
  useEffect(() => {
    setSelectedDate((current) => dates.includes(current) ? current : preferredDate);
  }, [dates, preferredDate]);
  const roomNames = useMemo(() => {
    const discovered = [...new Set([
      ...data.meetingRoomBlocks.map((block) => block.roomName),
      ...data.dashboard.cases.flatMap((interviewCase) => interviewCase.scheduledSegments.map((segment) => segment.roomName)),
    ])];
    const preferred = roomDisplayOrder.map((room) => discovered.find((name) => name.includes(room) || (room === "의문당" && name.includes("疑問堂"))) ?? room);
    const additional = discovered.filter((name) => !preferred.some((preferredName) => preferredName === name));
    return [...preferred, ...additional].sort((left, right) => roomOrder(left) - roomOrder(right) || left.localeCompare(right, "ko-KR"));
  }, [data]);
  const blocks = data.meetingRoomBlocks.filter((block) => block.date === selectedDate);
  const scheduledCases = data.dashboard.cases.filter((interviewCase) =>
    interviewCase.scheduledSegments.some((segment) => segment.date === selectedDate) &&
    ["CONFIRMED", "AWAITING_CANDIDATE_CONFIRMATION"].includes(interviewCase.status),
  );
  const scheduled = scheduledCases.flatMap((interviewCase) =>
    interviewCase.scheduledSegments
      .filter((segment) => segment.date === selectedDate)
      .map((segment) => ({
        id: `${interviewCase.id}-${segment.stepId ?? segment.startTime}`,
        caseId: interviewCase.id,
        candidateName: interviewCase.candidateName,
        status: interviewCase.status,
        scheduledRoomName: segment.roomName,
        scheduledStartTime: segment.startTime,
        scheduledEndTime: segment.endTime,
      })),
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <AppHeader active="rooms" />
      <main className="mx-auto max-w-[1440px] px-5 pb-12 sm:px-8">
        <PageHeader eyebrow="ROOM CALENDAR" title="회의실 캘린더" description="다우오피스에 확보된 회의실 시간과 실제 인터뷰 배정을 같은 시간축에서 확인합니다." />

        <Card className="overflow-hidden">
          <CardHeader className="gap-5 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
              <span className="flex items-center gap-2"><i className="size-2.5 rounded-sm bg-slate-300" />회의실 예약</span>
              <span className="flex items-center gap-2"><i className="size-2.5 rounded-sm bg-blue-500" />인터뷰 배정</span>
              <Badge variant="outline">다우오피스 읽기 전용</Badge>
            </div>
            <div className="flex items-center gap-2 sm:absolute sm:left-1/2 sm:-translate-x-1/2">
              <Button aria-label="이전 날짜" size="icon-sm" variant="ghost" onClick={() => setSelectedDate((date) => shiftDate(date, -1))}><ChevronLeft className="size-5" /></Button>
              <CardTitle className="min-w-52 text-center text-xl">{formatCalendarDate(selectedDate)}</CardTitle>
              <Button aria-label="다음 날짜" size="icon-sm" variant="ghost" onClick={() => setSelectedDate((date) => shiftDate(date, 1))}><ChevronRight className="size-5" /></Button>
              <Button size="sm" onClick={() => setSelectedDate(todayInSeoul())}>오늘</Button>
            </div>
            <div className="hidden min-w-60 sm:block" />
          </CardHeader>

          <CardContent className="p-0">
            {roomNames.length > 0 ? (
              <div className="overflow-x-auto">
                <div className="grid min-w-[1140px] grid-cols-[180px_minmax(960px,1fr)] bg-slate-50 text-sm font-semibold text-slate-600">
                  <span className="flex h-11 items-center border-r border-slate-200 px-5">회의실</span>
                  <div className="grid grid-cols-9">{calendarHours.map((hour) => <span className="flex h-11 items-center border-r border-slate-200 px-3" key={hour}>{String(hour).padStart(2, "0")}:00</span>)}</div>
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
            ) : <div className="grid min-h-72 place-items-center p-8 text-center"><div><CalendarDays className="mx-auto size-8 text-slate-400" /><p className="mt-4 text-lg font-semibold">동기화된 회의실 예약 정보가 없습니다.</p><p className="mt-2 text-base text-slate-600">다우오피스 회의실 동기화가 완료되면 이곳에 표시됩니다.</p></div></div>}
          </CardContent>
        </Card>

        <div className="mt-5 flex items-center gap-2 text-sm leading-6 text-slate-600"><Clock3 className="size-4 shrink-0 text-slate-400" />예약 블록은 취소하지 않고 유지합니다. 인터뷰를 취소하거나 변경해도 다우오피스의 기존 회의실 예약에는 영향을 주지 않습니다.</div>
        {scheduledCases.length > 0 ? <div className="mt-4 flex items-center gap-2 text-sm text-slate-600"><UsersRound className="size-4 text-blue-600" />선택한 날짜에 인터뷰 {scheduledCases.length}건이 배정되어 있습니다.</div> : null}
      </main>
    </div>
  );
}
