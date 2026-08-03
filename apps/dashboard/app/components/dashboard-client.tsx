"use client";
// 인터뷰 운영자가 우선순위 업무와 다음 일정을 같은 기준으로 처리하게 한다.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, CalendarClock, CheckCircle2, ClipboardList, Clock3, Loader2, RefreshCw, Search, TriangleAlert, UsersRound, Wifi } from "lucide-react";
import { AppHeader, PageHeader } from "./app-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import type { CandidateCase, DashboardSnapshot, Decision, EvaluationSummary, HeldWork, InterviewCaseStatus, Review } from "../lib/dashboard-types";

type ActionPriority = "urgent" | "normal" | "watch";
type ActionQueue = "ACTION" | "WAITING" | "EXCEPTION";

type ActionItem = {
  id: string;
  queue: ActionQueue;
  priority: ActionPriority;
  journeyIndex: number;
  category: string;
  title: string;
  description: string;
  candidateName: string | null;
  recruitmentName: string | null;
  meta: string | null;
  actionLabel: string | null;
  href: string | null;
  decision?: Decision;
  review?: Review;
  caseId?: string;
  caseSkillKey?: "AVAILABILITY_COLLECTION" | "INTERVIEW_SCHEDULING" | "CANDIDATE_SCHEDULE_PROPOSAL";
  relatedItems?: ActionItem[];
};

type ActiveDecision = {
  decision: Decision;
  dismissOnClose: boolean;
};

type RecruitmentTemplatePreview = {
  kind: "RECRUITMENT_TEMPLATE_PREVIEW";
  preview: {
    recruitmentId: string;
    recruitmentName: string;
    requiresApproval: boolean;
    approvedTemplate: {
      steps: Array<{
        stepId: string;
        mode: "STANDARD" | "COMBINED";
        durationMinutes: number;
      }>;
    } | null;
    steps: Array<{
      stepId: string;
      title: string;
      name: string;
      order: number;
      suggestedAsInterview: boolean;
      suggestedMode: "STANDARD" | "COMBINED" | null;
      defaultDurationMinutes: number;
    }>;
  };
};

const supportedReviewDecisionTypes = new Set([
  "INTERVIEW_ARRANGEMENT_START_REQUIRED",
  "RECRUITMENT_TEMPLATE_UPDATE_REQUIRED",
  "RECRUITMENT_TEMPLATE_CHECK_REQUIRED",
  "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED",
  "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED",
]);

function formatDate(value: string | null | undefined) {
  if (!value) return "일정 미정";
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short" }).format(
    new Date(`${value}T00:00:00+09:00`),
  );
}

