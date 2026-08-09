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
import type { CandidateCase, DashboardSnapshot, DataFreshness } from "../lib/dashboard-types";

const calendarStartHour = 9;
const calendarEndHour = 18;
const calendarHours = Array.from({ length: calendarEndHour - calendarStartHour }, (_, index) => calendarStartHour + index);
const roomDisplayOrder = [
  { label: "열정룸", aliases: ["열정룸"] },
  { label: "행복룸", aliases: ["행복룸"] },
  { label: "게임체인저", aliases: ["게임체인저"] },
  { label: "의문당", aliases: ["의문당", "疑問堂"] },
] as const;

function roomOrder(roomName: string) {
  const index = roomDisplayOrder.findIndex((room) => room.aliases.some((alias) => roomName.includes(alias)));
  return index === -1 ? roomDisplayOrder.length : index;
}

function roomMatches(roomName: string, roomLabel: string) {
  const room = roomDisplayOrder.find((item) => item.label === roomLabel);
  return room?.aliases.some((alias) => roomName.includes(alias)) ?? roomName === roomLabel;
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
    width: `${Math.max(((end - start) / range) * 100, 1.2)}%`,
  };
}

function freshnessCopy(freshness: DataFreshness) {
  if (freshness.state === "FRESH") return { label: "회의실 정보 최신", variant: "success" as const, description: "최근 동기화된 예약 정보입니다." };
  if (freshness.state === "STALE") return { label: "회의실 정보 갱신 필요", variant: "warning" as const, description: "마지막 동기화가 오래되어 새로고침 후 추천하세요." };
  return { label: "회의실 정보 확인 필요", variant: "secondary" as const, description: "아직 회의실 동기화가 확인되지 않았습니다." };
}

type ScheduledCalendarItem = Pick<
  CandidateCase,
  "id" | "candidateName" | "status" | "scheduledRoomName" | "scheduledStartTime" | "scheduledEndTime"
> & { caseId: string };

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
  const scheduledLayouts = layoutTimedItems(scheduled.filter((item) => item.scheduledStartTime && item.scheduledEndTime).map((item) => ({
    ...item,
    startTime: item.scheduledStartTime!,
    endTime: item.scheduledEndTime!,
  })));
  const reservationHeight = Math.max(blockLayouts.length > 0 ? blockLayouts[blockLayouts.length - 1]!.lane + 1 : 0, 1) * 38;
  const assignedHeight = Math.max(scheduledLayouts.length > 0 ? scheduledLayouts[scheduledLayouts.length - 1]!.lane + 1 : 0, 1) * 88;
  const rowHeight = Math.max(168, 20 + reservationHeight + assignedHeight);
  const hasItems = blockLayouts.length > 0 || scheduledLayouts.length > 0;

  return (
    <section className="grid min-w-[1060px] grid-cols-[188px_minmax(872px,1fr)] border-t border-slate-200 first:border-t-0" style={{ minHeight: rowHeight }}>
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
        {scheduledLayouts.map(({ item: interviewCase, lane }) => (
          <Link
            aria-label={`${interviewCase.candidateName ?? "후보자"} ${interviewCase.startTime}부터 ${interviewCase.endTime}까지 ${scheduleStatusLabel(interviewCase.status)}`}
            className={`absolute z-10 grid min-w-0 content-center gap-1 overflow-hidden rounded-lg border px-3 py-2 shadow-sm transition-[transform,box-shadow] hover:z-20 hover:-translate-y-0.5 hover:shadow-md ${interviewCase.status === "AWAITING_CANDIDATE_CONFIRMATION" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-blue-300 bg-blue-50 text-blue-950"}`}
            href={`/cases/${interviewCase.caseId}`}
            key={interviewCase.id}
            style={{ ...timeCardStyle(interviewCase.startTime, interviewCase.endTime), top: `${54 + lane * 88}px`, height: "76px" }}
            title={`${interviewCase.candidateName ?? "후보자 확인 필요"} · ${interviewCase.startTime} – ${interviewCase.endTime}`}
          >
            <strong className="truncate text-base font-bold">{interviewCase.startTime} – {interviewCase.endTime}</strong>
            <span className="truncate text-sm font-medium">{interviewCase.candidateName ?? "후보자 확인 필요"}</span>
            <span className="truncate text-xs opacity-75">{scheduleStatusLabel(interviewCase.status)}</span>
          </Link>
        ))}
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
  ])], [data]);
  const roomNames = useMemo(() => {
    if (discoveredRoomNames.length === 0) return [];
    const preferred = roomDisplayOrder.map((room) => discoveredRoomNames.find((name) => roomMatches(name, room.label)) ?? room.label);
    const additional = discoveredRoomNames.filter((name) => !preferred.some((preferredName) => preferredName === name));
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
  const scheduled = scheduledCases.flatMap((interviewCase) => {
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
        status: interviewCase.status,
        scheduledRoomName: segment.roomName,
        scheduledStartTime: segment.startTime,
        scheduledEndTime: segment.endTime,
      }));
  });
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
          description="다우오피스에 확보된 회의실 시간과 실제 인터뷰 배정을 같은 시간축에서 확인합니다. 새로고침은 로컬에 마지막으로 동기화된 정보를 다시 읽습니다."
        />

        <Card className="overflow-hidden">
          <CardHeader className="gap-5 border-b border-slate-200 p-5 sm:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-600">
                <span className="flex items-center gap-2"><i aria-hidden="true" className="size-2.5 rounded-sm bg-slate-300" />회의실 예약</span>
                <span className="flex items-center gap-2"><i aria-hidden="true" className="size-2.5 rounded-sm bg-blue-500" />인터뷰 배정</span>
                <span className="flex items-center gap-2"><i aria-hidden="true" className="size-2.5 rounded-sm bg-amber-400" />후보자 응답 대기</span>
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
                <div className="grid min-w-[1060px] grid-cols-[188px_minmax(872px,1fr)] bg-slate-50 text-sm font-semibold text-slate-600">
                  <span className="sticky left-0 z-30 flex h-12 items-center border-r border-slate-200 bg-slate-50 px-5">회의실</span>
                  <div className="grid grid-cols-9">{calendarHours.map((hour) => <span className="flex h-12 items-center border-r border-slate-200 px-3" key={hour}>{String(hour).padStart(2, "0")}:00</span>)}</div>
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
            ) : (
              <div className="grid min-h-80 place-items-center p-8 text-center">
                <div className="max-w-md"><CalendarDays className="mx-auto size-10 text-slate-400" /><p className="mt-4 text-lg font-bold text-slate-900">동기화된 회의실 예약 정보가 없습니다.</p><p className="mt-2 text-base leading-7 text-slate-600">다우오피스 로그인 후 회의실 동기화를 실행하면 확보된 시간과 인터뷰 배정을 이곳에서 비교할 수 있습니다.</p></div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="mt-5 flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-600"><Clock3 className="mt-0.5 size-4 shrink-0 text-slate-400" /><span>예약 블록은 취소하지 않고 유지합니다. 인터뷰를 취소하거나 변경해도 다우오피스의 기존 회의실 예약에는 영향을 주지 않습니다.</span></div>
        {scheduledCases.length > 0 ? <div className="mt-4 flex items-center gap-2 text-sm text-slate-600"><UsersRound className="size-4 text-blue-600" />선택한 날짜에 인터뷰 {scheduledCases.length}건이 배정되어 있습니다.</div> : null}
      </main>
    </div>
  );
}
