"use client";
// 다우오피스 회의실 예약과 인터뷰 배정을 같은 시간축에서 확인한다.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Loader2, RefreshCw, UsersRound } from "lucide-react";
import { AppHeader, PageHeader } from "./app-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import type { DashboardSnapshot, DataFreshness } from "../lib/dashboard-types";

const calendarStartHour = 9;
const calendarEndHour = 18;
const calendarHours = Array.from({ length: calendarEndHour - calendarStartHour }, (_, index) => calendarStartHour + index);
const roomDisplayOrder = [
  { label: "[818호] 열정룸", aliases: ["[818호] 열정룸", "열정룸"] },
  { label: "[818호] 행복룸", aliases: ["[818호] 행복룸", "행복룸"] },
  { label: "게임체인저", aliases: ["게임체인저"] },
  { label: "[710호] 疑問堂(의문당)", aliases: ["[710호] 疑問堂(의문당)", "의문당", "疑問堂"] },
] as const;

function roomOrder(roomName: string) {
  const index = roomDisplayOrder.findIndex((room) => room.aliases.some((alias) => roomName.includes(alias)));
  return index === -1 ? roomDisplayOrder.length : index;
}

function roomMatches(roomName: string, roomLabel: string) {
  const room = roomDisplayOrder.find((item) => item.label === roomLabel);
  return room?.aliases.some((alias) => roomName.includes(alias)) ?? roomName === roomLabel;
}

function canonicalRoomName(roomName: string) {
  const room = roomDisplayOrder.find((item) => item.aliases.some((alias) => roomName.includes(alias)));
  return room?.label ?? roomName;
}

function toMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function formatCalendarDate(date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return "날짜 미정";
  const [, year, month, day] = match;
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()
  ];
  return `${year}년 ${Number(month)}월 ${Number(day)}일 (${weekday})`;
}

function shiftDate(date: string, amount: number) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return shifted.toISOString().slice(0, 10);
}