function formatGeneratedAt(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatDateTime(value: string | undefined) {
  if (!value) return "완료 시각 미확인";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatSchedule(interviewCase: CandidateCase) {
  if (!interviewCase.scheduledDate || !interviewCase.scheduledStartTime) return "일정 미정";
  const room = interviewCase.scheduledRoomName ? ` · ${interviewCase.scheduledRoomName}` : "";
  return `${formatDate(interviewCase.scheduledDate)} ${interviewCase.scheduledStartTime}–${interviewCase.scheduledEndTime ?? ""}${room}`;
}

function stageLabel(interviewCase: CandidateCase) {
  const plan = interviewCase.interviewPlan;
  if (!plan || plan.stepNames.length === 0) return "인터뷰 계획 확인 필요";
  const name = plan.stepNames.join(plan.mode === "SEQUENTIAL" ? " → " : " + ");
  if (plan.mode === "COMBINED") return `${name} 통합 인터뷰`;
  if (plan.mode === "SEQUENTIAL") return `${name} 연속 인터뷰`;
  return name;
}

function journeyIndexForStatus(status: InterviewCaseStatus) {
  if (["READY_FOR_DRAFT", "DRAFT_CREATED"].includes(status)) return 0;
  if (["REQUEST_SENT", "COLLECTING_AVAILABILITY"].includes(status)) return 1;
  if (["READY_TO_SCHEDULE", "REVIEW_REQUIRED"].includes(status)) return 2;
  if (status === "AWAITING_CANDIDATE_CONFIRMATION") return 3;
  return 4;
}

function journeyIndexForReview(review: Review) {
  return review.reviewType === "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED" ? 3 : 0;
}

function reviewCategory(review: Review) {
  const labels: Record<string, string> = {
    INTERVIEW_ARRANGEMENT_START_REQUIRED: "조율 시작 확인",
    RECRUITMENT_TEMPLATE_UPDATE_REQUIRED: "인터뷰 규칙 확인",
    RECRUITMENT_TEMPLATE_CHECK_REQUIRED: "인터뷰 규칙 확인",
    CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED: "후보자 응답 확인",
    WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED: "가용시간 복구 확인",
  };
  return labels[review.reviewType] ?? "운영 확인";
}

function caseAction(interviewCase: CandidateCase): ActionItem | undefined {
  const base = {
    id: `case:${interviewCase.id}`,
    caseId: interviewCase.id,
    journeyIndex: journeyIndexForStatus(interviewCase.status),
    candidateName: interviewCase.candidateName,
    recruitmentName: interviewCase.recruitmentName,
    href: `/cases/${interviewCase.id}`,
  };

  if (interviewCase.status === "READY_FOR_DRAFT") {
    return {
      ...base,
      queue: "ACTION",
      priority: "urgent",
      category: "면접관 일정 준비",
      title: "면접관 가능 일정 요청을 준비해 주세요.",
      description: stageLabel(interviewCase),
      meta: "초안 검토와 Slack 발송 승인은 다음 단계에서 진행합니다.",
      actionLabel: "일정 요청 준비",
      caseSkillKey: "AVAILABILITY_COLLECTION",
    };
  }
  if (["REQUEST_SENT", "COLLECTING_AVAILABILITY"].includes(interviewCase.status)) {
    return {
      ...base,
      queue: "WAITING",
      priority: "normal",
      category: "면접관 일정 수집",
      title: "면접관 가능 일정 제출 상태를 확인해 주세요.",
      description: `${stageLabel(interviewCase)} · 제출 ${interviewCase.interviewerResponses.submitted}/${interviewCase.interviewerResponses.required}`,
      meta: interviewCase.interviewerResponses.pending > 0 ? `미제출 ${interviewCase.interviewerResponses.pending}명` : "모든 필수 면접관이 제출했습니다.",
      actionLabel: "제출 상태 확인",
      caseSkillKey: "AVAILABILITY_COLLECTION",
    };
  }
  if (interviewCase.status === "READY_TO_SCHEDULE") {
    return {
      ...base,
      queue: "ACTION",
      priority: "urgent",
      category: "시간·회의실 검토",
      title: "인터뷰 시간과 회의실을 선택할 수 있습니다.",
      description: `${stageLabel(interviewCase)} · 면접관 응답 ${interviewCase.interviewerResponses.submitted}/${interviewCase.interviewerResponses.required}`,
      meta: "추천 결과를 확인해 주세요.",
      actionLabel: "일정 검토",
      caseSkillKey: "INTERVIEW_SCHEDULING",
    };
  }
  if (interviewCase.status === "DRAFT_CREATED") {
    return {
      ...base,
      queue: "ACTION",
      priority: "normal",
      category: "면접관 요청 초안",
      title: "면접관에게 보낼 일정 요청 초안을 검토해 주세요.",
      description: stageLabel(interviewCase),
      meta: "승인 전에는 Slack으로 발송되지 않습니다.",
      actionLabel: "초안 확인",
    };
  }
  if (interviewCase.status === "AWAITING_CANDIDATE_CONFIRMATION") {
    if (!interviewCase.candidateScheduleProposalSent) {
      return {
        ...base,
        queue: "ACTION",
        priority: "urgent",
        category: "후보자 일정 제안 확인",
        title: "나인하이어 일정 제안 발송 여부를 확인해 주세요.",
        description: formatSchedule(interviewCase),
        meta: "발송이 끝났다면 완료를 기록하고, 아직 발송 전이면 나인하이어에서 먼저 처리합니다.",
        actionLabel: "발송 완료 기록",
        caseSkillKey: "CANDIDATE_SCHEDULE_PROPOSAL",
      };
    }
    return {
      ...base,
      queue: "WAITING",
      priority: "normal",
      category: "후보자 응답 대기",
      title: "내부 확정된 인터뷰 일정의 후보자 응답을 기다리고 있습니다.",
      description: formatSchedule(interviewCase),
      meta: "후보자에게 보내는 나인하이어 일정 제안은 직접 처리합니다.",
      actionLabel: "일정 확인",
    };
  }
  if (interviewCase.status === "REVIEW_REQUIRED") {
    return {
      ...base,
      queue: "EXCEPTION",
      priority: "urgent",
      category: "예외 확인",
      title: "조율을 계속하기 전에 운영 확인이 필요합니다.",
      description: stageLabel(interviewCase),
      meta: interviewCase.isReschedule ? "재조율 건입니다." : null,
      actionLabel: "상세 보기",
    };
  }
  return undefined;
}

function buildActionItems(data: DashboardSnapshot): ActionItem[] {
  const casesById = new Map(data.dashboard.cases.map((interviewCase) => [interviewCase.id, interviewCase]));
  const caseIdsWithDecision = new Set(data.decisions.map((decision) => decision.caseId).filter((caseId): caseId is string => Boolean(caseId)));
  const reviewIdsWithDecision = new Set(data.decisions.map((decision) => decision.reviewId).filter((reviewId): reviewId is string => Boolean(reviewId)));
  const caseIdsWithReview = new Set(data.reviews.map((review) => review.caseId).filter((caseId): caseId is string => Boolean(caseId)));

  const decisionItems: ActionItem[] = data.decisions.map((decision) => ({
    id: `decision:${decision.id}`,
    queue: "ACTION",
    priority: "urgent",
    journeyIndex: decision.caseId && casesById.get(decision.caseId)
      ? journeyIndexForStatus(casesById.get(decision.caseId)!.status)
      : 0,
    category: "선택 대기",
    title: decision.title,
    description: decision.prompt,
    candidateName: decision.candidateName,
    recruitmentName: decision.recruitmentName,
    meta: "선택 적용 전에는 인터뷰 상태가 바뀌지 않습니다.",
    actionLabel: "결정 계속하기",
    href: decision.caseId ? `/cases/${decision.caseId}` : null,
    decision,
  }));
  const reviewItems: ActionItem[] = data.reviews
    .filter((review) => !reviewIdsWithDecision.has(review.id))
    .map((review) => ({
      id: `review:${review.id}`,
      queue: review.reviewType === "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED" || !supportedReviewDecisionTypes.has(review.reviewType) ? "EXCEPTION" : "ACTION",
      priority: supportedReviewDecisionTypes.has(review.reviewType) ? "urgent" : "normal",
      journeyIndex: review.caseId && casesById.get(review.caseId)
        ? journeyIndexForStatus(casesById.get(review.caseId)!.status)
        : journeyIndexForReview(review),
      category: reviewCategory(review),
      title: review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED"
        ? "인터뷰 조율을 시작할지 확인해 주세요."
        : review.reviewType === "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED"
          ? "후보자 응답에 대한 처리 방법을 선택해 주세요."
          : review.reason,
      description: review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED"
        ? `${review.currentStepName ?? "평가 완료"} · ${review.reason}`
        : review.currentStepName ?? "상세 내용을 확인해 주세요.",
      candidateName: review.candidateName,
      recruitmentName: review.recruitmentName,
      meta: review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED" ? "승인 전에는 나인하이어·Slack에 변경이 없습니다." : null,
      actionLabel: review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED"
        ? "조율 시작 검토"
        : review.reviewType === "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED"
          ? "응답 조치 선택"
          : supportedReviewDecisionTypes.has(review.reviewType)
            ? "규칙 확인"
            : review.caseId ? "상세 보기" : null,
      href: review.caseId ? `/cases/${review.caseId}` : null,
      review,
    }));
  const caseItems = data.dashboard.cases
    .filter((interviewCase) => !caseIdsWithDecision.has(interviewCase.id) && !caseIdsWithReview.has(interviewCase.id))
    .map(caseAction)
    .filter((item): item is ActionItem => Boolean(item));

  return groupActionItems([...decisionItems, ...reviewItems, ...caseItems]
    .sort((left, right) => ({ urgent: 0, normal: 1, watch: 2 }[left.priority] - { urgent: 0, normal: 1, watch: 2 }[right.priority])));
}

function actionGroupKey(item: ActionItem) {
  if (item.caseId) return `${item.queue}:case:${item.caseId}`;
  if (item.candidateName && item.recruitmentName) return `${item.queue}:candidate:${item.candidateName}:${item.recruitmentName}`;
  return `${item.queue}:${item.id}`;
}

function groupActionItems(items: ActionItem[]) {
  const groups = new Map<string, ActionItem>();
  for (const item of items) {
    const key = actionGroupKey(item);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...item });
      continue;
    }
    current.relatedItems = [...(current.relatedItems ?? []), item];
  }
  return [...groups.values()];
}

function priorityStyle(priority: ActionPriority) {
  if (priority === "urgent") return { dot: "bg-amber-500", badge: "warning" as const, label: "우선 처리" };
  if (priority === "watch") return { dot: "bg-slate-400", badge: "secondary" as const, label: "확인 필요" };
  return { dot: "bg-blue-500", badge: "default" as const, label: "검토 대기" };
}

