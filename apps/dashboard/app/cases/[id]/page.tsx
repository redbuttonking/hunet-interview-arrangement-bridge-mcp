// 후보자별 인터뷰 조율 상태와 필요한 다음 업무를 한 화면에서 확인한다.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarClock, CheckCircle2, CircleAlert, Clock3, ExternalLink, MessageSquareText, UsersRound } from "lucide-react";
import { AppHeader, PageHeader } from "../../components/app-shell";
import { DraftApprovalCard } from "../../components/draft-approval-card";
import { CasePlanOverrides } from "../../components/case-plan-overrides";
import { CaseScheduleExceptionAction } from "../../components/case-schedule-exception-action";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { activityActorLabel, activityEventLabel } from "../../lib/activity-labels";
import { loadCaseDetail } from "../../lib/data";

export const dynamic = "force-dynamic";

type CaseDetailData = NonNullable<ReturnType<typeof loadCaseDetail>>;

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

function confirmedScheduleStatus(interviewCase: CaseDetailData["bundle"]["interviewCase"]) {
  if (!interviewCase.scheduledDate || !interviewCase.scheduledStartTime) return "인터뷰 확정";
  const now = new Date();
  const koreaNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const current = `${koreaNow.getUTCFullYear()}-${String(koreaNow.getUTCMonth() + 1).padStart(2, "0")}-${String(koreaNow.getUTCDate()).padStart(2, "0")}T${String(koreaNow.getUTCHours()).padStart(2, "0")}:${String(koreaNow.getUTCMinutes()).padStart(2, "0")}`;
  const startsAt = `${interviewCase.scheduledDate}T${interviewCase.scheduledStartTime}`;
  const endsAt = `${interviewCase.scheduledDate}T${interviewCase.scheduledEndTime ?? interviewCase.scheduledStartTime}`;
  if (current < startsAt) return "인터뷰 예정";
  if (current < endsAt) return "인터뷰 진행 중";
  return "인터뷰 평가 확인";
}

function statusLabel(interviewCase: CaseDetailData["bundle"]["interviewCase"]) {
  if (interviewCase.status === "AWAITING_CANDIDATE_CONFIRMATION" && !interviewCase.candidateScheduleProposalSent) {
    return "일정 제안 보내기 전";
  }
  const labels: Record<string, string> = {
    READY_FOR_DRAFT: "조율 시작 준비",
    DRAFT_CREATED: "요청 초안 검토",
    REQUEST_SENT: "면접관 응답 대기",
    COLLECTING_AVAILABILITY: "면접관 일정 수집",
    READY_TO_SCHEDULE: "시간·회의실 선택",
    AWAITING_CANDIDATE_CONFIRMATION: "후보자 응답 대기",
    REVIEW_REQUIRED: "예외 검토",
    ON_HOLD: "조율 보류",
    CANCELLED: "취소",
    CLOSED: "종료",
  };
  return interviewCase.status === "CONFIRMED"
    ? confirmedScheduleStatus(interviewCase)
    : labels[interviewCase.status] ?? interviewCase.status;
}

function statusVariant(status: string) {
  if (status === "CONFIRMED") return "success" as const;
  if (status === "CANCELLED") return "destructive" as const;
  if (["REVIEW_REQUIRED", "ON_HOLD"].includes(status)) return "warning" as const;
  return "default" as const;
}

function isExceptionStatus(status: string) {
  return ["REVIEW_REQUIRED", "CANCELLED", "ON_HOLD"].includes(status);
}