function todayInSeoul(value?: string) {
  const base = value ? new Date(value) : new Date();
  const shifted = new Date(base.getTime() + 9 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function scheduleStatusLabel(item: ScheduledCalendarItem) {
  if (item.source === "DAOU_OFFICE_CALENDAR") return "다우오피스 확정";
  return item.status === "CONFIRMED" ? "최종 확정" : "후보자 응답 대기";
}

function timeCardStyle(startTime: string, endTime: string) {
  const startBoundary = calendarStartHour * 60;
  const endBoundary = calendarEndHour * 60;
  const range = endBoundary - startBoundary;
  const start = Math.max(0, Math.min(range, toMinutes(startTime) - startBoundary));
  const end = Math.max(start, Math.min(range, toMinutes(endTime) - startBoundary));

  return {
    left: `${(start / range) * 100}%`,
    width: `${Math.max(((end - start) / range) * 100, 1.2)}%`,
  };
}

function freshnessCopy(freshness: DataFreshness) {
  if (freshness.state === "FRESH") return { label: "회의실 정보 최신", variant: "success" as const, description: "최근 동기화된 예약 정보입니다." };
  if (freshness.state === "STALE") return { label: "회의실 정보 갱신 필요", variant: "warning" as const, description: "마지막 동기화가 오래되어 새로고침 후 추천하세요." };
  return { label: "회의실 정보 확인 필요", variant: "secondary" as const, description: "아직 회의실 동기화가 확인되지 않았습니다." };
}

type ScheduledCalendarItem = {
  id: string;
  caseId?: string;
  candidateName: string | null;
  recruitmentName: string | null;
  status?: "CONFIRMED" | "AWAITING_CANDIDATE_CONFIRMATION";
  source: "LOCAL" | "DAOU_OFFICE_CALENDAR";
  roomName: string;
  startTime: string;
  endTime: string;
  href: string | null;
};

type TimedItem = {
  id: string;
  startTime: string;
  endTime: string;
};

function layoutTimedItems<T extends TimedItem>(items: T[]) {
  const lanes: number[] = [];
  return [...items]
    .sort((left, right) => toMinutes(left.startTime) - toMinutes(right.startTime) || toMinutes(left.endTime) - toMinutes(right.endTime))
    .map((item) => {
      const start = toMinutes(item.startTime);
      const lane = lanes.findIndex((end) => end <= start);
      const laneIndex = lane === -1 ? lanes.length : lane;
      lanes[laneIndex] = toMinutes(item.endTime);
      return { item, lane: laneIndex };
    });
}

function RoomCalendarRow({
  roomName,
  blocks,
  scheduled,
}: {
  roomName: string;
  blocks: DashboardSnapshot["meetingRoomBlocks"];
  scheduled: ScheduledCalendarItem[];
}) {
  const blockLayouts = layoutTimedItems(blocks);
  const scheduledLayouts = layoutTimedItems(scheduled);
  const reservationHeight = Math.max(blockLayouts.length > 0 ? blockLayouts[blockLayouts.length - 1]!.lane + 1 : 0, 1) * 38;
  const assignedHeight = Math.max(scheduledLayouts.length > 0 ? scheduledLayouts[scheduledLayouts.length - 1]!.lane + 1 : 0, 1) * 82;
  const rowHeight = Math.max(164, 20 + reservationHeight + assignedHeight);
  const hasItems = blockLayouts.length > 0 || scheduledLayouts.length > 0;

  return (
    <section className="grid min-w-[1280px] grid-cols-[188px_minmax(1092px,1fr)] border-t border-slate-200 first:border-t-0" style={{ minHeight: rowHeight }}>
      <h3 className="sticky left-0 z-20 flex items-start border-r border-slate-200 bg-white px-5 pt-6 text-base font-bold tracking-tight text-slate-900">{roomName}</h3>
      <div className="relative overflow-hidden bg-white" style={{ minHeight: rowHeight }}>
        <div aria-hidden="true" className="absolute inset-0 grid grid-cols-9">
          {calendarHours.map((hour) => <span className="border-r border-slate-100 bg-linear-to-b from-slate-50/60 to-white" key={hour} />)}
        </div>
        {blockLayouts.map(({ item: block, lane }) => (
          <span
            aria-label={`${block.startTime}부터 ${block.endTime}까지 인터뷰용 회의실 예약`}
            className="absolute z-10 flex min-w-0 items-center overflow-hidden rounded-md border border-slate-300 bg-slate-100 px-2.5 text-sm font-semibold text-slate-700 shadow-xs"
            key={block.id}
            style={{ ...timeCardStyle(block.startTime, block.endTime), top: `${12 + lane * 38}px`, height: "30px" }}
            title={`회의실 예약 · ${block.startTime} – ${block.endTime}`}
          >
            <span className="truncate">예약 {block.startTime} – {block.endTime}</span>
          </span>
        ))}
        {scheduledLayouts.map(({ item: interview, lane }) => {
          const status = scheduleStatusLabel(interview);
          const duration = toMinutes(interview.endTime) - toMinutes(interview.startTime);
          const isCompact = duration < 60;
          const className = `absolute z-10 grid min-w-0 content-center gap-0.5 overflow-hidden rounded-lg border shadow-sm transition-[transform,box-shadow] hover:z-20 hover:-translate-y-0.5 hover:shadow-md ${isCompact ? "px-1.5 py-1" : "px-3 py-2"} ${interview.source === "DAOU_OFFICE_CALENDAR" ? "border-emerald-300 bg-emerald-50 text-emerald-950" : interview.status === "AWAITING_CANDIDATE_CONFIRMATION" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-blue-300 bg-blue-50 text-blue-950"}`;
          const style = { ...timeCardStyle(interview.startTime, interview.endTime), top: `${54 + lane * 82}px`, height: "70px" };
          const content = <>
            <strong className={`${isCompact ? "text-[11px] leading-4" : "text-base leading-5"} truncate font-bold tabular-nums`}>{isCompact ? interview.startTime : `${interview.startTime} – ${interview.endTime}`}</strong>
            <span className={`${isCompact ? "text-[11px] leading-4" : "text-sm leading-5"} truncate font-semibold`}>{interview.candidateName ?? "후보자 확인 필요"}</span>
            {!isCompact ? <span className="truncate text-xs leading-4 opacity-75">{status}</span> : null}
          </>;
          return interview.href ? (
            <Link
              aria-label={`${interview.candidateName ?? "후보자"} ${interview.startTime}부터 ${interview.endTime}까지 ${status}`}
              className={className}
              href={interview.href}
              key={interview.id}
              style={style}
              title={`${interview.candidateName ?? "후보자 확인 필요"} · ${interview.startTime} – ${interview.endTime}`}
            >
              {content}
            </Link>
          ) : (
            <div
              aria-label={`${interview.candidateName ?? "후보자"} ${interview.startTime}부터 ${interview.endTime}까지 ${status}`}
              className={className}
              key={interview.id}
              style={style}
              title={`${interview.candidateName ?? "후보자 확인 필요"} · ${interview.startTime} – ${interview.endTime}`}
            >
              {content}
            </div>
          );
        })}
        {!hasItems ? <span className="absolute inset-0 grid place-items-center text-sm text-slate-400">예약 없음</span> : null}
      </div>
    </section>
  );
}

export function RoomsClient({ data }: { data: DashboardSnapshot }) {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();
  const dates = useMemo(() => [...new Set([
    ...data.meetingRoomBlocks.map((block) => block.date),
    ...data.dashboard.cases.flatMap((interviewCase) => [
      ...interviewCase.scheduledSegments.map((segment) => segment.date),
      ...(interviewCase.scheduledDate ? [interviewCase.scheduledDate] : []),
    ]),
    ...(data.externalConfirmedInterviews ?? []).map((interview) => interview.date),
  ])].sort(), [data]);
  const preferredDate = useMemo(() => {
    // 데이터가 만들어진 시각이 아니라 사용자가 화면을 여는 실제 날짜를 기준으로 한다.
    return todayInSeoul();
  }, []);
  const [selectedDate, setSelectedDate] = useState(preferredDate);
  useEffect(() => {
    setSelectedDate((current) => dates.includes(current) ? current : preferredDate);
  }, [dates, preferredDate]);

  const discoveredRoomNames = useMemo(() => [...new Set([
    ...data.meetingRoomBlocks.map((block) => block.roomName),
    ...data.dashboard.cases.flatMap((interviewCase) => [
      ...interviewCase.scheduledSegments.map((segment) => segment.roomName),
      ...(interviewCase.scheduledRoomName ? [interviewCase.scheduledRoomName] : []),
    ]),
    ...(data.externalConfirmedInterviews ?? []).flatMap((interview) => interview.roomName ? [interview.roomName] : []),
  ])], [data]);
  const roomNames = useMemo(() => {
    if (discoveredRoomNames.length === 0) return [];
    const canonicalNames = [...new Set(discoveredRoomNames.map(canonicalRoomName))];
    const preferred = roomDisplayOrder.map((room) => room.label).filter((roomName) => canonicalNames.includes(roomName));
    const additional = canonicalNames.filter((roomName) => !roomDisplayOrder.some((room) => room.label === roomName));
    return [...preferred, ...additional].sort((left, right) => {
      const orderDifference = roomOrder(left) - roomOrder(right);
      if (orderDifference !== 0) return orderDifference;
      return left.localeCompare(right, "ko");
    });
  }, [discoveredRoomNames]);
  const blocks = data.meetingRoomBlocks.filter((block) => block.date === selectedDate);
  const scheduledCases = data.dashboard.cases.filter((interviewCase) =>
    (interviewCase.scheduledSegments.some((segment) => segment.date === selectedDate) ||
      (interviewCase.scheduledSegments.length === 0 && interviewCase.scheduledDate === selectedDate)) &&
    ["CONFIRMED", "AWAITING_CANDIDATE_CONFIRMATION"].includes(interviewCase.status),
  );
  const scheduled: ScheduledCalendarItem[] = scheduledCases.flatMap((interviewCase) => {
    const segments = interviewCase.scheduledSegments.length > 0
      ? interviewCase.scheduledSegments
      : interviewCase.scheduledDate && interviewCase.scheduledStartTime && interviewCase.scheduledEndTime && interviewCase.scheduledRoomName
        ? [{
            stepId: null,
            roomName: interviewCase.scheduledRoomName,
            date: interviewCase.scheduledDate,
            startTime: interviewCase.scheduledStartTime,
            endTime: interviewCase.scheduledEndTime,
          }]
        : [];
    return segments
      .filter((segment) => segment.date === selectedDate)
      .map((segment) => ({
        id: `${interviewCase.id}-${segment.stepId ?? segment.startTime}`,
        caseId: interviewCase.id,
        candidateName: interviewCase.candidateName,
        recruitmentName: interviewCase.recruitmentName,
        status: interviewCase.status === "CONFIRMED" ? "CONFIRMED" : "AWAITING_CANDIDATE_CONFIRMATION",
        source: "LOCAL" as const,
        roomName: canonicalRoomName(segment.roomName),
        startTime: segment.startTime,
        endTime: segment.endTime,
        href: `/cases/${interviewCase.id}`,
      }));
  });
  const externalConfirmed: ScheduledCalendarItem[] = (data.externalConfirmedInterviews ?? [])
    .filter((interview) => interview.date === selectedDate && interview.roomName)
    .filter((interview) => !scheduled.some((local) =>
      local.caseId === interview.linkedCaseId
      && local.startTime === interview.startTime
      && local.endTime === interview.endTime
      && roomMatches(local.roomName, interview.roomName!),
    ))
    .map((interview) => ({
      id: `daou:${interview.id}`,
      candidateName: interview.candidateName,
      recruitmentName: interview.recruitmentName,
      source: "DAOU_OFFICE_CALENDAR" as const,
      roomName: canonicalRoomName(interview.roomName!),
      startTime: interview.startTime,
      endTime: interview.endTime,
      href: null,
    }));
  const unassignedExternalConfirmed = (data.externalConfirmedInterviews ?? [])
    .filter((interview) => interview.date === selectedDate && !interview.roomName);
  const calendarInterviews = [...scheduled, ...externalConfirmed];
  const freshness = freshnessCopy(data.dashboard.summary.freshness.daouOffice);
  const hasRoomData = roomNames.length > 0;
  const refreshCalendar = () => startRefresh(() => router.refresh());

  return (
    <div className="min-h-screen bg-slate-50">
      <AppHeader active="rooms" />
      <main className="mx-auto max-w-[1440px] px-4 pb-12 sm:px-8" id="main-content">
        <PageHeader
          actions={<Button disabled={isRefreshing} onClick={refreshCalendar} variant="outline">{isRefreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}{isRefreshing ? "갱신 중" : "화면 새로고침"}</Button>}
          eyebrow="ROOM CALENDAR"
          title="회의실 캘린더"
          description="다우오피스 회의실 예약과 캘린더에서 확인한 확정 인터뷰를 같은 시간축에서 확인합니다. 새로고침은 로컬에 마지막으로 동기화된 정보를 다시 읽습니다."
        />

        <Card className="overflow-hidden">
          <CardHeader className="gap-5 border-b border-slate-200 p-5 sm:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-600">
                <span className="flex items-center gap-2"><i aria-hidden="true" className="size-2.5 rounded-sm bg-slate-300" />회의실 예약</span>
                <span className="flex items-center gap-2"><i aria-hidden="true" className="size-2.5 rounded-sm bg-blue-500" />인터뷰 배정</span>
                <span className="flex items-center gap-2"><i aria-hidden="true" className="size-2.5 rounded-sm bg-amber-400" />후보자 응답 대기</span>
                <span className="flex items-center gap-2"><i aria-hidden="true" className="size-2.5 rounded-sm bg-emerald-500" />다우오피스 확정</span>
                <Badge variant="outline">다우오피스 읽기 전용</Badge>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
                <RefreshCw aria-hidden="true" className="size-4 text-slate-500" />
                <div><Badge variant={freshness.variant}>{freshness.label}</Badge><p className="mt-1 text-xs text-slate-500">{freshness.description}</p></div>
              </div>
            </div>
            <div className="flex items-center justify-center gap-2 border-t border-slate-100 pt-4">
              <Button aria-label="이전 날짜" size="icon-sm" variant="ghost" onClick={() => setSelectedDate((date) => shiftDate(date, -1))}><ChevronLeft className="size-5" /></Button>
              <CardTitle className="min-w-56 text-center text-xl sm:text-2xl">{formatCalendarDate(selectedDate)}</CardTitle>
              <Button aria-label="다음 날짜" size="icon-sm" variant="ghost" onClick={() => setSelectedDate((date) => shiftDate(date, 1))}><ChevronRight className="size-5" /></Button>
              <Button size="sm" variant="secondary" onClick={() => setSelectedDate(todayInSeoul())}>오늘</Button>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {hasRoomData ? (
              <div className="overflow-x-auto" tabIndex={0} aria-label="회의실 시간표. 좌우로 스크롤할 수 있습니다.">
                <div className="grid min-w-[1280px] grid-cols-[188px_minmax(1092px,1fr)] bg-slate-50 text-sm font-semibold text-slate-600">
                  <span className="sticky left-0 z-30 flex h-12 items-center border-r border-slate-200 bg-slate-50 px-5">회의실</span>
                  <div className="grid grid-cols-9">{calendarHours.map((hour) => <span className="flex h-12 items-center border-r border-slate-200 px-3" key={hour}>{String(hour).padStart(2, "0")}:00</span>)}</div>
                </div>
                {roomNames.map((roomName) => (
                  <RoomCalendarRow
                    blocks={blocks.filter((block) => roomMatches(block.roomName, roomName))}
                    key={roomName}
                    roomName={roomName}
                    scheduled={calendarInterviews.filter((interview) => roomMatches(interview.roomName, roomName))}
                  />
                ))}
              </div>
            ) : (
              <div className="grid min-h-80 place-items-center p-8 text-center">
                <div className="max-w-md"><CalendarDays className="mx-auto size-10 text-slate-400" /><p className="mt-4 text-lg font-bold text-slate-900">동기화된 회의실 예약 정보가 없습니다.</p><p className="mt-2 text-base leading-7 text-slate-600">다우오피스 로그인 후 회의실 동기화를 실행하면 확보된 시간과 인터뷰 배정을 이곳에서 비교할 수 있습니다.</p></div>
              </div>
            )}
          </CardContent>
        </Card>

        {unassignedExternalConfirmed.length > 0 ? <Card className="mt-5 border-amber-200 bg-amber-50/50"><CardHeader className="border-b border-amber-100"><CardTitle className="text-lg">회의실 확인이 필요한 확정 인터뷰</CardTitle></CardHeader><CardContent className="divide-y divide-amber-100">{unassignedExternalConfirmed.map((interview) => <div className="py-3 first:pt-0 last:pb-0" key={interview.id}><p className="font-bold text-slate-950">{interview.candidateName}</p><p className="mt-1 text-sm text-slate-600">{interview.recruitmentName} · {interview.startTime}–{interview.endTime}</p><p className="mt-1 text-sm text-amber-800">다우오피스 캘린더에 회의실명이 없어 시간표 행에는 표시하지 않았습니다.</p></div>)}</CardContent></Card> : null}

        <div className="mt-5 flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-600"><Clock3 className="mt-0.5 size-4 shrink-0 text-slate-400" /><span>예약 블록은 취소하지 않고 유지합니다. 인터뷰를 취소하거나 변경해도 다우오피스의 기존 회의실 예약에는 영향을 주지 않습니다.</span></div>
        {calendarInterviews.length > 0 ? <div className="mt-4 flex items-center gap-2 text-sm text-slate-600"><UsersRound className="size-4 text-blue-600" />선택한 날짜에 회의실이 확인된 인터뷰 {calendarInterviews.length}건이 표시되어 있습니다.</div> : null}
      </main>
    </div>
  );
}
