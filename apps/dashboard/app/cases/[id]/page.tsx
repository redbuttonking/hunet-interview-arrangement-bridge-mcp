// 후보자별 인터뷰 조율 상태와 필요한 다음 업무를 공통 화면 체계로 보여준다.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { AppHeader, PageHeader } from "../../components/app-shell";
import { DraftApprovalCard } from "../../components/draft-approval-card";
import { CasePlanOverrides } from "../../components/case-plan-overrides";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { activityActorLabel, activityEventLabel } from "../../lib/activity-labels";
import { loadCaseDetail } from "../../lib/data";

export const dynamic = "force-dynamic";

const journeySteps = ["조율 시작", "면접관 일정", "시간·회의실", "후보자 응답", "최종 확정"];

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
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
  if (["REVIEW_REQUIRED", "CANCELLED", "ON_HOLD"].includes(status)) return "warning" as const;
  return "default" as const;
}

function journeyIndex(status: string) {
  if (["READY_FOR_DRAFT", "DRAFT_CREATED"].includes(status)) return 0;
  if (["REQUEST_SENT", "COLLECTING_AVAILABILITY"].includes(status)) return 1;
  if (["READY_TO_SCHEDULE", "REVIEW_REQUIRED"].includes(status)) return 2;
  if (status === "AWAITING_CANDIDATE_CONFIRMATION") return 3;
  return 4;
}