function nextAction(
  status: string,
  interviewers: Array<{ displayName: string; status: string }>,
  candidateScheduleProposalSent = false,
) {
  const actions: Record<string, { title: string; description: string; tone: "blue" | "amber" | "slate" }> = {
    READY_FOR_DRAFT: { title: "인터뷰 조율을 시작할지 확인해 주세요.", description: "운영 보드에서 인터뷰 유형과 소요 시간을 확인한 뒤 시작합니다.", tone: "blue" },
    DRAFT_CREATED: { title: "면접관 일정 요청 초안을 검토해 주세요.", description: "초안을 승인하기 전에는 Slack 메시지가 발송되지 않습니다.", tone: "blue" },
    READY_TO_SCHEDULE: { title: "추천 시간과 회의실을 선택해 주세요.", description: "면접관 가용시간과 다우오피스 회의실 예약 블록을 함께 확인합니다.", tone: "blue" },
    AWAITING_CANDIDATE_CONFIRMATION: { title: "후보자의 일정 답변을 기다리고 있습니다.", description: "나인하이어에서 후보자가 확정하면 로컬 운영 상태에 반영됩니다.", tone: "amber" },
    CONFIRMED: { title: "인터뷰가 예정되어 있습니다.", description: "일정 변경·취소 요청이 실제로 들어오면 그때 재조율 또는 인터뷰 종료를 선택할 수 있습니다.", tone: "blue" },
    REVIEW_REQUIRED: { title: "예외 상황을 확인하고 다음 조치를 결정해 주세요.", description: "재조율, 보류, 취소 중 하나를 사용자의 판단으로 선택합니다.", tone: "amber" },
    ON_HOLD: { title: "인터뷰 조율을 보류한 상태입니다.", description: "운영 보드에서 보류 해제를 선택하면 이전 조율 단계로 돌아갑니다.", tone: "slate" },
    CANCELLED: { title: "인터뷰 조율이 취소된 상태입니다.", description: "다우오피스의 기존 회의실 예약 블록은 그대로 유지합니다.", tone: "slate" },
  };
  if (status === "AWAITING_CANDIDATE_CONFIRMATION" && !candidateScheduleProposalSent) {
    return {
      title: "후보자에게 일정 제안을 보내기 전입니다.",
      description: "후보일의 장소 안내 기준을 확인한 뒤 나인하이어 일정 제안 메일을 발송하고, 발송 완료를 기록해 주세요.",
      tone: "amber" as const,
    };
  }
  if (["REQUEST_SENT", "COLLECTING_AVAILABILITY"].includes(status)) {
    const pendingNames = interviewers
      .filter((interviewer) => interviewer.status === "PENDING")
      .map((interviewer) => interviewer.displayName);
    const allSubmitted = interviewers.length > 0 && pendingNames.length === 0;
    return {
      title: allSubmitted
        ? "모든 면접관이 제출 완료했습니다."
        : `${pendingNames.join(", ")} 면접관의 가능 일정 제출을 기다리고 있습니다.`,
      description: allSubmitted
        ? "제출된 일정을 바탕으로 인터뷰 시간과 회의실을 선택할 수 있습니다."
        : "필요할 때만 운영 보드에서 일정 재요청 초안을 만들 수 있습니다.",
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
  const { bundle, plan, template, scheduledSegments, events, ninehireCandidateUrl, scheduleDeletionReview } = data;
  const interviewCase = bundle.interviewCase;
  const plannedInterviewerIds = new Set(plan?.sessions.flatMap((session) => session.interviewerIds) ?? []);
  const activeInterviewers = bundle.interviewers.filter(
    (interviewer) => interviewer.active && (plannedInterviewerIds.size === 0 || plannedInterviewerIds.has(interviewer.id)),
  );
  const exceptionStatus = isExceptionStatus(interviewCase.status);
  const action = scheduleDeletionReview
    ? {
      title: "나인하이어 일정 삭제가 확인되었습니다.",
      description: "기존 인터뷰 일정이 나인하이어에서 삭제되었습니다. 재조율, 인터뷰 종료, 보류 중 다음 조치를 선택해 주세요.",
      tone: "amber" as const,
    }
    : nextAction(
      interviewCase.status,
      activeInterviewers
        .filter((interviewer) => interviewer.required)
        .map((interviewer) => ({ displayName: interviewer.displayName, status: interviewer.status })),
      interviewCase.candidateScheduleProposalSent,
    );
  const candidateJourney = data.candidateJourney;
  const scheduleLabel = interviewCase.status === "CONFIRMED"
    ? "확정 일정"
    : interviewCase.candidateScheduleProposalSent
      ? "후보자 제안 일정"
      : "후보자 제안 후보일";
  const interviewType = plan
    ? `${plan.mode === "COMBINED" ? "통합" : plan.mode === "SEQUENTIAL" ? "연속" : "단일"} · ${plan.stepNames.join(plan.mode === "SEQUENTIAL" ? " → " : " + ")}`
    : candidateJourney?.currentStageLabel ?? "인터뷰 유형 확인 필요";
  const duration = plan?.durationMinutes ?? interviewCase.durationMinutes;

  return (
    <div className="min-h-screen bg-slate-50">
      <AppHeader active="operations" />
      <main className="mx-auto max-w-[1440px] px-4 pb-12 sm:px-8" id="main-content">
        <div className="pt-7"><Link className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition-colors hover:text-blue-700" href="/"><ArrowLeft className="size-4" />운영 보드</Link></div>
        <PageHeader
          actions={<><Badge className="px-3 py-1 text-sm" variant={statusVariant(interviewCase.status)}>{statusLabel(interviewCase)}</Badge>{ninehireCandidateUrl ? <a className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-800 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/40 focus-visible:ring-offset-2" href={ninehireCandidateUrl} rel="noopener noreferrer" target="_blank">나인하이어에서 열기<ExternalLink className="size-4" /></a> : null}</>}
          description={interviewCase.recruitmentName ?? "채용 정보 확인 필요"}
          eyebrow="CANDIDATE OVERVIEW"
          title={interviewCase.candidateName ?? "후보자 확인 필요"}
        />

        <Card className="overflow-hidden">
          <CardHeader className="border-b border-slate-200 p-5 sm:p-7">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">CANDIDATE JOURNEY</p><CardTitle className="mt-2 text-2xl sm:text-3xl">채용 진행 상태</CardTitle><CardDescription className="mt-2 text-base">{candidateJourney ? `현재 ${candidateJourney.currentStageLabel} · ${candidateJourney.currentStageDetail}` : "채용 진행 단계를 확인하고 있습니다."}</CardDescription></div><Badge variant={statusVariant(interviewCase.status)}>{statusLabel(interviewCase)}</Badge></div>
          </CardHeader>
          <CardContent className="p-5 sm:p-7">
            {candidateJourney ? <div className="overflow-x-auto pb-2"><ol aria-label="후보자 채용 여정" className="flex min-w-max items-start">
              {candidateJourney.stages.map((stage, index) => {
                const completed = stage.state === "COMPLETED";
                const scheduled = stage.state === "SCHEDULED";
                const current = stage.state === "CURRENT";
                const stopped = stage.state === "STOPPED";
                return <li className="flex min-w-[9.25rem] flex-1 items-start last:min-w-0" key={stage.id}>
                  <div className="grid min-w-[7.25rem] gap-2"><span aria-current={current ? "step" : undefined} className={`grid size-10 place-items-center rounded-full text-sm font-bold ${completed || scheduled ? "bg-emerald-600 text-white" : current ? "bg-blue-600 text-white ring-4 ring-blue-100" : stopped ? "bg-rose-600 text-white" : "bg-slate-100 text-slate-500"}`}>{completed ? <CheckCircle2 className="size-5" /> : scheduled ? <CalendarClock className="size-5" /> : index + 1}</span><strong className={`text-base leading-6 ${current ? "text-slate-950" : completed || scheduled ? "text-emerald-700" : stopped ? "text-rose-700" : "text-slate-500"}`}>{stage.label}</strong><span className={`text-sm leading-5 ${current ? "font-medium text-blue-700" : scheduled ? "font-medium text-emerald-700" : "text-slate-500"}`}>{stage.detail}</span></div>
                  {index < candidateJourney.stages.length - 1 ? <span aria-hidden="true" className={`mt-5 h-px min-w-6 flex-1 ${completed ? "bg-emerald-400" : "bg-slate-200"}`} /> : null}
                </li>;
              })}
            </ol></div> : <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-base text-slate-600">채용별 인터뷰 규칙을 확인하면 전체 진행 단계를 표시합니다.</div>}
            <div className="mt-8">
              {scheduleDeletionReview ? <CaseScheduleExceptionAction embedded reviewId={scheduleDeletionReview.id} /> : <div className={`flex items-start gap-3 rounded-xl border p-5 ${action.tone === "blue" ? "border-blue-100 bg-blue-50/70" : action.tone === "amber" ? "border-amber-200 bg-amber-50/70" : "border-slate-200 bg-slate-50"}`}>
                {exceptionStatus ? <CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-700" /> : <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-blue-700" />}
                <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-600">CURRENT SCHEDULING TASK</p><h2 className="mt-2 text-lg font-bold tracking-tight text-slate-950">{action.title}</h2><p className="mt-2 text-base leading-7 text-slate-700">{action.description}</p></div>
              </div>}
            </div>
          </CardContent>
        </Card>

        <CasePlanOverrides
          caseId={interviewCase.id}
          editable={["READY_FOR_DRAFT", "DRAFT_CREATED"].includes(interviewCase.status)}
          hasCandidateOverride={plan?.source === "CANDIDATE_OVERRIDE"}
          interviewers={activeInterviewers.map((interviewer) => ({ id: interviewer.id, displayName: interviewer.displayName, required: interviewer.required }))}
          steps={(template?.steps ?? []).map((step) => ({ stepId: step.stepId, name: step.name, order: step.order }))}
        />

        <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]" data-case-detail-panels>
          <Card>
            <CardHeader className="border-b border-slate-100"><div className="flex items-center gap-2 text-blue-600"><CalendarClock className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">INTERVIEW DETAILS</p></div><CardTitle className="mt-2 text-xl">인터뷰 일정 요약</CardTitle><CardDescription>후보자에게 안내할 일정과 회의실을 확인합니다.</CardDescription></CardHeader>
            <CardContent className="p-6"><dl className="grid gap-5">
              <div className="grid gap-1 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-5"><dt className="text-sm font-medium text-slate-500">인터뷰 유형</dt><dd className="m-0 text-base font-bold leading-6 text-slate-900">{interviewType}</dd></div>
              <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-5"><dt className="text-sm font-medium text-slate-500">{scheduleLabel}</dt><dd className="m-0 grid gap-2 text-base font-semibold leading-6 text-slate-900">
                {scheduledSegments.length > 0 ? scheduledSegments.map((segment) => <span className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5" key={`${segment.date}-${segment.startTime}-${segment.roomName}-${segment.stepId ?? "single"}`}><span className="text-blue-700">{segment.date} {segment.startTime}–{segment.endTime}</span>{segment.stepId ? <><span className="text-slate-400">·</span><span>{stepName(segment.stepId, plan)}</span></> : null}<span className="text-slate-400">·</span><span>{segment.roomName}</span></span>) : interviewCase.scheduledDate ? `${interviewCase.scheduledDate} ${interviewCase.scheduledStartTime}–${interviewCase.scheduledEndTime}${interviewCase.scheduledRoomName ? ` · ${interviewCase.scheduledRoomName}` : ""}` : "아직 확정된 일정이 없습니다."}
                {interviewCase.scheduledDate ? <span className="text-sm font-medium text-slate-500">({duration}분)</span> : null}
              </dd></div>
              <div className="grid gap-1 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-5"><dt className="text-sm font-medium text-slate-500">일정 상태</dt><dd className="m-0 text-base font-bold leading-6 text-slate-900">{interviewCase.status === "CONFIRMED" ? <span className="text-emerald-700">{confirmedScheduleStatus(interviewCase)}</span> : interviewCase.candidateScheduleProposalSent ? <span className="text-emerald-700">나인하이어 일정 제안 발송 완료 · 응답 대기</span> : <span className="text-amber-700">나인하이어 일정 제안 발송 여부 확인 필요</span>}</dd></div>
            </dl></CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b border-slate-100"><div className="flex items-center gap-2 text-blue-600"><UsersRound className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">INTERVIEWERS</p></div><CardTitle className="mt-2 text-xl">면접관 일정 제출</CardTitle><CardDescription>현재 인터뷰 단계의 평가표 등록 면접관입니다.</CardDescription></CardHeader>
            <CardContent className="p-6">{activeInterviewers.length > 0 ? <><p className="mb-4 rounded-lg bg-slate-50 px-3 py-2.5 text-sm leading-6 text-slate-700">{activeInterviewers.every((interviewer) => interviewer.status === "SUBMITTED") ? "모든 면접관이 제출 완료했습니다." : `미제출 면접관: ${activeInterviewers.filter((interviewer) => interviewer.status === "PENDING").map((interviewer) => interviewer.displayName).join(", ") || "없음"}`}</p><div className="max-h-[23rem] overflow-y-auto pr-1" tabIndex={0} aria-label="면접관 목록"><div className="divide-y divide-slate-200">{activeInterviewers.map((interviewer) => <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0" key={interviewer.id}><div className="min-w-0"><p className="truncate text-base font-bold text-slate-950">{interviewer.displayName}</p><p className="mt-1 text-sm text-slate-500">{interviewer.source === "NINEHIRE" ? "나인하이어 평가표 등록 면접관" : "면접관"}</p></div><Badge variant={interviewer.status === "SUBMITTED" ? "success" : interviewer.status === "DECLINED_PENDING_REVIEW" ? "warning" : "secondary"}>{interviewerStatus(interviewer.status)}</Badge></div>)}</div></div></> : <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-base leading-7 text-slate-600">현재 단계의 평가표에 등록된 면접관이 없습니다. 나인하이어 평가표 설정을 확인하거나 직접 지정해 주세요.</div>}</CardContent>
          </Card>
        </section>

        <section className="mt-6 grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader className="border-b border-slate-100"><div className="flex items-center gap-2 text-blue-600"><MessageSquareText className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">SLACK MESSAGES</p></div><CardTitle className="mt-2 text-xl">안내 메시지 상태</CardTitle><CardDescription>발송 전 초안은 승인 후 Slack에 전송됩니다.</CardDescription></CardHeader>
            <CardContent className="max-h-[31rem] overflow-y-auto p-6" tabIndex={0} aria-label="Slack 안내 메시지 목록">{bundle.drafts.length > 0 ? <DraftApprovalCard drafts={bundle.drafts.map((draft) => ({ id: draft.id, messageType: draft.messageType, status: draft.status, previewText: draft.previewText, blocksJson: draft.blocksJson, createdAt: draft.createdAt }))} interviewerNames={Object.fromEntries(bundle.interviewers.filter((interviewer) => interviewer.slackUserId).map((interviewer) => [interviewer.slackUserId!, interviewer.displayName]))} /> : <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-base text-slate-600">생성된 Slack 초안이 없습니다.</div>}</CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b border-slate-100"><div className="flex items-center gap-2 text-blue-600"><Clock3 className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">ACTIVITY LOG</p></div><CardTitle className="mt-2 text-xl">업무 이력</CardTitle><CardDescription>상태 변경과 외부 연동 기록을 최신순으로 표시합니다.</CardDescription></CardHeader>
            <CardContent className="max-h-[31rem] overflow-y-auto p-6" tabIndex={0} aria-label="업무 이력 목록">{events.length > 0 ? <ol className="divide-y divide-slate-200">{events.map((event) => <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-4 first:pt-0 last:pb-0" key={event.id}><div><p className="text-base font-bold text-slate-950">{activityEventLabel(event.eventType, event.detail)}</p><p className="mt-1 text-sm text-slate-500">{event.eventType} · {formatDateTime(event.createdAt)}</p></div><span className="text-sm text-slate-500">{activityActorLabel(event.actor)}</span></li>)}</ol> : <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-base text-slate-600">기록된 업무 이력이 없습니다.</div>}</CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}