function EvaluationSummaryPanel({ evaluation }: { evaluation: EvaluationSummary | null | undefined }) {
  if (!evaluation) {
    return <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600">저장된 완료 평가표 요약이 없습니다. 나인하이어 동기화 상태를 확인해 주세요.</p>;
  }

  return (
    <section aria-label="나인하이어 평가표 요약" className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="text-sm font-semibold text-slate-950">나인하이어 평가표 요약</p><p className="mt-1 text-sm text-slate-600">완료된 평가표 {evaluation.scoreSheets.length}건을 기준으로 표시합니다.</p></div>
        {evaluation.currentStep ? <Badge variant="secondary">현재 {evaluation.currentStep.name}</Badge> : null}
      </div>
      <div className="mt-4 grid max-h-[52vh] gap-3 overflow-y-auto pr-1">
        {evaluation.scoreSheets.map((scoreSheet, scoreSheetIndex) => (
          <article className="rounded-lg border border-slate-200 bg-white p-4" key={`${scoreSheet.title}-${scoreSheetIndex}`}>
            <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-base font-semibold text-slate-950">{scoreSheet.title}</p><p className="mt-1 text-sm text-slate-600">{scoreSheet.evaluationMethod ?? "평가 방식 미확인"} · {formatDateTime(scoreSheet.completedAt)}</p></div><Badge variant="outline">평가자 {scoreSheet.evaluators.length}명</Badge></div>
            <div className="mt-4 grid gap-3">
              {scoreSheet.evaluators.map((evaluator, evaluatorIndex) => (
                <div className="rounded-lg bg-slate-50 p-3" key={`${scoreSheet.title}-${evaluator.name}-${evaluatorIndex}`}>
                  <p className="text-sm font-semibold text-slate-900">{evaluator.name}<span className="ml-2 font-normal text-slate-500">{formatDateTime(evaluator.submittedAt)}</span></p>
                  {evaluator.items.length > 0 ? <div className="mt-3 grid gap-2">{evaluator.items.map((item, itemIndex) => (
                    <div className="text-sm leading-6 text-slate-700" key={`${evaluator.name}-${item.title}-${itemIndex}`}>
                      <div className="flex flex-wrap items-center gap-2"><strong>{item.title}</strong>{item.finalEvaluation ? <Badge variant="warning">최종 판단</Badge> : null}</div>
                      <p className="mt-1">{item.selectedOptions.length > 0 ? item.selectedOptions.map((option) => `${option.title}${option.score !== undefined ? ` (${option.score}점)` : ""}`).join(", ") : "선택 결과 없음"}</p>
                      {item.comment ? <p className="mt-1 rounded bg-white px-2 py-1 text-slate-600">{item.comment}</p> : null}
                    </div>
                  ))}</div> : <p className="mt-2 text-sm text-slate-600">세부 평가 항목이 없습니다.</p>}
                  {evaluator.comment ? <p className="mt-3 border-t border-slate-200 pt-3 text-sm leading-6 text-slate-700">평가 의견. {evaluator.comment}</p> : null}
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DecisionModal({ activeDecision, evaluationSummary, onClose, onResolve, loading }: {
  activeDecision: ActiveDecision;
  evaluationSummary?: EvaluationSummary | null;
  onClose: () => void;
  onResolve: (optionId: string) => void;
  loading: boolean;
}) {
  const { decision, dismissOnClose } = activeDecision;
  const [selectedOptionId, setSelectedOptionId] = useState(decision.options[0]?.id ?? "");

  useEffect(() => {
    setSelectedOptionId(decision.options[0]?.id ?? "");
  }, [decision.id, decision.options]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">선택 내용 확인</p>
          <DialogTitle>{decision.title}</DialogTitle>
          <DialogDescription>{decision.candidateName ?? "후보자"} · {decision.recruitmentName ?? "채용 정보 확인 필요"}</DialogDescription>
        </DialogHeader>
        <p className="text-base leading-7 text-slate-700">{decision.prompt}</p>
        {decision.decisionType === "START_INTERVIEW_ARRANGEMENT" || decision.decisionType === "SELECT_INTERVIEW_ROUTE" || decision.decisionType === "REVIEW_RECRUITMENT_TEMPLATE" ? <EvaluationSummaryPanel evaluation={evaluationSummary} /> : null}
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600">`선택 적용`을 누르기 전에는 인터뷰 상태나 외부 시스템이 변경되지 않습니다.</p>
        <div className="grid gap-3">
          {decision.options.map((option) => (
            <label key={option.id} className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors ${selectedOptionId === option.id ? "border-blue-500 bg-blue-50/70" : "border-slate-200 hover:border-slate-300"}`}>
              <input className="mt-1 size-4 accent-blue-600" type="radio" name="decision" value={option.id} checked={selectedOptionId === option.id} onChange={() => setSelectedOptionId(option.id)} />
              <span><strong className="block text-base text-slate-950">{option.label}</strong><small className="mt-1 block text-sm leading-6 text-slate-600">{option.description}</small></span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{dismissOnClose ? "닫기" : "나중에 결정"}</Button>
          <Button disabled={!selectedOptionId || loading} onClick={() => onResolve(selectedOptionId)}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}선택 적용
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type TemplateStepSelection = {
  selected: boolean;
  mode: "STANDARD" | "COMBINED";
  durationMinutes: number;
};

function initialTemplateStepSelections(preview: RecruitmentTemplatePreview["preview"]) {
  const savedSteps = new Map(
    preview.approvedTemplate?.steps.map((step) => [step.stepId, step]) ?? [],
  );
  const hasSavedStepInPipeline = preview.steps.some((step) => savedSteps.has(step.stepId));

  return Object.fromEntries(
    preview.steps.map((step) => {
      const saved = savedSteps.get(step.stepId);
      return [step.stepId, {
        selected: hasSavedStepInPipeline ? Boolean(saved) : step.suggestedAsInterview,
        mode: saved?.mode ?? step.suggestedMode ?? "STANDARD",
        durationMinutes: saved?.durationMinutes ?? step.defaultDurationMinutes,
      } satisfies TemplateStepSelection];
    }),
  ) as Record<string, TemplateStepSelection>;
}

function TemplatePreviewDialog({ preview, onClose, onSave, loading, error }: {
  preview: RecruitmentTemplatePreview["preview"];
  onClose: () => void;
  onSave: (steps: Array<{ stepId: string; mode: "STANDARD" | "COMBINED"; durationMinutes: number }>) => void;
  loading: boolean;
  error: string | null;
}) {
  const suggestedSteps = preview.steps.filter((step) => step.suggestedAsInterview);
  const [selections, setSelections] = useState<Record<string, TemplateStepSelection>>(() => initialTemplateStepSelections(preview));

  useEffect(() => {
    setSelections(initialTemplateStepSelections(preview));
  }, [preview]);

  const selectedSteps = preview.steps.flatMap((step) => {
    const selection = selections[step.stepId];
    if (!selection?.selected) return [];
    return [{
      stepId: step.stepId,
      mode: selection.mode,
      durationMinutes: selection.mode === "COMBINED" ? 60 : selection.durationMinutes,
    }];
  });

  const updateSelection = (stepId: string, update: Partial<TemplateStepSelection>) => {
    setSelections((current) => ({
      ...current,
      [stepId]: { ...current[stepId]!, ...update },
    }));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">RECRUITMENT TEMPLATE</p>
          <DialogTitle>{preview.recruitmentName} 인터뷰 규칙 확인</DialogTitle>
          <DialogDescription>나인하이어의 최신 칸반 단계를 읽어 온 결과입니다.</DialogDescription>
        </DialogHeader>
        <div className={`rounded-lg border px-4 py-3 text-sm leading-6 ${preview.requiresApproval ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
          {preview.requiresApproval
            ? "저장된 인터뷰 규칙이 없거나 현재 칸반과 달라 확인이 필요합니다. 이 화면에서는 아직 저장하지 않습니다."
            : "현재 저장된 인터뷰 규칙이 최신 칸반과 일치합니다."}
        </div>
        <div className="grid gap-3">
          {preview.steps.map((step) => {
            const selection = selections[step.stepId]!;
            return (
            <div className={`flex flex-col gap-3 rounded-xl border p-4 transition-colors sm:flex-row sm:items-start sm:justify-between ${selection.selected ? "border-blue-200 bg-blue-50/40" : "border-slate-200 bg-white"}`} key={step.stepId}>
              <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700 sm:pt-1">
                <input checked={selection.selected} className="size-4 accent-blue-600" onChange={(event) => updateSelection(step.stepId, { selected: event.target.checked })} type="checkbox" />
                인터뷰 단계
              </label>
              <div><p className="text-base font-semibold text-slate-950">{step.order}. {step.name}</p><p className="mt-1 text-sm text-slate-600">{step.title}</p></div>
              {step.suggestedAsInterview ? <Badge variant="default">추천 · {step.suggestedMode === "COMBINED" ? "통합" : "개별"} · {step.defaultDurationMinutes}분</Badge> : <Badge variant="secondary">인터뷰 단계 아님</Badge>}
            </div>
            );
          })}
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
          <p className="text-base font-semibold text-slate-950">선택한 인터뷰 단계 설정</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">개별 인터뷰는 시간을 조정할 수 있고, 통합 인터뷰는 60분으로 고정됩니다.</p>
          {selectedSteps.length > 0 ? <div className="mt-4 grid gap-3">
            {selectedSteps.map((step) => {
              const pipelineStep = preview.steps.find((item) => item.stepId === step.stepId)!;
              const selection = selections[step.stepId]!;
              return <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-[minmax(0,1fr)_180px_160px] sm:items-end" key={step.stepId}>
                <p className="pb-2 text-sm font-semibold text-slate-900">{pipelineStep.order}. {pipelineStep.name}</p>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">진행 방식
                  <select className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-100" onChange={(event) => updateSelection(step.stepId, { mode: event.target.value as "STANDARD" | "COMBINED", durationMinutes: event.target.value === "COMBINED" ? 60 : selection.durationMinutes })} value={selection.mode}>
                    <option value="STANDARD">개별 인터뷰</option>
                    <option value="COMBINED">통합 인터뷰</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">소요 시간
                  <div className="relative"><input className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 pr-10 text-sm font-medium text-slate-900 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100 disabled:text-slate-500" disabled={selection.mode === "COMBINED"} min="15" onChange={(event) => updateSelection(step.stepId, { durationMinutes: Number(event.target.value) || 0 })} step="15" type="number" value={selection.mode === "COMBINED" ? 60 : selection.durationMinutes} /><span className="pointer-events-none absolute right-3 top-2.5 text-sm text-slate-500">분</span></div>
                </label>
              </div>;
            })}
          </div> : <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">인터뷰 조율에 사용할 단계를 하나 이상 선택해 주세요.</p>}
        </div>
        {suggestedSteps.length === 0 ? <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600">자동으로 식별된 인터뷰 단계가 없습니다. 이 채용은 개별 규칙 설정이 필요합니다.</p> : null}
        {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-800">{error}</p> : null}
        <DialogFooter>
          <Button disabled={loading} onClick={onClose} variant="outline">취소</Button>
          <Button disabled={loading || selectedSteps.length === 0 || selectedSteps.some((step) => step.durationMinutes < 15)} onClick={() => onSave(selectedSteps)}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}인터뷰 규칙 저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const actionJourneySteps = ["조율 시작", "면접관 일정", "시간·회의실", "후보자 응답", "최종 확정"];

type InterviewerSlackMappingRequest = {
  kind: "INTERVIEWER_SLACK_MAPPING";
  caseId: string;
  interviewers: Array<{
    ninehireUserId: string;
    displayName: string;
    email: string | null;
  }>;
};

type SlackUserSearchResult = {
  id: string;
  name: string;
  email: string | null;
};

function InterviewerSlackMappingDialog({
  request,
  onClose,
  onFinished,
}: {
  request: InterviewerSlackMappingRequest;
  onClose: () => void;
  onFinished: () => Promise<void>;
}) {
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState(request.interviewers[0]?.displayName ?? "");
  const [users, setUsers] = useState<SlackUserSearchResult[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const interviewer = request.interviewers[index];

  useEffect(() => {
    setIndex(0);
    setQuery(request.interviewers[0]?.displayName ?? "");
    setUsers([]);
    setSelectedUserId("");
  }, [request]);

  const search = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/slack/users?query=${encodeURIComponent(query)}`);
      const result = await response.json() as { users?: SlackUserSearchResult[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Slack 사용자를 검색하지 못했습니다.");
      setUsers(result.users ?? []);
      setSelectedUserId("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Slack 사용자를 검색하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const mapSelectedUser = async () => {
    if (!interviewer || !selectedUserId) return;
    const selected = users.find((user) => user.id === selectedUserId);
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/cases/${request.caseId}/interviewers/map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ninehireUserId: interviewer.ninehireUserId,
          slackUserId: selected.id,
          displayName: interviewer.displayName,
          email: interviewer.email,
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Slack 사용자 연결을 저장하지 못했습니다.");
      if (index + 1 >= request.interviewers.length) {
        await onFinished();
        return;
      }
      const next = request.interviewers[index + 1]!;
      setIndex((current) => current + 1);
      setQuery(next.displayName);
      setUsers([]);
      setSelectedUserId("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Slack 사용자 연결을 저장하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  if (!interviewer) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">SLACK USER MAPPING</p>
          <DialogTitle>면접관 Slack 사용자 연결</DialogTitle>
          <DialogDescription>나인하이어의 면접관과 실제 Slack 사용자를 한 번 연결하면 이후 같은 사람은 자동으로 재사용합니다.</DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4">
          <p className="text-base font-semibold text-slate-950">{interviewer.displayName}</p>
          <p className="mt-1 text-sm text-slate-600">{interviewer.email ?? "나인하이어 이메일 정보가 없습니다."}</p>
          <p className="mt-3 text-sm font-medium text-blue-800">{index + 1} / {request.interviewers.length}명 연결 중</p>
        </div>
        <div className="flex gap-2">
          <input className="h-11 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-base outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-100" onChange={(event) => setQuery(event.target.value)} value={query} />
          <Button disabled={loading || query.trim().length < 2} onClick={() => void search()} type="button" variant="outline">{loading ? <Loader2 className="size-4 animate-spin" /> : null}검색</Button>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-200">
          {users.length === 0 ? <p className="p-4 text-sm text-slate-600">이름 또는 이메일을 입력하고 검색해 주세요.</p> : users.map((user) => (
            <label className={`flex cursor-pointer items-center gap-3 border-b border-slate-100 p-4 last:border-b-0 ${selectedUserId === user.id ? "bg-blue-50/70" : "hover:bg-slate-50"}`} key={user.id}>
              <input checked={selectedUserId === user.id} className="size-4 accent-blue-600" name="slack-user" onChange={() => setSelectedUserId(user.id)} type="radio" />
              <span><strong className="block text-base text-slate-950">{user.name}</strong><small className="mt-1 block text-sm text-slate-600">{user.email ?? user.id}</small></span>
            </label>
          ))}
        </div>
        {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
        <DialogFooter>
          <Button disabled={loading} onClick={onClose} variant="outline">나중에 연결</Button>
          <Button disabled={loading || !selectedUserId} onClick={() => void mapSelectedUser()}>{loading ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}연결 저장</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActionJourney({ currentIndex, compact = false }: { currentIndex: number; compact?: boolean }) {
  if (compact) {
    return (
      <div aria-label={`인터뷰 조율 진행 상태. ${currentIndex + 1}단계 ${actionJourneySteps[currentIndex] ?? "확인 필요"}`} className="grid gap-2">
        <ol className="flex items-center gap-1.5" aria-label="인터뷰 조율 5단계">
          {actionJourneySteps.map((step, index) => {
            const isComplete = index < currentIndex;
            const isCurrent = index === currentIndex;
            return (
              <li className="flex items-center gap-1.5" key={step}>
                <span aria-current={isCurrent ? "step" : undefined} className={`grid size-7 place-items-center rounded-full text-xs font-bold ${isComplete ? "bg-emerald-600 text-white" : isCurrent ? "bg-blue-600 text-white ring-4 ring-blue-100" : "bg-slate-100 text-slate-500"}`}>
                  {isComplete ? <CheckCircle2 className="size-4" /> : index + 1}
                </span>
                {index < actionJourneySteps.length - 1 ? <span className={`h-px w-5 ${isComplete ? "bg-emerald-400" : "bg-slate-200"}`} /> : null}
              </li>
            );
          })}
        </ol>
        <p className="text-sm font-medium text-slate-600"><span className="font-semibold text-slate-900">현재 단계.</span> {currentIndex + 1}. {actionJourneySteps[currentIndex] ?? "확인 필요"}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-1">
      <ol aria-label="인터뷰 조율 진행 상태" className="grid min-w-[34rem] grid-cols-5">
        {actionJourneySteps.map((step, index) => {
          const isComplete = index < currentIndex;
          const isCurrent = index === currentIndex;
          return (
            <li className="relative grid justify-items-center gap-2 text-center" key={step}>
              {index < actionJourneySteps.length - 1 ? <span className={`absolute left-[calc(50%+1.25rem)] top-5 h-px w-[calc(100%-2.5rem)] ${isComplete ? "bg-emerald-400" : "bg-slate-200"}`} /> : null}
              <span aria-current={isCurrent ? "step" : undefined} className={`relative z-10 grid size-10 place-items-center rounded-full text-sm font-bold ${isComplete ? "bg-emerald-600 text-white" : isCurrent ? "bg-blue-600 text-white ring-4 ring-blue-100" : "bg-slate-100 text-slate-500"}`}>
                {isComplete ? <CheckCircle2 className="size-5" /> : index + 1}
              </span>
              <span className={`whitespace-nowrap text-sm font-semibold ${isCurrent ? "text-slate-950" : isComplete ? "text-emerald-700" : "text-slate-500"}`}>{step}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

type OperationalReadinessPayload = {
  readiness: {
    overallStatus: string;
    checks: Record<string, Record<string, unknown>>;
    externalChecks: { performed: boolean; checks: Record<string, Record<string, unknown>> };
  };
  retryJobs: Array<{
    id: string;
    jobType: string;
    status: string;
    attemptCount: number;
    lastError: string | null;
  }>;
};

function OperationsReadinessCard() {
  const [data, setData] = useState<OperationalReadinessPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (external: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/operations/readiness?external=${external}`);
      const result = await response.json() as OperationalReadinessPayload & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "운영 상태를 확인하지 못했습니다.");
      setData(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "운영 상태를 확인하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const openDaouLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/operations/daou-login", { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "다우오피스 로그인 창을 열지 못했습니다.");
      await load(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "다우오피스 로그인 창을 열지 못했습니다.");
      setLoading(false);
    }
  };

  useEffect(() => { void load(false); }, []);
  const daou = data?.readiness.checks.daouOfficeBrowser;
  const daouConnected = daou?.connected === true;
  const retries = data?.retryJobs ?? [];

  return (
    <Card className="mt-6">
      <CardHeader className="flex-row items-start justify-between gap-4 border-b border-slate-200">
        <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">INTEGRATION HEALTH</p><CardTitle className="mt-2">연동 상태와 복구</CardTitle><CardDescription className="mt-2">자동 재시도는 워커가 처리합니다. 여기서는 현재 상태를 확인하고 다우오피스 로그인을 다시 열 수 있습니다.</CardDescription></div>
        <Badge variant={data?.readiness.overallStatus === "READY" ? "success" : "warning"}>{data?.readiness.overallStatus ?? "확인 중"}</Badge>
      </CardHeader>
      <CardContent className="grid gap-5 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-start">
        <div className="rounded-xl border border-slate-200 p-4"><p className="text-sm font-medium text-slate-500">다우오피스 전용 브라우저</p><p className="mt-2 text-lg font-semibold text-slate-950">{daouConnected ? "연결됨" : "로그인 또는 연결 확인 필요"}</p><p className="mt-2 text-sm leading-6 text-slate-600">{daou?.latestMeetingRoomSyncAt ? `마지막 회의실 동기화. ${formatDateTime(String(daou.latestMeetingRoomSyncAt))}` : "회의실을 추천하기 전 해당 후보자 기준으로 동기화합니다."}</p></div>
        <div className="rounded-xl border border-slate-200 p-4"><p className="text-sm font-medium text-slate-500">연동 재시도 대기열</p><p className="mt-2 text-lg font-semibold text-slate-950">{retries.length}건</p><p className="mt-2 text-sm leading-6 text-slate-600">{retries.length > 0 ? retries.slice(0, 2).map((job) => `${job.jobType} · ${job.status}`).join("\n") : "대기 중인 연동 재시도가 없습니다."}</p></div>
        <div className="flex flex-wrap gap-2 lg:justify-end"><Button disabled={loading} onClick={() => void load(true)} variant="outline">{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}연결 다시 진단</Button>{!daouConnected ? <Button disabled={loading} onClick={() => void openDaouLogin()} variant="outline">다우오피스 로그인</Button> : null}</div>
        {error ? <p className="lg:col-span-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

function ActionRow({ item, onCreateReviewDecision, onCreateCaseDecision, onOpenDecision, loading }: {
  item: ActionItem;
  onCreateReviewDecision: (review: Review) => void;
  onCreateCaseDecision: (caseId: string, skillKey: "AVAILABILITY_COLLECTION" | "INTERVIEW_SCHEDULING" | "CANDIDATE_SCHEDULE_PROPOSAL") => void;
  onOpenDecision: (decision: Decision) => void;
  loading: boolean;
}) {
  const directDecision = item.decision;
  const review = item.review;
  const actionableReview = Boolean(review && supportedReviewDecisionTypes.has(review.reviewType));
  const priority = priorityStyle(item.priority);

  return (
    <article className="grid gap-5 px-6 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-7">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`size-2 rounded-full ${priority.dot}`} />
          <Badge variant={priority.badge}>{priority.label}</Badge>
          <span className="text-sm text-slate-500">{item.category}</span>
          {item.meta ? <span className="text-sm text-slate-500">· {item.meta}</span> : null}
        </div>
        <h3 className="mt-3 text-xl font-semibold tracking-[-0.025em] text-slate-950">{item.candidateName ?? "후보자 확인 필요"}</h3>
        <p className="mt-1 text-base text-slate-600">{item.recruitmentName ?? "채용 정보 확인 필요"}</p>
        <div className="mt-4 border-y border-slate-100 py-4"><ActionJourney compact currentIndex={item.journeyIndex} /></div>
        <p className="mt-4 text-base font-medium leading-6 text-slate-800">{item.title}</p>
        <p className="mt-1 text-sm leading-6 text-slate-600">{item.description}</p>
        {item.relatedItems?.length ? (
          <details className="mt-4 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
            <summary className="cursor-pointer list-none text-sm font-semibold text-slate-700">추가 검토 {item.relatedItems.length}건</summary>
            <div className="mt-2 grid gap-2 border-t border-slate-200 pt-2">
              {item.relatedItems.map((related) => {
                const relatedReview = related.review;
                const relatedDecision = related.decision;
                const relatedActionableReview = Boolean(relatedReview && supportedReviewDecisionTypes.has(relatedReview.reviewType));
                return (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white px-3 py-2" key={related.id}>
                    <div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">{related.title}</p><p className="mt-0.5 text-xs text-slate-500">{related.category}</p></div>
                    {relatedDecision ? <Button onClick={() => onOpenDecision(relatedDecision)} size="sm" variant="decision">결정 계속하기</Button> : null}
                    {!relatedDecision && relatedActionableReview && relatedReview ? <Button disabled={loading} onClick={() => onCreateReviewDecision(relatedReview)} size="sm" variant="outline">검토하기</Button> : null}
                    {!relatedDecision && !relatedActionableReview && related.caseSkillKey && related.caseId ? <Button disabled={loading} onClick={() => onCreateCaseDecision(related.caseId!, related.caseSkillKey!)} size="sm">결정하기</Button> : null}
                    {!relatedDecision && !relatedActionableReview && !related.caseSkillKey && related.href ? <Button asChild size="sm" variant="outline"><Link href={related.href}>상세 보기<ArrowRight className="size-3.5" /></Link></Button> : null}
                  </div>
                );
              })}
            </div>
          </details>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center sm:justify-end">
        {directDecision ? <Button variant="decision" onClick={() => onOpenDecision(directDecision)}>결정 계속하기</Button> : null}
        {!directDecision && actionableReview && review ? (
          <Button disabled={loading} onClick={() => onCreateReviewDecision(review)} variant="outline">{loading ? <Loader2 className="size-4 animate-spin" /> : null}{item.actionLabel}</Button>
        ) : null}
        {!directDecision && !actionableReview && item.caseSkillKey && item.caseId ? (
          <Button disabled={loading} onClick={() => onCreateCaseDecision(item.caseId!, item.caseSkillKey!)}>{loading ? <Loader2 className="size-4 animate-spin" /> : null}{item.actionLabel}</Button>
        ) : null}
        {!directDecision && !actionableReview && !item.caseSkillKey && item.href && item.actionLabel ? <Button asChild variant="outline"><Link href={item.href}>{item.actionLabel}<ArrowRight className="size-4" /></Link></Button> : null}
      </div>
    </article>
  );
}

function HeldWorkCard({ work, loading, onResume }: {
  work: HeldWork;
  loading: boolean;
  onResume: (work: HeldWork) => void;
}) {
  return (
    <article className="border-b border-slate-200 py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-slate-950">{work.candidateName ?? "후보자 확인 필요"}</p>
          <p className="mt-1 text-sm text-slate-600">{work.recruitmentName ?? "채용 정보 확인 필요"}</p>
        </div>
        <Badge variant="secondary">보류</Badge>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-600">{work.detail}</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">{formatDateTime(work.heldAt)} 보류</p>
        <Button disabled={loading} onClick={() => onResume(work)} size="sm" variant="outline">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
          보류 해제
        </Button>
      </div>
    </article>
  );
}

const queueTabs: Array<{ id: "ACTION" | "WAITING" | "EXCEPTION" | "ALL"; label: string }> = [
  { id: "ACTION", label: "내가 처리할 일" },
  { id: "WAITING", label: "응답 대기" },
  { id: "EXCEPTION", label: "예외·오류" },
  { id: "ALL", label: "전체" },
];

export function DashboardClient({ initialData }: { initialData: DashboardSnapshot }) {
  const [data, setData] = useState(initialData);
  const [activeDecision, setActiveDecision] = useState<ActiveDecision | null>(null);
  const [templatePreview, setTemplatePreview] = useState<{ preview: RecruitmentTemplatePreview["preview"]; reviewId: string | null } | null>(null);
  const [interviewerMapping, setInterviewerMapping] = useState<InterviewerSlackMappingRequest | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueTab, setQueueTab] = useState<"ACTION" | "WAITING" | "EXCEPTION" | "ALL">("ACTION");
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok) throw new Error("운영 현황을 새로 불러오지 못했습니다.");
    setData(await response.json() as DashboardSnapshot);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => void refresh().catch(() => undefined), 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const createReviewDecision = async (review: Review) => {
    setLoadingId(`review:${review.id}`);
    setError(null);
    try {
      const response = await fetch(`/api/reviews/${review.id}/decision`, { method: "POST" });
      const result = await response.json() as { decision?: Decision; dismissOnClose?: boolean; error?: string };
      if (!response.ok || !result.decision) throw new Error(result.error ?? "결정문을 만들지 못했습니다.");
      setActiveDecision({ decision: result.decision, dismissOnClose: result.dismissOnClose === true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "결정문을 만들지 못했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  const createCaseDecision = async (
    caseId: string,
    skillKey: "AVAILABILITY_COLLECTION" | "INTERVIEW_SCHEDULING" | "CANDIDATE_SCHEDULE_PROPOSAL",
  ) => {
    setLoadingId(`case:${caseId}`);
    setError(null);
    try {
      const response = await fetch(`/api/cases/${caseId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillKey }),
      });
      const result = await response.json() as { decision?: Decision; dismissOnClose?: boolean; error?: string };
      if (!response.ok || !result.decision) throw new Error(result.error ?? "선택지를 만들지 못했습니다.");
      setActiveDecision({ decision: result.decision, dismissOnClose: result.dismissOnClose === true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "선택지를 만들지 못했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  const resolveDecision = async (optionId: string) => {
    if (!activeDecision) return;
    const decision = activeDecision.decision;
    setLoadingId(decision.id);
    setError(null);
    try {
      const response = await fetch(`/api/decisions/${decision.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId }),
      });
      const result = await response.json() as { error?: string; followUp?: unknown };
      if (!response.ok) throw new Error(result.error ?? "결정문을 처리하지 못했습니다.");
      if (
        result.followUp
        && typeof result.followUp === "object"
        && "id" in result.followUp
        && "options" in result.followUp
        && Array.isArray((result.followUp as { options?: unknown }).options)
      ) {
        setActiveDecision({ decision: result.followUp as Decision, dismissOnClose: false });
      } else if (
        result.followUp
        && typeof result.followUp === "object"
        && "kind" in result.followUp
        && (result.followUp as { kind?: unknown }).kind === "RECRUITMENT_TEMPLATE_PREVIEW"
        && "preview" in result.followUp
      ) {
        setActiveDecision(null);
        setTemplatePreview({
          preview: (result.followUp as RecruitmentTemplatePreview).preview,
          reviewId: decision.reviewId,
        });
      } else if (
        result.followUp
        && typeof result.followUp === "object"
        && "kind" in result.followUp
        && (result.followUp as { kind?: unknown }).kind === "INTERVIEWER_SLACK_MAPPING"
      ) {
        setActiveDecision(null);
        setInterviewerMapping(result.followUp as InterviewerSlackMappingRequest);
      } else {
        setActiveDecision(null);
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "결정문을 처리하지 못했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  const saveRecruitmentTemplate = async (
    steps: Array<{ stepId: string; mode: "STANDARD" | "COMBINED"; durationMinutes: number }>,
  ) => {
    if (!templatePreview) return;
    const loadingKey = `template:${templatePreview.preview.recruitmentId}`;
    setLoadingId(loadingKey);
    setError(null);
    try {
      const response = await fetch("/api/recruitment-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recruitmentId: templatePreview.preview.recruitmentId,
          reviewId: templatePreview.reviewId,
          steps,
        }),
      });
      const result = await response.json() as { decision?: Decision; error?: string };
      if (!response.ok) throw new Error(result.error ?? "인터뷰 규칙을 저장하지 못했습니다.");
      setTemplatePreview(null);
      if (result.decision) {
        setActiveDecision({ decision: result.decision, dismissOnClose: false });
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "인터뷰 규칙을 저장하지 못했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  const closeDecision = async () => {
    if (!activeDecision) return;
    const decision = activeDecision.decision;
    const dismissOnClose = activeDecision.dismissOnClose;
    setActiveDecision(null);
    if (!dismissOnClose) return;
    try {
      const response = await fetch(`/api/decisions/${decision.id}/dismiss`, { method: "DELETE" });
      const result = await response.json() as { dismissed?: boolean; error?: string };
      if (!response.ok || !result.dismissed) throw new Error(result.error ?? "선택지를 닫지 못했습니다.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "선택지를 닫지 못했습니다.");
    }
  };

  const resumeHeldWork = async (work: HeldWork) => {
    const loadingKey = `hold:${work.kind}:${work.id}`;
    setLoadingId(loadingKey);
    setError(null);
    try {
      const resource = work.kind === "REVIEW" ? "reviews" : "cases";
      const response = await fetch(`/api/holds/${resource}/${work.id}/resume`, { method: "POST" });
      const result = await response.json() as { decision?: Decision; error?: string };
      if (!response.ok) throw new Error(result.error ?? "보류한 조율을 다시 시작하지 못했습니다.");
      if (result.decision) {
        setActiveDecision({ decision: result.decision, dismissOnClose: false });
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "보류한 조율을 다시 시작하지 못했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  const actionItems = useMemo(() => buildActionItems(data), [data]);
  const queueCounts = useMemo(() => ({
    ACTION: actionItems.filter((item) => item.queue === "ACTION").length,
    WAITING: actionItems.filter((item) => item.queue === "WAITING").length,
    EXCEPTION: actionItems.filter((item) => item.queue === "EXCEPTION").length,
    ALL: actionItems.length,
  }), [actionItems]);
  const filteredActionItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return actionItems.filter((item) => {
      const matchesTab = queueTab === "ALL" || item.queue === queueTab;
      if (!matchesTab) return false;
      if (!normalizedQuery) return true;
      const haystack = [item.candidateName, item.recruitmentName, item.title, item.description, item.category, item.meta]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [actionItems, query, queueTab]);
  const pageCount = Math.max(1, Math.ceil(filteredActionItems.length / pageSize));
  const visibleActionItems = useMemo(() => filteredActionItems.slice((page - 1) * pageSize, page * pageSize), [filteredActionItems, page, pageSize]);
  useEffect(() => {
    setPage(1);
  }, [pageSize, query, queueTab]);
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);
  const upcoming = useMemo(() => data.dashboard.cases
    .filter((interviewCase) => interviewCase.scheduledDate && interviewCase.scheduledStartTime && ["CONFIRMED", "AWAITING_CANDIDATE_CONFIRMATION"].includes(interviewCase.status))
    .sort((left, right) => `${left.scheduledDate}T${left.scheduledStartTime}`.localeCompare(`${right.scheduledDate}T${right.scheduledStartTime}`))
    .slice(0, 5), [data.dashboard.cases]);
  const summary = data.dashboard.summary;
  const progress = [
    { label: "조율 시작", statuses: ["READY_FOR_DRAFT", "DRAFT_CREATED"] },
    { label: "면접관 일정", statuses: ["REQUEST_SENT", "COLLECTING_AVAILABILITY"] },
    { label: "시간·회의실", statuses: ["READY_TO_SCHEDULE", "REVIEW_REQUIRED"] },
    { label: "후보자 응답", statuses: ["AWAITING_CANDIDATE_CONFIRMATION"] },
  ].map((item) => ({ ...item, count: item.statuses.reduce((total, status) => total + summary.caseCountsByStatus[status as InterviewCaseStatus], 0) }));
  const activeReview = activeDecision
    ? data.reviews.find((review) => review.id === activeDecision.decision.reviewId)
    : undefined;

  return (
    <div className="min-h-screen bg-slate-50">
      <AppHeader active="operations" workerStatus={summary.worker.status} />
      <main className="mx-auto max-w-[1440px] px-5 pb-12 sm:px-8">
        <PageHeader
          actions={<Button variant="outline" onClick={() => void refresh().catch((caught) => setError(caught.message))}><RefreshCw className="size-4" />새로고침</Button>}
          description="판단하거나 처리해야 하는 인터뷰 업무부터 확인하고, 확정된 일정과 운영 상태를 함께 살펴보세요."
          eyebrow="INTERVIEW OPERATIONS"
          title="오늘의 인터뷰 운영"
        />

        {error ? <div className="mb-6 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800"><AlertCircle className="size-4" />{error}</div> : null}

        <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="운영 요약">
          <button className={`rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md ${queueTab === "ACTION" ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200"}`} onClick={() => setQueueTab("ACTION")} type="button">
            <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-slate-600">내 결정 필요</span><ClipboardList className="size-5 text-blue-600" /></div>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{queueCounts.ACTION}</p>
            <p className="mt-1 text-xs text-slate-500">승인하거나 다음 단계로 넘길 후보자</p>
          </button>
          <button className={`rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md ${queueTab === "WAITING" ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200"}`} onClick={() => setQueueTab("WAITING")} type="button">
            <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-slate-600">응답 대기</span><Clock3 className="size-5 text-amber-600" /></div>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{queueCounts.WAITING}</p>
            <p className="mt-1 text-xs text-slate-500">면접관·후보자 회신을 기다리는 건</p>
          </button>
          <button className={`rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md ${queueTab === "EXCEPTION" ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200"}`} onClick={() => setQueueTab("EXCEPTION")} type="button">
            <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-slate-600">예외·오류</span><TriangleAlert className="size-5 text-rose-600" /></div>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{queueCounts.EXCEPTION}</p>
            <p className="mt-1 text-xs text-slate-500">재조율 확인 필요 · 연동 재시도 {summary.pendingIntegrationRetries + summary.failedIntegrationRetries}건</p>
          </button>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-slate-600">다가오는 인터뷰</span><CalendarClock className="size-5 text-emerald-600" /></div>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{data.dashboard.cases.filter((interviewCase) => interviewCase.scheduledDate && ["CONFIRMED", "AWAITING_CANDIDATE_CONFIRMATION"].includes(interviewCase.status)).length}</p>
            <p className="mt-1 text-xs text-slate-500">확정 또는 후보자 응답 대기</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-slate-600">워커 상태</span><Wifi className="size-5 text-slate-500" /></div>
            <p className="mt-2 text-lg font-semibold tracking-tight text-slate-950">{summary.worker.status === "RUNNING" ? "정상 작동" : summary.worker.status}</p>
            <p className="mt-1 text-xs text-slate-500">마지막 갱신 {formatGeneratedAt(data.dashboard.generatedAt)}</p>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="overflow-hidden">
            <CardHeader className="flex-row items-start justify-between gap-4 border-b border-slate-200 p-6 sm:p-7">
              <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">PRIORITY QUEUE</p><CardTitle className="mt-2 flex items-center gap-2 text-2xl">인터뷰 운영 큐 <Badge>{filteredActionItems.length}</Badge></CardTitle><CardDescription className="mt-2">한 화면에서는 지금 확인할 후보자만 보여주고, 나머지는 페이지로 나눠 관리합니다.</CardDescription></div>
              <div className="flex shrink-0 items-center gap-2"><label className="sr-only" htmlFor="action-page-size">페이지 표시 수</label><select aria-label="페이지 표시 수" className="h-10 rounded-lg border border-slate-200 bg-white px-2 text-sm font-medium text-slate-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" id="action-page-size" onChange={(event) => setPageSize(Number(event.target.value))} value={pageSize}><option value="10">10건</option><option value="25">25건</option><option value="50">50건</option></select></div>
            </CardHeader>
            <div className="border-b border-slate-200 px-6 py-4 sm:px-7">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-wrap gap-2" role="tablist" aria-label="운영 큐 필터">
                  {queueTabs.map((tab) => <button aria-selected={queueTab === tab.id} className={`rounded-full px-3 py-2 text-sm font-semibold transition-colors ${queueTab === tab.id ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`} key={tab.id} onClick={() => setQueueTab(tab.id)} role="tab" type="button">{tab.label} <span className="ml-1 opacity-75">{queueCounts[tab.id]}</span></button>)}
                </div>
                <label className="relative block w-full lg:max-w-xs"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><span className="sr-only">후보자 또는 채용 검색</span><input className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100" onChange={(event) => setQuery(event.target.value)} placeholder="후보자·채용·업무 검색" type="search" value={query} /></label>
              </div>
            </div>
            {filteredActionItems.length === 0 ? (
              <CardContent className="grid min-h-64 place-items-center p-8 text-center"><div><CheckCircle2 className="mx-auto size-8 text-emerald-600" /><p className="mt-4 text-lg font-semibold">이 조건에 맞는 업무가 없습니다.</p><p className="mt-2 text-base text-slate-600">다른 큐를 선택하거나 검색어를 지워 보세요.</p></div></CardContent>
            ) : <>
              <div className="divide-y divide-slate-200">{visibleActionItems.map((item) => <ActionRow key={item.id} item={item} loading={loadingId === item.id} onCreateCaseDecision={createCaseDecision} onCreateReviewDecision={createReviewDecision} onOpenDecision={(decision) => setActiveDecision({ decision, dismissOnClose: false })} />)}</div>
              <div className="flex flex-col gap-3 border-t border-slate-200 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7"><p className="text-sm text-slate-500">전체 {filteredActionItems.length}건 중 {Math.min((page - 1) * pageSize + 1, filteredActionItems.length)}–{Math.min(page * pageSize, filteredActionItems.length)}건</p><div className="flex items-center gap-2"><Button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} size="sm" variant="outline">이전</Button><span className="min-w-16 text-center text-sm font-semibold text-slate-700">{page} / {pageCount}</span><Button disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} size="sm" variant="outline">다음</Button></div></div>
            </>}
          </Card>

          <aside className="grid h-fit gap-6 sm:grid-cols-2 xl:grid-cols-1">
            {data.heldWork.length > 0 ? <Card>
              <CardHeader><p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">PAUSED</p><CardTitle className="mt-2 flex items-center gap-2">보류한 조율 <Badge variant="secondary">{data.heldWork.length}</Badge></CardTitle><CardDescription>나인하이어와 Slack에는 변경하지 않고 로컬 조율만 멈춘 상태입니다.</CardDescription></CardHeader>
              <CardContent><div className="max-h-96 overflow-y-auto pr-1">{data.heldWork.map((work) => <HeldWorkCard key={`${work.kind}:${work.id}`} loading={loadingId === `hold:${work.kind}:${work.id}`} onResume={resumeHeldWork} work={work} />)}</div></CardContent>
            </Card> : null}

            <Card>
              <CardHeader><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">UP NEXT</p><CardTitle className="mt-2">다가오는 인터뷰</CardTitle></CardHeader>
              <CardContent>
                {upcoming.length === 0 ? <p className="text-base leading-7 text-slate-600">기록된 일정 인터뷰가 없습니다.</p> : <div className="divide-y divide-slate-200">{upcoming.map((interviewCase) => (
                  <Link className="block py-4 first:pt-0 transition-colors hover:text-blue-700" href={`/cases/${interviewCase.id}`} key={interviewCase.id}>
                    <p className="text-sm font-semibold text-blue-700">{formatDate(interviewCase.scheduledDate)}</p>
                    <p className="mt-1 text-lg font-semibold text-slate-950">{interviewCase.candidateName ?? "후보자 확인 필요"}</p>
                    <p className="mt-1 text-sm leading-6 text-slate-600">{formatSchedule(interviewCase)}</p>
                  </Link>
                ))}</div>}
                <Button asChild className="mt-5 w-full" variant="outline"><Link href="/rooms"><CalendarClock className="size-4" />회의실 시간표 보기</Link></Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">PIPELINE</p><CardTitle className="mt-2">진행 중 조율</CardTitle></CardHeader>
              <CardContent><div className="divide-y divide-slate-200">{progress.map((item) => <div className="flex items-center justify-between py-3 first:pt-0" key={item.label}><span className="text-base text-slate-600">{item.label}</span><strong className="text-lg font-semibold text-slate-950">{item.count}</strong></div>)}</div><div className="mt-3 flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-3"><span className="text-base font-medium text-emerald-800">최종 확정</span><strong className="text-lg font-semibold text-emerald-700">{summary.caseCountsByStatus.CONFIRMED}</strong></div></CardContent>
            </Card>
          </aside>
        </div>

        <section className="mt-6 grid gap-4 md:grid-cols-3" aria-label="운영 상태">
          <Card><CardContent className="flex items-start gap-4 p-5"><span className="grid size-10 place-items-center rounded-lg bg-amber-50 text-amber-700"><UsersRound className="size-5" /></span><div><p className="text-sm font-medium text-slate-600">면접관 미응답</p><p className="mt-1 text-2xl font-semibold tracking-tight">{summary.pendingRequiredInterviewerResponses}</p><p className="mt-1 text-sm leading-5 text-slate-500">제출 확인이 필요한 필수 면접관입니다.</p></div></CardContent></Card>
          <Card><CardContent className="flex items-start gap-4 p-5"><span className="grid size-10 place-items-center rounded-lg bg-rose-50 text-rose-700"><Wifi className="size-5" /></span><div><p className="text-sm font-medium text-slate-600">연동 재시도</p><p className="mt-1 text-2xl font-semibold tracking-tight">{summary.pendingIntegrationRetries + summary.failedIntegrationRetries}</p><p className="mt-1 text-sm leading-5 text-slate-500">Slack·나인하이어 동기화 오류를 확인합니다.</p></div></CardContent></Card>
          <Card><CardContent className="flex items-start gap-4 p-5"><span className="grid size-10 place-items-center rounded-lg bg-blue-50 text-blue-700"><ClipboardList className="size-5" /></span><div><p className="text-sm font-medium text-slate-600">데이터 갱신</p><p className="mt-1 text-2xl font-semibold tracking-tight">{formatGeneratedAt(data.dashboard.generatedAt)}</p><p className="mt-1 text-sm leading-5 text-slate-500">30초마다 로컬 상태를 다시 확인합니다.</p></div></CardContent></Card>
        </section>
        <OperationsReadinessCard />
      </main>

      {activeDecision ? <DecisionModal activeDecision={activeDecision} evaluationSummary={activeReview?.evaluationSummary} loading={loadingId === activeDecision.decision.id} onClose={() => void closeDecision()} onResolve={resolveDecision} /> : null}
      {templatePreview ? <TemplatePreviewDialog
        error={error}
        loading={loadingId === `template:${templatePreview.preview.recruitmentId}`}
        onClose={() => setTemplatePreview(null)}
        onSave={(steps) => void saveRecruitmentTemplate(steps)}
        preview={templatePreview.preview}
      /> : null}
      {interviewerMapping ? <InterviewerSlackMappingDialog
        onClose={() => setInterviewerMapping(null)}
        onFinished={async () => {
          setInterviewerMapping(null);
          await refresh();
        }}
        request={interviewerMapping}
      /> : null}
    </div>
  );
}