function nextAction(status: string, pendingResponses: number) {
  const actions: Record<string, { title: string; description: string }> = {
    READY_FOR_DRAFT: { title: "인터뷰 조율을 시작할지 확인해 주세요.", description: "운영 보드의 사용자 판단 단계에서 인터뷰 유형을 선택합니다." },
    DRAFT_CREATED: { title: "면접관 일정 요청 초안을 검토해 주세요.", description: "초안을 승인하기 전에는 Slack 메시지가 발송되지 않습니다." },
    READY_TO_SCHEDULE: { title: "추천 시간과 회의실을 선택해 주세요.", description: "면접관 가용시간과 다우오피스 회의실 예약 블록을 함께 확인합니다." },
    AWAITING_CANDIDATE_CONFIRMATION: { title: "후보자의 일정 답변을 기다리고 있습니다.", description: "나인하이어에서 후보자가 확정하면 로컬 운영 상태에 반영됩니다." },
    CONFIRMED: { title: "인터뷰가 최종 확정되었습니다.", description: "면접관 안내 메시지 발송 여부와 일정 정보를 확인해 주세요." },
    REVIEW_REQUIRED: { title: "예외 상황을 확인하고 다음 조치를 결정해 주세요.", description: "재조율, 보류, 취소 중 하나를 사용자의 판단으로 선택합니다." },
    ON_HOLD: { title: "인터뷰 조율을 보류한 상태입니다.", description: "운영 보드에서 보류 해제를 선택하면 이전 조율 단계로 돌아갑니다." },
    CANCELLED: { title: "인터뷰 조율이 취소된 상태입니다.", description: "다우오피스의 기존 회의실 예약 블록은 그대로 유지합니다." },
  };
  if (["REQUEST_SENT", "COLLECTING_AVAILABILITY"].includes(status)) {
    return {
      title: pendingResponses > 0 ? `필수 면접관 ${pendingResponses}명의 응답을 기다리고 있습니다.` : "면접관 응답을 확인하고 있습니다.",
      description: "미응답이 지속되면 리마인드 또는 수동 수집 여부를 운영 보드에서 판단합니다.",
    };
  }
  return actions[status] ?? { title: "현재 상태를 확인해 주세요.", description: "운영 보드에서 필요한 다음 작업을 확인합니다." };
}

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = loadCaseDetail(id);
  if (!data) notFound();
  const { bundle, plan, template, events } = data;
  const interviewCase = bundle.interviewCase;
  const activeInterviewers = bundle.interviewers.filter(
    (interviewer) => interviewer.active,
  );
  const currentJourneyIndex = journeyIndex(interviewCase.status);
  const action = nextAction(
    interviewCase.status,
    activeInterviewers.filter(
      (interviewer) => interviewer.required && interviewer.status === "PENDING",
    ).length,
  );
  const interviewType = plan
    ? `${plan.mode === "COMBINED" ? "통합" : plan.mode === "SEQUENTIAL" ? "연속" : "단일"} · ${plan.stepNames.join(plan.mode === "SEQUENTIAL" ? " → " : " + ")}`
    : "인터뷰 유형 확인 필요";
  const duration = plan?.durationMinutes ?? interviewCase.durationMinutes;

  return (
    <div className="min-h-screen bg-slate-50">
      <AppHeader active="operations" />
      <main className="mx-auto max-w-[1440px] px-5 pb-12 sm:px-8">
        <div className="pt-7"><Link className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition-colors hover:text-blue-700" href="/"><ArrowLeft className="size-4" />운영 보드</Link></div>
        <PageHeader
          actions={<Badge className="px-3 py-1 text-sm" variant={statusVariant(interviewCase.status)}>{statusLabel(interviewCase.status)}</Badge>}
          description={interviewCase.recruitmentName ?? "채용 정보 확인 필요"}
          eyebrow="CANDIDATE OVERVIEW"
          title={interviewCase.candidateName ?? "후보자 확인 필요"}
        />

        <Card>
          <CardHeader className="border-b border-slate-200 p-6 sm:p-7"><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">INTERVIEW JOURNEY</p><CardTitle className="mt-2 text-2xl">진행 상태</CardTitle><CardDescription className="text-base">{interviewType} · {duration}분 인터뷰입니다.</CardDescription></CardHeader>
          <CardContent className="p-6 sm:p-7">
            <ol className="grid gap-4 sm:grid-cols-5 sm:gap-0">
              {journeySteps.map((step, index) => {
                const isCompleted = index < currentJourneyIndex;
                const isCurrent = index === currentJourneyIndex;
                return (
                  <li className="relative flex items-center gap-3 sm:block" key={step}>
                    {index < journeySteps.length - 1 ? <span className="absolute left-5 top-10 hidden h-px w-[calc(100%-10px)] bg-slate-200 sm:block" /> : null}
                    <span className={`relative z-10 grid size-10 shrink-0 place-items-center rounded-full text-sm font-bold ${isCompleted ? "bg-emerald-600 text-white" : isCurrent ? "bg-blue-600 text-white ring-4 ring-blue-100" : "bg-slate-100 text-slate-500"}`}>{isCompleted ? <CheckCircle2 className="size-5" /> : index + 1}</span>
                    <strong className={`text-base sm:mt-3 sm:block ${isCurrent ? "text-slate-950" : "text-slate-600"}`}>{step}</strong>
                  </li>
                );
              })}
            </ol>
            <div className="mt-8 rounded-xl border-l-4 border-blue-600 bg-blue-50/70 p-5"><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-700">NEXT ACTION</p><h2 className="mt-2 text-lg font-semibold tracking-tight text-slate-950">{action.title}</h2><p className="mt-2 text-base leading-7 text-slate-700">{action.description}</p></div>
          </CardContent>
        </Card>

        <CasePlanOverrides
          caseId={interviewCase.id}
          editable={["READY_FOR_DRAFT", "DRAFT_CREATED"].includes(interviewCase.status)}
          interviewers={activeInterviewers.map((interviewer) => ({
            id: interviewer.id,
            displayName: interviewer.displayName,
            required: interviewer.required,
          }))}
          steps={(template?.steps ?? []).map((step) => ({
            stepId: step.stepId,
            name: step.name,
            order: step.order,
          }))}
        />

        <section className="mt-6 grid gap-5 lg:grid-cols-2" data-case-detail-panels>
          <Card>
            <CardHeader><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">INTERVIEW DETAILS</p><CardTitle className="mt-2">인터뷰 요약</CardTitle></CardHeader>
            <CardContent><dl className="grid gap-4">{[
              ["인터뷰 유형", interviewType],
              ["소요 시간", `${duration}분`],
              ["일정", interviewCase.scheduledDate ? `${interviewCase.scheduledDate} ${interviewCase.scheduledStartTime}–${interviewCase.scheduledEndTime}` : "아직 확정된 일정이 없습니다."],
              ["회의실", interviewCase.scheduledRoomName ?? "회의실 선택 또는 확인 필요"],
            ].map(([label, value]) => <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-5" key={label}><dt className="text-sm font-medium text-slate-500">{label}</dt><dd className="m-0 text-base font-semibold leading-6 text-slate-900">{value}</dd></div>)}</dl></CardContent>
          </Card>

          <Card>
            <CardHeader><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">INTERVIEWERS</p><CardTitle className="mt-2">면접관 일정 제출</CardTitle></CardHeader>
            <CardContent>{activeInterviewers.length > 0 ? <div className="divide-y divide-slate-200">{activeInterviewers.map((interviewer) => <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0" key={interviewer.id}><div><p className="text-base font-semibold">{interviewer.displayName}</p><p className="mt-1 text-sm text-slate-600">{interviewer.required ? "필수 면접관" : "선택 면접관"}</p></div><Badge variant={interviewer.status === "SUBMITTED" ? "success" : interviewer.status === "DECLINED_PENDING_REVIEW" ? "warning" : "secondary"}>{interviewerStatus(interviewer.status)}</Badge></div>)}</div> : <p className="text-base text-slate-600">동기화된 면접관이 없습니다.</p>}</CardContent>
          </Card>

          <Card>
            <CardHeader><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">SLACK MESSAGES</p><CardTitle className="mt-2">안내 메시지 상태</CardTitle></CardHeader>
            <CardContent>{bundle.drafts.length > 0 ? <DraftApprovalCard drafts={bundle.drafts.map((draft) => ({ id: draft.id, messageType: draft.messageType, status: draft.status, previewText: draft.previewText, createdAt: draft.createdAt }))} /> : <p className="text-base text-slate-600">생성된 Slack 초안이 없습니다.</p>}</CardContent>
          </Card>

          <Card>
            <CardHeader><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">ACTIVITY LOG</p><CardTitle className="mt-2">업무 이력</CardTitle></CardHeader>
            <CardContent>{events.length > 0 ? <ol className="divide-y divide-slate-200">{events.map((event) => <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-4 first:pt-0 last:pb-0" key={event.id}><div><p className="text-base font-semibold text-slate-950">{activityEventLabel(event.eventType)}</p><p className="mt-1 text-sm text-slate-500">{event.eventType} · {formatDateTime(event.createdAt)}</p></div><span className="text-sm text-slate-500">{activityActorLabel(event.actor)}</span></li>)}</ol> : <p className="text-base text-slate-600">기록된 업무 이력이 없습니다.</p>}</CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}
