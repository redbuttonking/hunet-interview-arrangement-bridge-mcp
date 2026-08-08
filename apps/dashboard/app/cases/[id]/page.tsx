// 후보자별 인터뷰 조율 상태와 필요한 다음 업무를 한 화면에서 확인한다.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarClock, CheckCircle2, CircleAlert, Clock3, MapPin, MessageSquareText, UsersRound } from "lucide-react";
import { AppHeader, PageHeader } from "../../components/app-shell";
import { DraftApprovalCard } from "../../components/draft-approval-card";
import { CasePlanOverrides } from "../../components/case-plan-overrides";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { activityActorLabel, activityEventLabel } from "../../lib/activity-labels";
import { loadCaseDetail } from "../../lib/data";

export const dynamic = "force-dynamic";

type CaseDetailData = NonNullable<ReturnType<typeof loadCaseDetail>>;

const journeySteps = ["조율 시작", "면접관 일정", "시간·회의실", "후보자 응답", "최종 확정"];

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const hour24 = shifted.getUTCHours();
  const period = hour24 >= 12 ? "오후" : "오전";
  const hour = hour24 % 12 || 12;
  return `${shifted.getUTCMonth() + 1}. ${shifted.getUTCDate()}. ${period} ${hour}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

function interviewerStatus(status: string) {
  const labels: Record<string, string> = {
    PENDING: "미제출",
    SUBMITTED: "제출 완료",
    DECLINED_PENDING_REVIEW: "불가 응답",
    EXCLUDED: "제외",
  };
  return labels[status] ?? status;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    READY_FOR_DRAFT: "조율 시작 준비",
    DRAFT_CREATED: "요청 초안 검토",
    REQUEST_SENT: "면접관 응답 대기",
    COLLECTING_AVAILABILITY: "면접관 일정 수집",
    READY_TO_SCHEDULE: "시간·회의실 선택",
    AWAITING_CANDIDATE_CONFIRMATION: "후보자 응답 대기",
    CONFIRMED: "최종 확정",
    REVIEW_REQUIRED: "예외 검토",
    ON_HOLD: "조율 보류",
    CANCELLED: "취소",
    CLOSED: "종료",
  };
  return labels[status] ?? status;
}

function statusVariant(status: string) {
  if (status === "CONFIRMED") return "success" as const;
  if (status === "CANCELLED") return "destructive" as const;
  if (["REVIEW_REQUIRED", "ON_HOLD"].includes(status)) return "warning" as const;
  return "default" as const;
}

function journeyIndex(status: string) {
  if (["READY_FOR_DRAFT", "DRAFT_CREATED"].includes(status)) return 0;
  if (["REQUEST_SENT", "COLLECTING_AVAILABILITY"].includes(status)) return 1;
  if (["READY_TO_SCHEDULE", "REVIEW_REQUIRED"].includes(status)) return 2;
  if (status === "AWAITING_CANDIDATE_CONFIRMATION") return 3;
  return 4;
}

function isExceptionStatus(status: string) {
  return ["CANCELLED", "ON_HOLD"].includes(status);
}

function nextAction(status: string, pendingResponses: number) {
  const actions: Record<string, { title: string; description: string; tone: "blue" | "amber" | "slate" }> = {
    READY_FOR_DRAFT: { title: "인터뷰 조율을 시작할지 확인해 주세요.", description: "운영 보드에서 인터뷰 유형과 소요 시간을 확인한 뒤 시작합니다.", tone: "blue" },
    DRAFT_CREATED: { title: "면접관 일정 요청 초안을 검토해 주세요.", description: "초안을 승인하기 전에는 Slack 메시지가 발송되지 않습니다.", tone: "blue" },
    READY_TO_SCHEDULE: { title: "추천 시간과 회의실을 선택해 주세요.", description: "면접관 가용시간과 다우오피스 회의실 예약 블록을 함께 확인합니다.", tone: "blue" },
    AWAITING_CANDIDATE_CONFIRMATION: { title: "후보자의 일정 답변을 기다리고 있습니다.", description: "나인하이어에서 후보자가 확정하면 로컬 운영 상태에 반영됩니다.", tone: "amber" },
    CONFIRMED: { title: "인터뷰가 최종 확정되었습니다.", description: "면접관 안내 메시지 발송 여부와 일정 정보를 확인해 주세요.", tone: "blue" },
    REVIEW_REQUIRED: { title: "예외 상황을 확인하고 다음 조치를 결정해 주세요.", description: "재조율, 보류, 취소 중 하나를 사용자의 판단으로 선택합니다.", tone: "amber" },
    ON_HOLD: { title: "인터뷰 조율을 보류한 상태입니다.", description: "운영 보드에서 보류 해제를 선택하면 이전 조율 단계로 돌아갑니다.", tone: "slate" },
    CANCELLED: { title: "인터뷰 조율이 취소된 상태입니다.", description: "다우오피스의 기존 회의실 예약 블록은 그대로 유지합니다.", tone: "slate" },
  };
  if (["REQUEST_SENT", "COLLECTING_AVAILABILITY"].includes(status)) {
    return {
      title: pendingResponses > 0 ? `필수 면접관 ${pendingResponses}명의 응답을 기다리고 있습니다.` : "면접관 응답을 확인하고 있습니다.",
      description: "미응답이 지속되면 리마인드 또는 수동 수집 여부를 운영 보드에서 판단합니다.",
      tone: "amber" as const,
    };
  }
  return actions[status] ?? { title: "현재 상태를 확인해 주세요.", description: "운영 보드에서 필요한 다음 작업을 확인합니다.", tone: "slate" as const };
}

function stepName(stepId: string | null, plan: CaseDetailData["plan"]) {
  if (!stepId || !plan) return "인터뷰";
  return plan.sessions.find((session) => session.stepId === stepId)?.stepName ?? "인터뷰";
}

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = loadCaseDetail(id);
  if (!data) notFound();
  const { bundle, plan, template, scheduledSegments, events } = data;
  const interviewCase = bundle.interviewCase;
  const plannedInterviewerIds = new Set(plan?.sessions.flatMap((session) => session.interviewerIds) ?? []);
  const activeInterviewers = bundle.interviewers.filter(
    (interviewer) => interviewer.active && (plannedInterviewerIds.size === 0 || plannedInterviewerIds.has(interviewer.id)),
  );
  const currentJourneyIndex = journeyIndex(interviewCase.status);
  const exceptionStatus = isExceptionStatus(interviewCase.status);
  const action = nextAction(
    interviewCase.status,
    activeInterviewers.filter((interviewer) => interviewer.required && interviewer.status === "PENDING").length,
  );
  const interviewType = plan
    ? `${plan.mode === "COMBINED" ? "통합" : plan.mode === "SEQUENTIAL" ? "연속" : "단일"} · ${plan.stepNames.join(plan.mode === "SEQUENTIAL" ? " → " : " + ")}`
    : "인터뷰 유형 확인 필요";
  const duration = plan?.durationMinutes ?? interviewCase.durationMinutes;

  return (
    <div className="min-h-screen bg-slate-50">
      <AppHeader active="operations" />
      <main className="mx-auto max-w-[1440px] px-4 pb-12 sm:px-8" id="main-content">
        <div className="pt-7"><Link className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition-colors hover:text-blue-700" href="/"><ArrowLeft className="size-4" />운영 보드</Link></div>
        <PageHeader
          actions={<Badge className="px-3 py-1 text-sm" variant={statusVariant(interviewCase.status)}>{statusLabel(interviewCase.status)}</Badge>}
          description={interviewCase.recruitmentName ?? "채용 정보 확인 필요"}
          eyebrow="CANDIDATE OVERVIEW"
          title={interviewCase.candidateName ?? "후보자 확인 필요"}
        />

        <Card className="overflow-hidden">
          <CardHeader className="border-b border-slate-200 p-5 sm:p-7">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">INTERVIEW JOURNEY</p><CardTitle className="mt-2 text-2xl sm:text-3xl">인터뷰 조율 진행 상태</CardTitle><CardDescription className="mt-2 text-base">{interviewType} · {duration}분 인터뷰입니다.</CardDescription></div><Badge variant={statusVariant(interviewCase.status)}>{statusLabel(interviewCase.status)}</Badge></div>
          </CardHeader>
          <CardContent className="p-5 sm:p-7">
            <ol aria-label="인터뷰 조율 5단계" className="grid gap-4 sm:grid-cols-5 sm:gap-0">
              {journeySteps.map((step, index) => {
                const isCompleted = !exceptionStatus && index < currentJourneyIndex;
                const isCurrent = !exceptionStatus && index === currentJourneyIndex;
                return (
                  <li aria-current={isCurrent ? "step" : undefined} className="relative flex items-center gap-3 sm:block" key={step}>
                    {index < journeySteps.length - 1 ? <span aria-hidden="true" className="absolute left-5 top-10 hidden h-px w-[calc(100%-2.5rem)] bg-slate-200 sm:block" /> : null}
                    <span className={`relative z-10 grid size-10 shrink-0 place-items-center rounded-full text-sm font-bold transition-colors ${isCompleted ? "bg-emerald-600 text-white" : isCurrent ? "bg-blue-600 text-white ring-4 ring-blue-100" : "bg-slate-100 text-slate-500"}`}>{isCompleted ? <CheckCircle2 className="size-5" /> : index + 1}</span>
                    <span className="sm:mt-3 sm:block"><strong className={`text-base ${isCurrent ? "text-slate-950" : "text-slate-600"}`}>{step}</strong>{isCurrent ? <span className="mt-1 block text-xs font-medium text-blue-700">현재 단계</span> : null}</span>
                  </li>
                );
              })}
            </ol>
            <div className={`mt-8 flex items-start gap-3 rounded-xl border p-5 ${action.tone === "blue" ? "border-blue-100 bg-blue-50/70" : action.tone === "amber" ? "border-amber-200 bg-amber-50/70" : "border-slate-200 bg-slate-50"}`}>
              {exceptionStatus ? <CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-700" /> : <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-blue-700" />}
              <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-600">NEXT ACTION</p><h2 className="mt-2 text-lg font-bold tracking-tight text-slate-950">{action.title}</h2><p className="mt-2 text-base leading-7 text-slate-700">{action.description}</p></div>
            </div>
          </CardContent>
        </Card>

        <CasePlanOverrides
          caseId={interviewCase.id}
          editable={["READY_FOR_DRAFT", "DRAFT_CREATED"].includes(interviewCase.status)}
          interviewers={activeInterviewers.map((interviewer) => ({ id: interviewer.id, displayName: interviewer.displayName, required: interviewer.required }))}
          steps={(template?.steps ?? []).map((step) => ({ stepId: step.stepId, name: step.name, order: step.order }))}
        />

        <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]" data-case-detail-panels>
          <Card>
            <CardHeader className="border-b border-slate-100"><div className="flex items-center gap-2 text-blue-600"><CalendarClock className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">INTERVIEW DETAILS</p></div><CardTitle className="mt-2 text-xl">인터뷰 일정 요약</CardTitle><CardDescription>후보자에게 안내할 일정과 회의실을 확인합니다.</CardDescription></CardHeader>
            <CardContent className="p-6"><dl className="grid gap-5">
              <div className="grid gap-1 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-5"><dt className="text-sm font-medium text-slate-500">인터뷰 유형</dt><dd className="m-0 text-base font-bold leading-6 text-slate-900">{interviewType}</dd></div>
              <div className="grid gap-1 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-5"><dt className="text-sm font-medium text-slate-500">소요 시간</dt><dd className="m-0 text-base font-bold leading-6 text-slate-900">{duration}분</dd></div>
              <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-5"><dt className="text-sm font-medium text-slate-500">확정 일정</dt><dd className="m-0 grid gap-2 text-base font-semibold leading-6 text-slate-900">
                {scheduledSegments.length > 0 ? scheduledSegments.map((segment) => <span className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5" key={`${segment.date}-${segment.startTime}-${segment.roomName}-${segment.stepId ?? "single"}`}><span className="text-blue-700">{segment.date} {segment.startTime}–{segment.endTime}</span><span className="text-slate-400">·</span><span>{stepName(segment.stepId, plan)}</span><span className="text-slate-400">·</span><span>{segment.roomName}</span></span>) : interviewCase.scheduledDate ? `${interviewCase.scheduledDate} ${interviewCase.scheduledStartTime}–${interviewCase.scheduledEndTime}` : "아직 확정된 일정이 없습니다."}
              </dd></div>
              <div className="grid gap-1 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-5"><dt className="text-sm font-medium text-slate-500">회의실</dt><dd className="m-0 flex items-center gap-2 text-base font-bold leading-6 text-slate-900"><MapPin className="size-4 text-slate-400" />{scheduledSegments.length > 0 ? "세그먼트별 배정" : interviewCase.scheduledRoomName ?? "회의실 선택 또는 확인 필요"}</dd></div>
              <div className="grid gap-1 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-5"><dt className="text-sm font-medium text-slate-500">후보자 응답</dt><dd className="m-0 text-base font-bold leading-6 text-slate-900">{interviewCase.candidateScheduleProposalSent ? <span className="text-emerald-700">나인하이어 일정 제안 발송 완료 · 응답 대기 또는 확정</span> : <span className="text-amber-700">나인하이어 일정 제안 미발송</span>}</dd></div>
            </dl></CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b border-slate-100"><div className="flex items-center gap-2 text-blue-600"><UsersRound className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">INTERVIEWERS</p></div><CardTitle className="mt-2 text-xl">면접관 일정 제출</CardTitle><CardDescription>현재 인터뷰 단계의 평가표 등록 면접관입니다.</CardDescription></CardHeader>
            <CardContent className="p-6">{activeInterviewers.length > 0 ? <div className="max-h-[23rem] overflow-y-auto pr-1" tabIndex={0} aria-label="면접관 목록"><div className="divide-y divide-slate-200">{activeInterviewers.map((interviewer) => <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0" key={interviewer.id}><div className="min-w-0"><p className="truncate text-base font-bold text-slate-950">{interviewer.displayName}</p><p className="mt-1 text-sm text-slate-500">{interviewer.source === "NINEHIRE" ? "나인하이어 평가표 등록 평가자" : interviewer.required ? "필수 면접관" : "선택 면접관"}</p></div><Badge variant={interviewer.status === "SUBMITTED" ? "success" : interviewer.status === "DECLINED_PENDING_REVIEW" ? "warning" : "secondary"}>{interviewerStatus(interviewer.status)}</Badge></div>)}</div></div> : <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-base leading-7 text-slate-600">현재 단계의 평가표에 등록된 면접관이 없습니다. 나인하이어 평가표 설정을 확인하거나 직접 지정해 주세요.</div>}</CardContent>
          </Card>
        </section>

        <section className="mt-6 grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader className="border-b border-slate-100"><div className="flex items-center gap-2 text-blue-600"><MessageSquareText className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">SLACK MESSAGES</p></div><CardTitle className="mt-2 text-xl">안내 메시지 상태</CardTitle><CardDescription>발송 전 초안은 승인 후 Slack에 전송됩니다.</CardDescription></CardHeader>
            <CardContent className="max-h-[31rem] overflow-y-auto p-6" tabIndex={0} aria-label="Slack 안내 메시지 목록">{bundle.drafts.length > 0 ? <DraftApprovalCard drafts={bundle.drafts.map((draft) => ({ id: draft.id, messageType: draft.messageType, status: draft.status, previewText: draft.previewText, createdAt: draft.createdAt }))} /> : <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-base text-slate-600">생성된 Slack 초안이 없습니다.</div>}</CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b border-slate-100"><div className="flex items-center gap-2 text-blue-600"><Clock3 className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">ACTIVITY LOG</p></div><CardTitle className="mt-2 text-xl">업무 이력</CardTitle><CardDescription>상태 변경과 외부 연동 기록을 최신순으로 표시합니다.</CardDescription></CardHeader>
            <CardContent className="max-h-[31rem] overflow-y-auto p-6" tabIndex={0} aria-label="업무 이력 목록">{events.length > 0 ? <ol className="divide-y divide-slate-200">{events.map((event) => <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-4 first:pt-0 last:pb-0" key={event.id}><div><p className="text-base font-bold text-slate-950">{activityEventLabel(event.eventType)}</p><p className="mt-1 text-sm text-slate-500">{event.eventType} · {formatDateTime(event.createdAt)}</p></div><span className="text-sm text-slate-500">{activityActorLabel(event.actor)}</span></li>)}</ol> : <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-base text-slate-600">기록된 업무 이력이 없습니다.</div>}</CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}
