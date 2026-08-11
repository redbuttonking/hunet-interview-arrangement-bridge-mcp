"use client";
// 인터뷰 운영자가 우선순위 업무와 다음 일정을 같은 기준으로 처리하게 한다.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, ArrowRight, CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, ClipboardList, Clock3, Loader2, RefreshCw, Search, SearchX, TriangleAlert, UsersRound, Wifi } from "lucide-react";
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

type UpcomingInterview = {
  id: string;
  candidateName: string | null;
  recruitmentName: string | null;
  date: string;
  startTime: string;
  endTime: string;
  href: string | null;
  source: "LOCAL" | "DAOU_OFFICE_CALENDAR";
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

function integrationRetryReason(reason: string) {
  const normalized = reason.toLocaleLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out")) return "외부 서비스 응답이 시간 안에 오지 않았습니다.";
  if (normalized.includes("auth") || normalized.includes("token") || normalized.includes("unauthorized")) return "외부 서비스 인증을 확인해야 합니다.";
  if (normalized.includes("rate") || normalized.includes("limit")) return "외부 서비스의 요청 한도에 도달했습니다.";
  return "외부 연동 작업이 자동 재시도 한도를 초과했습니다.";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "일정 미정";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()
  ];
  return `${Number(month)}. ${Number(day)}. (${weekday})`;
}

function formatGeneratedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시각 미확인";
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const hour24 = shifted.getUTCHours();
  const period = hour24 >= 12 ? "오후" : "오전";
  const hour = hour24 % 12 || 12;
  return `${period} ${hour}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

function formatDateTime(value: string | undefined) {
  if (!value) return "완료 시각 미확인";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const hour24 = shifted.getUTCHours();
  const period = hour24 >= 12 ? "오후" : "오전";
  const hour = hour24 % 12 || 12;
  return `${shifted.getUTCMonth() + 1}. ${shifted.getUTCDate()}. ${period} ${hour}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

function todayInSeoulDate() {
  const shifted = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

async function readApiJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (!contentType.toLocaleLowerCase().includes("application/json")) {
    throw new Error(response.ok
      ? fallbackMessage
      : `서버가 오류 페이지를 반환했습니다. 대시보드를 새로고침한 뒤 다시 시도해 주세요. (${response.status})`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(fallbackMessage);
  }
}

function isDecision(value: unknown): value is Decision {
  return Boolean(
    value
    && typeof value === "object"
    && "id" in value
    && "options" in value
    && Array.isArray((value as { options?: unknown }).options),
  );
}

function formatSchedule(interviewCase: CandidateCase) {
  if (!interviewCase.scheduledDate || !interviewCase.scheduledStartTime) return "일정 미정";
  const room = interviewCase.scheduledRoomName ? ` · ${interviewCase.scheduledRoomName}` : "";
  return `${formatDate(interviewCase.scheduledDate)} ${interviewCase.scheduledStartTime}–${interviewCase.scheduledEndTime ?? ""}${room}`;
}

function UpcomingInterviewItem({ interview }: { interview: UpcomingInterview }) {
  const content = <>
    <p className="text-sm font-semibold text-blue-700">{formatDate(interview.date)}</p>
    <p className="mt-1 text-lg font-semibold text-slate-950">{interview.candidateName ?? "후보자 확인 필요"}</p>
    <p className="mt-1 truncate text-sm text-slate-600">{interview.recruitmentName ?? "채용 정보 확인 필요"}</p>
    <p className="mt-1 text-sm leading-6 text-slate-600">{interview.startTime}–{interview.endTime} · {interview.source === "DAOU_OFFICE_CALENDAR" ? "다우오피스 캘린더 확정" : "조율 기록"}</p>
  </>;
  return interview.href ? (
    <Link className="block py-4 first:pt-0 transition-colors hover:text-blue-700" href={interview.href}>
      {content}
    </Link>
  ) : (
    <div className="py-4 first:pt-0">{content}</div>
  );
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
    INTEGRATION_RETRY_EXHAUSTED: "연동 재시도 소진",
  };
  return labels[review.reviewType] ?? "운영 확인";
}

function reviewActionLabel(review: Review) {
  if (review.reviewType === "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED") {
    return "복구 확인";
  }
  if (review.reviewType === "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED") {
    return "응답 조치 선택";
  }
  if (
    [
      "RECRUITMENT_TEMPLATE_UPDATE_REQUIRED",
      "RECRUITMENT_TEMPLATE_CHECK_REQUIRED",
    ].includes(review.reviewType)
  ) {
    return "규칙 확인";
  }
  if (review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED") {
    return "조율 시작 검토";
  }
  return "검토하기";
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
    caseId: decision.caseId ?? undefined,
    meta: "선택 적용 전에는 인터뷰 상태가 바뀌지 않습니다.",
    actionLabel: "결정 계속하기",
    href: decision.caseId ? `/cases/${decision.caseId}` : null,
    decision,
  }));
  const reviewItems: ActionItem[] = data.reviews
    .filter((review) => !reviewIdsWithDecision.has(review.id))
    .map((review) => {
      const integrationRetryExhausted = review.reviewType === "INTEGRATION_RETRY_EXHAUSTED";
      return {
        id: `review:${review.id}`,
        queue: review.reviewType === "WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED" || integrationRetryExhausted || !supportedReviewDecisionTypes.has(review.reviewType) ? "EXCEPTION" : "ACTION",
        priority: supportedReviewDecisionTypes.has(review.reviewType) || integrationRetryExhausted ? "urgent" : "normal",
        journeyIndex: review.caseId && casesById.get(review.caseId)
          ? journeyIndexForStatus(casesById.get(review.caseId)!.status)
          : journeyIndexForReview(review),
        category: reviewCategory(review),
        title: integrationRetryExhausted
          ? "자동 재시도가 끝난 연동 오류를 확인해 주세요."
          : review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED"
            ? "인터뷰 조율을 시작할지 확인해 주세요."
            : review.reviewType === "CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED"
              ? "후보자 응답에 대한 처리 방법을 선택해 주세요."
              : review.reason,
        description: integrationRetryExhausted
          ? integrationRetryReason(review.reason)
          : review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED"
            ? `${review.currentStepName ?? "평가 완료"} · ${review.reason}`
            : review.currentStepName ?? "상세 내용을 확인해 주세요.",
        candidateName: review.candidateName,
        recruitmentName: review.recruitmentName,
        caseId: review.caseId ?? undefined,
        meta: integrationRetryExhausted
          ? "재동기화 전 워커와 연동 상태를 확인하세요. 이 화면에서는 외부 발송이나 자동 재시도를 실행하지 않습니다."
          : review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED" ? "승인 전에는 나인하이어·Slack에 변경이 없습니다." : null,
        actionLabel: integrationRetryExhausted
          ? "연동 상태 확인"
          : supportedReviewDecisionTypes.has(review.reviewType)
            ? reviewActionLabel(review)
            : review.caseId ? "상세 보기" : null,
        href: review.caseId ? `/cases/${review.caseId}` : integrationRetryExhausted ? "#integration-health" : null,
        review,
      };
    });
  const caseIdsWithException = new Set(
    reviewItems
      .filter((item) => item.queue === "EXCEPTION" && item.caseId)
      .map((item) => item.caseId!),
  );
  const cancellationItems: ActionItem[] = data.dashboard.cases.flatMap((interviewCase) => {
    const pending = interviewCase.cancellationExternalFollowUps.filter(
      (followUp) => followUp.status === "PENDING" && followUp.followUpType === "NINEHIRE_CANDIDATE_SCHEDULE",
    );
    if (pending.length === 0) return [];
    return [{
      id: `cancellation-follow-up:${interviewCase.id}`,
      queue: "EXCEPTION" as const,
      priority: "urgent" as const,
      journeyIndex: journeyIndexForStatus(interviewCase.status),
      category: "취소 반영 확인",
      title: "나인하이어의 후보자 일정 취소 반영을 확인해 주세요.",
      description: `${interviewCase.candidateName ?? "후보자 미확인"} · 기존 회의실 예약은 유지합니다.`,
      candidateName: interviewCase.candidateName,
      recruitmentName: interviewCase.recruitmentName,
      meta: "나인하이어에서 취소 상태를 확인한 뒤 이 항목을 정리할 수 있습니다.",
      actionLabel: "상세 보기",
      href: `/cases/${interviewCase.id}`,
      caseId: interviewCase.id,
    }];
  });
  const caseItems = data.dashboard.cases
    .filter((interviewCase) => !caseIdsWithDecision.has(interviewCase.id) && !caseIdsWithException.has(interviewCase.id))
    .map(caseAction)
    .filter((item): item is ActionItem => Boolean(item));

  return groupActionItems([...decisionItems, ...reviewItems, ...cancellationItems, ...caseItems]
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

function allQueueGroupKey(item: ActionItem) {
  if (item.caseId) return `case:${item.caseId}`;
  if (item.candidateName && item.recruitmentName) return `candidate:${item.candidateName}:${item.recruitmentName}`;
  return item.id;
}

function allQueueItemPriority(item: ActionItem) {
  if (item.id.startsWith("case:")) return 0;
  if (item.decision) return 1;
  if (item.review) return 2;
  return 3;
}

function groupAllQueueItems(items: ActionItem[]) {
  const groups = new Map<string, ActionItem>();
  for (const item of items) {
    const key = allQueueGroupKey(item);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...item, relatedItems: item.relatedItems ? [...item.relatedItems] : undefined });
      continue;
    }

    const itemIsPrimary = allQueueItemPriority(item) < allQueueItemPriority(current);
    const primary = itemIsPrimary ? item : current;
    const secondary = itemIsPrimary ? current : item;
    const relatedItems = [
      ...(primary.relatedItems ?? []),
      secondary,
      ...(secondary.relatedItems ?? []),
    ].filter((related, index, entries) => entries.findIndex((entry) => entry.id === related.id) === index);
    groups.set(key, { ...primary, relatedItems });
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
  const [selectedOptionId, setSelectedOptionId] = useState("");

  useEffect(() => {
    setSelectedOptionId("");
  }, [decision.id, decision.options]);

  return (
    <Dialog open onOpenChange={(open) => !open && !loading && onClose()}>
      <DialogContent className="max-w-4xl max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">선택 내용 확인</p>
          <DialogTitle>{decision.title}</DialogTitle>
          <DialogDescription>{decision.candidateName ?? "후보자"} · {decision.recruitmentName ?? "채용 정보 확인 필요"}</DialogDescription>
        </DialogHeader>
        <p className="text-base leading-7 text-slate-700">{decision.prompt}</p>
        {decision.decisionType === "START_INTERVIEW_ARRANGEMENT" || decision.decisionType === "SELECT_INTERVIEW_ROUTE" || decision.decisionType === "REVIEW_RECRUITMENT_TEMPLATE" ? <EvaluationSummaryPanel evaluation={evaluationSummary} /> : null}
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600">`선택 적용`을 누르기 전에는 인터뷰 상태나 외부 시스템이 변경되지 않습니다.</p>
        <fieldset className="grid gap-3" aria-label="결정 선택지">
          <legend className="text-sm font-semibold text-slate-900">처리 방법을 하나 선택해 주세요.</legend>
          {decision.options.map((option) => (
            <label key={option.id} className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors ${selectedOptionId === option.id ? "border-blue-500 bg-blue-50/70" : "border-slate-200 hover:border-slate-300"}`}>
              <input className="mt-1 size-4 accent-blue-600" type="radio" name="decision" value={option.id} checked={selectedOptionId === option.id} onChange={() => setSelectedOptionId(option.id)} />
              <span><strong className="block text-base text-slate-950">{option.label}</strong><small className="mt-1 block text-sm leading-6 text-slate-600">{option.description}</small></span>
            </label>
          ))}
        </fieldset>
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
      <DialogContent className="max-w-4xl">
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold tracking-wide text-slate-500">인터뷰 조율 진행</span>
          <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">{currentIndex + 1} / {actionJourneySteps.length} · {actionJourneySteps[currentIndex] ?? "확인 필요"}</span>
        </div>
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
        <p className="text-sm font-medium text-slate-600"><span className="font-semibold text-slate-900">현재 처리.</span> {actionJourneySteps[currentIndex] ?? "확인 필요"}</p>
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
    maxAttempts?: number;
    nextAttemptAt?: string;
    lastError: string | null;
  }>;
};

function retryJobTypeLabel(jobType: string) {
  const labels: Record<string, string> = {
    NINEHIRE_EVALUATION_LOOKUP: "나인하이어 평가표 조회",
    NINEHIRE_SCHEDULE_RECONCILIATION: "나인하이어 확정 일정 확인",
    SLACK_NOTIFICATION_RECONCILIATION: "Slack 알림 동기화",
    DAOU_CALENDAR_RECONCILIATION: "다우오피스 확정 일정 확인",
  };
  return labels[jobType] ?? "외부 연동 확인";
}

function retryStatusInfo(status: string) {
  if (status === "PENDING") return { label: "자동 재시도 대기", variant: "warning" as const, detail: "워커가 잠시 후 같은 작업을 다시 시도합니다." };
  if (status === "FAILED") return { label: "자동 재시도 실패", variant: "destructive" as const, detail: "자동 재시도가 모두 끝났습니다. 연동 상태를 확인해 주세요." };
  return { label: "처리 완료", variant: "success" as const, detail: "워커가 처리한 기록입니다." };
}

function readinessStatusInfo(status: string | undefined) {
  if (status === "READY" || status === "RUNNING") return { label: "연결 정상", variant: "success" as const };
  if (status === "ATTENTION" || status === "DEGRADED" || status === "STALE") {
    return { label: status === "STALE" ? "최신 확인 필요" : "일부 확인 필요", variant: "warning" as const };
  }
  if (status === "BLOCKED" || status === "NOT_READY") return { label: "설정 확인 필요", variant: "destructive" as const };
  if (status === "NOT_RUN") return { label: "진단 전", variant: "secondary" as const };
  return { label: "확인 중", variant: "secondary" as const };
}

function readinessReasonLabel(reason: unknown) {
  if (reason === "AUTH_TEST_TIMEOUT" || reason === "TOOL_LIST_TIMEOUT") return "응답 시간 초과";
  if (reason === "AUTH_TEST_FAILED") return "인증 확인 실패";
  if (reason === "TOOL_LIST_FAILED") return "도구 목록 확인 실패";
  if (reason === "MISSING_CONFIGURATION") return "필수 설정 없음";
  return "추가 확인 필요";
}

function freshnessStatusInfo(state: "FRESH" | "STALE" | "UNKNOWN" | undefined) {
  if (state === "FRESH") return { label: "최근 동기화됨", className: "text-emerald-700", dot: "bg-emerald-500" };
  if (state === "STALE") return { label: "최신 확인 필요", className: "text-amber-700", dot: "bg-amber-500" };
  return { label: "동기화 기록 없음", className: "text-slate-500", dot: "bg-slate-300" };
}

function SummaryMetricCard({
  icon,
  label,
  value,
  description,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  description: string;
  tone: "amber" | "rose" | "blue";
}) {
  const toneClass = {
    amber: "bg-amber-50 text-amber-700",
    rose: "bg-rose-50 text-rose-700",
    blue: "bg-blue-50 text-blue-700",
  }[tone];

  return (
    <Card className="h-full">
      <CardContent className="min-h-32 p-5 pt-5 sm:p-6 sm:pt-6">
        <div className="flex items-center gap-3">
          <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${toneClass}`}>{icon}</span>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <p className="text-base font-semibold leading-6 text-slate-700">{label}</p>
            <strong className="shrink-0 text-2xl font-semibold leading-none tracking-tight text-slate-950">{value}</strong>
          </div>
        </div>
        <p className="mt-3 ml-[3.25rem] text-sm leading-6 text-slate-500">{description}</p>
      </CardContent>
    </Card>
  );
}

function OperationsReadinessCard() {
  const READINESS_REQUEST_TIMEOUT_MS = 12_000;
  const [data, setData] = useState<OperationalReadinessPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = async (external: boolean) => {
    const currentRequestId = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/operations/readiness?external=${external}`, {
        signal: AbortSignal.timeout(READINESS_REQUEST_TIMEOUT_MS),
      });
      const responseText = await response.text();
      let result: OperationalReadinessPayload & { error?: string };
      try {
        result = JSON.parse(responseText) as OperationalReadinessPayload & { error?: string };
      } catch {
        throw new Error(`연결 진단 서버가 올바른 응답을 반환하지 않았습니다. 상태 코드 ${response.status}`);
      }
      if (!response.ok) throw new Error(result.error ?? "운영 상태를 확인하지 못했습니다.");
      if (currentRequestId === requestId.current) setData(result);
    } catch (caught) {
      if (currentRequestId === requestId.current) {
        setError(caught instanceof Error ? caught.message : "운영 상태를 확인하지 못했습니다.");
      }
    } finally {
      if (currentRequestId === requestId.current) setLoading(false);
    }
  };

  const openDaouLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/operations/daou-login", {
        method: "POST",
        signal: AbortSignal.timeout(READINESS_REQUEST_TIMEOUT_MS),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "다우오피스 로그인 창을 열지 못했습니다.");
      await load(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "다우오피스 로그인 창을 열지 못했습니다.");
      setLoading(false);
    }
  };

  const retryIntegrationJob = async (jobId: string) => {
    if (!window.confirm("자동 재시도에 실패한 작업을 다시 대기열에 넣을까요? 외부 메시지는 즉시 발송되지 않습니다.")) return;
    setRetryingId(jobId);
    setError(null);
    try {
      const response = await fetch(`/api/operations/retries/${jobId}`, { method: "POST" });
      const result = await response.json() as { queued?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "연동 재시도 작업을 다시 넣지 못했습니다.");
      await load(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "연동 재시도 작업을 다시 넣지 못했습니다.");
    } finally {
      setRetryingId(null);
    }
  };

  useEffect(() => { void load(false); }, []);
  const daou = data?.readiness.checks.daouOfficeBrowser;
  const daouConnected = daou?.connected === true;
  const readinessStatus = readinessStatusInfo(data?.readiness.overallStatus);
  const externalChecks = data?.readiness.externalChecks.checks ?? {};
  const workerCheck = data?.readiness.checks.worker;
  const retries = data?.retryJobs ?? [];
  const activeRetries = retries.filter((job) => job.status !== "COMPLETED");
  const pendingRetries = activeRetries.filter((job) => job.status === "PENDING");
  const failedRetries = activeRetries.filter((job) => job.status === "FAILED");

  return (
    <Card className="mt-6" id="integration-health">
      <CardHeader className="flex-row items-start justify-between gap-4 border-b-0 pb-5">
        <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">INTEGRATION HEALTH</p><CardTitle className="mt-2">연동 상태와 복구</CardTitle><CardDescription className="mt-2">자동 재시도는 워커가 처리합니다. 한도 초과 작업은 확인 후 다시 대기열에 넣을 수 있으며, 외부 메시지는 즉시 발송되지 않습니다.</CardDescription></div>
        <Badge variant={readinessStatus.variant}>{readinessStatus.label}</Badge>
      </CardHeader>
      <CardContent className="grid gap-5 p-6 pt-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-start">
        <div className="rounded-xl border border-slate-200 p-4"><p className="text-sm font-medium text-slate-500">다우오피스 전용 브라우저</p><p className="mt-2 text-lg font-semibold text-slate-950">{daouConnected ? "연결됨" : "로그인 또는 연결 확인 필요"}</p><p className="mt-2 text-sm leading-6 text-slate-600">{daou?.latestMeetingRoomSyncAt ? `마지막 회의실 동기화. ${formatDateTime(String(daou.latestMeetingRoomSyncAt))}` : "회의실을 추천하기 전 해당 후보자 기준으로 동기화합니다."}</p></div>
        <div className="rounded-xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-slate-500">외부 연결 확인</p><Badge variant={data?.readiness.externalChecks.performed ? "success" : "secondary"}>{data?.readiness.externalChecks.performed ? "진단 완료" : "진단 전"}</Badge></div>
          <div className="mt-3 space-y-2">
            {[{ label: "Slack", check: externalChecks.slack }, { label: "나인하이어", check: externalChecks.ninehire }, { label: "워커", check: workerCheck }].map(({ label, check }) => {
              const status = typeof check?.status === "string" ? check.status : "NOT_RUN";
              const info = readinessStatusInfo(status);
              return <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2" key={label}><span className="text-sm font-medium text-slate-700">{label}</span><span className="flex items-center gap-2"><span className="text-xs text-slate-500">{check?.reason ? readinessReasonLabel(check.reason) : null}</span><Badge variant={info.variant}>{info.label}</Badge></span></div>;
            })}
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">연결 다시 진단을 누르면 Slack과 나인하이어를 다시 확인합니다. 워커가 최신이 아니면 자동화 처리가 멈출 수 있습니다.</p>
        </div>
        <div className="rounded-xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-slate-500">자동 복구 대기열</p><div className="flex gap-1.5"><Badge variant="warning">대기 {pendingRetries.length}</Badge><Badge variant="destructive">실패 {failedRetries.length}</Badge></div></div>
          <p className="mt-2 text-lg font-semibold text-slate-950">확인 필요한 작업 {activeRetries.length}건</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">Slack·나인하이어 조회가 잠시 실패하면 워커가 자동으로 다시 시도합니다. 외부 메시지 발송은 자동으로 진행하지 않습니다.</p>
          {activeRetries.length > 0 ? <div className="mt-4 grid max-h-64 gap-2 overflow-y-auto pr-1">{activeRetries.slice(0, 5).map((job) => {
            const info = retryStatusInfo(job.status);
            const maxAttempts = job.maxAttempts ?? 3;
            return <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3" key={job.id}>
              <div className="flex flex-wrap items-start justify-between gap-2"><p className="text-sm font-semibold text-slate-900">{retryJobTypeLabel(job.jobType)}</p><Badge variant={info.variant}>{info.label}</Badge></div>
              <p className="mt-1 text-xs leading-5 text-slate-600">{info.detail}</p>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-slate-500">시도 {job.attemptCount}/{maxAttempts}{job.status === "PENDING" && job.nextAttemptAt ? ` · 다음 확인 ${formatDateTime(job.nextAttemptAt)}` : ""}</p>{job.status === "FAILED" ? <Button disabled={retryingId === job.id || loading} onClick={() => void retryIntegrationJob(job.id)} size="sm" variant="outline">{retryingId === job.id ? <Loader2 className="size-3.5 animate-spin" /> : null}재시도 승인</Button> : null}</div>
            </div>;
          })}</div> : <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm leading-6 text-emerald-800">현재 자동으로 복구할 작업이 없습니다.</p>}
          {activeRetries.length > 5 ? <p className="mt-2 text-xs text-slate-500">최근 5건만 표시합니다. 전체 상태는 연결 진단 결과에서 확인하세요.</p> : null}
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end"><Button disabled={loading} onClick={() => void load(true)} variant="outline">{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}연결 다시 진단</Button>{!daouConnected ? <Button disabled={loading} onClick={() => void openDaouLogin()} variant="outline">다우오피스 로그인</Button> : null}</div>
        {error ? <p aria-live="assertive" className="lg:col-span-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
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
  const actionKind = directDecision ? "결정 재개" : actionableReview ? "검토 필요" : item.caseSkillKey ? "다음 단계 선택" : "상세 확인";
  const actionHint = directDecision
    ? "선택지를 확인한 뒤 적용합니다."
    : actionableReview
      ? "검토 내용을 열어 처리 방법을 선택합니다."
      : item.caseSkillKey
        ? "다음 단계와 실행 범위를 확인합니다."
        : "후보자 상세에서 현재 상태를 확인합니다.";

  return (
    <article className="grid gap-5 px-6 py-6 sm:min-h-[292px] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-7">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`size-2 rounded-full ${priority.dot}`} />
          <Badge variant={priority.badge}>{priority.label}</Badge>
          <span className="text-sm text-slate-500">{item.category}</span>
          {item.meta ? <span className="text-sm text-slate-500">· {item.meta}</span> : null}
          {item.relatedItems?.length ? (
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-100">추가 검토 {item.relatedItems.length}건</summary>
              <div className="absolute left-0 z-20 mt-2 grid w-[min(30rem,calc(100vw-5rem))] gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                {item.relatedItems.map((related) => {
                  const relatedReview = related.review;
                  const relatedDecision = related.decision;
                  const relatedActionableReview = Boolean(relatedReview && supportedReviewDecisionTypes.has(relatedReview.reviewType));
                  return (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2" key={related.id}>
                      <div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">{related.title}</p><p className="mt-0.5 text-xs text-slate-500">{related.category}</p></div>
                      {relatedDecision ? <Button aria-label={`${related.candidateName ?? "후보자"} 결정 재개`} onClick={() => onOpenDecision(relatedDecision)} size="sm" title="선택지를 확인한 뒤 적용합니다." variant="decision">결정 계속하기<ArrowRight className="size-3.5" /></Button> : null}
                      {!relatedDecision && relatedActionableReview && relatedReview ? <Button aria-label={`${related.candidateName ?? "후보자"} 검토 열기`} disabled={loading} onClick={() => onCreateReviewDecision(relatedReview)} size="sm" title="검토 내용을 열어 처리 방법을 선택합니다." variant="outline">검토하기<ArrowRight className="size-3.5" /></Button> : null}
                      {!relatedDecision && !relatedActionableReview && related.caseSkillKey && related.caseId ? <Button aria-label={`${related.candidateName ?? "후보자"} 다음 단계 선택`} disabled={loading} onClick={() => onCreateCaseDecision(related.caseId!, related.caseSkillKey!)} size="sm" title="다음 단계와 실행 범위를 확인합니다.">결정하기<ArrowRight className="size-3.5" /></Button> : null}
                      {!relatedDecision && !relatedActionableReview && !related.caseSkillKey && related.href ? <Button asChild aria-label={`${related.candidateName ?? "후보자"} 상세 확인`} size="sm" title="후보자 상세에서 현재 상태를 확인합니다." variant="outline"><Link href={related.href}>상세 보기<ArrowRight className="size-3.5" /></Link></Button> : null}
                    </div>
                  );
                })}
              </div>
            </details>
          ) : null}
        </div>
        <h3 className="mt-3 text-xl font-semibold tracking-[-0.025em] text-slate-950">{item.candidateName ?? "후보자 확인 필요"}</h3>
        <p className="mt-1 text-base text-slate-600">{item.recruitmentName ?? "채용 정보 확인 필요"}</p>
        <div className="mt-4 border-y border-slate-100 py-4"><ActionJourney compact currentIndex={item.journeyIndex} /></div>
        <p className="mt-4 text-base font-medium leading-6 text-slate-800">{item.title}</p>
        <p className="mt-1 text-sm leading-6 text-slate-600">{item.description}</p>
      </div>
      <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
        <span className={`text-xs font-semibold ${directDecision ? "text-indigo-700" : actionableReview ? "text-slate-600" : item.caseSkillKey ? "text-blue-700" : "text-slate-500"}`}>{actionKind}</span>
        {directDecision ? <Button aria-label={`${item.candidateName ?? "후보자"} ${actionHint}`} title={actionHint} variant="decision" onClick={() => onOpenDecision(directDecision)}>결정 계속하기<ArrowRight className="size-4" /></Button> : null}
        {!directDecision && actionableReview && review ? (
          <Button aria-label={`${item.candidateName ?? "후보자"} ${actionHint}`} disabled={loading} onClick={() => onCreateReviewDecision(review)} title={actionHint} variant="outline">{loading ? <Loader2 className="size-4 animate-spin" /> : null}{item.actionLabel ?? "검토 열기"}<ArrowRight className="size-4" /></Button>
        ) : null}
        {!directDecision && !actionableReview && item.caseSkillKey && item.caseId ? (
          <Button aria-label={`${item.candidateName ?? "후보자"} ${actionHint}`} disabled={loading} onClick={() => onCreateCaseDecision(item.caseId!, item.caseSkillKey!)} title={actionHint}>{loading ? <Loader2 className="size-4 animate-spin" /> : null}{item.actionLabel ?? "결정하기"}<ArrowRight className="size-4" /></Button>
        ) : null}
        {!directDecision && !actionableReview && !item.caseSkillKey && item.href && item.actionLabel ? <Button asChild aria-label={`${item.candidateName ?? "후보자"} ${actionHint}`} title={actionHint} variant="outline"><Link href={item.href}>{item.actionLabel}<ArrowRight className="size-4" /></Link></Button> : null}
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

function paginationPages(page: number, pageCount: number) {
  const windowSize = 5;
  const start = Math.floor((Math.max(1, page) - 1) / windowSize) * windowSize + 1;
  const end = Math.min(pageCount, start + windowSize - 1);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}

export function DashboardClient({ initialData }: { initialData: DashboardSnapshot }) {
  const [data, setData] = useState(initialData);
  const [activeDecision, setActiveDecision] = useState<ActiveDecision | null>(null);
  const [templatePreview, setTemplatePreview] = useState<{ preview: RecruitmentTemplatePreview["preview"]; reviewId: string | null } | null>(null);
  const [interviewerMapping, setInterviewerMapping] = useState<InterviewerSlackMappingRequest | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueTab, setQueueTab] = useState<"ACTION" | "WAITING" | "EXCEPTION" | "ALL">("ACTION");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [hydrated, setHydrated] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshRequestId = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestId.current;
    setRefreshing(true);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error("운영 현황을 새로 불러오지 못했습니다.");
      const nextData = await response.json() as DashboardSnapshot;
      if (requestId !== refreshRequestId.current) return;
      setData(nextData);
      setError(null);
    } catch (caught) {
      if (requestId === refreshRequestId.current) throw caught;
    } finally {
      if (requestId === refreshRequestId.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setHydrated(true);
    const interval = window.setInterval(() => void refresh().catch((caught) => setError(caught instanceof Error ? caught.message : "운영 현황을 새로 불러오지 못했습니다.")), 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const createReviewDecision = async (review: Review) => {
    setLoadingId(`review:${review.id}`);
    setError(null);
    try {
      const response = await fetch(`/api/reviews/${review.id}/decision`, { method: "POST" });
      const result = await readApiJson<{ decision?: Decision; dismissOnClose?: boolean; error?: string }>(response, "결정문을 만들지 못했습니다.");
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
      const result = await readApiJson<{ decision?: Decision; dismissOnClose?: boolean; error?: string }>(response, "선택지를 만들지 못했습니다.");
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
    if (loadingId === decision.id) return;
    setLoadingId(decision.id);
    setError(null);
    try {
      const response = await fetch(`/api/decisions/${decision.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId }),
      });
      const result = await readApiJson<{ error?: string; followUp?: unknown }>(response, "결정문을 처리하지 못했습니다.");
      if (!response.ok) throw new Error(result.error ?? "결정문을 처리하지 못했습니다.");
      const followUpDecision = result.followUp
        && typeof result.followUp === "object"
        && "decision" in result.followUp
        && isDecision((result.followUp as { decision?: unknown }).decision)
        ? (result.followUp as { decision: Decision }).decision
        : null;
      if (followUpDecision) {
        setActiveDecision({ decision: followUpDecision, dismissOnClose: false });
      } else if (
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
      const result = await readApiJson<{ decision?: Decision; error?: string }>(response, "인터뷰 규칙을 저장하지 못했습니다.");
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
      const result = await readApiJson<{ dismissed?: boolean; error?: string }>(response, "선택지를 닫지 못했습니다.");
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
      const result = await readApiJson<{ decision?: Decision; error?: string }>(response, "보류한 조율을 다시 시작하지 못했습니다.");
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
  const allQueueItems = useMemo(() => groupAllQueueItems(actionItems), [actionItems]);
  const queueCounts = useMemo(() => ({
    ACTION: actionItems.filter((item) => item.queue === "ACTION").length,
    WAITING: actionItems.filter((item) => item.queue === "WAITING").length,
    EXCEPTION: actionItems.filter((item) => item.queue === "EXCEPTION").length,
    ALL: allQueueItems.length,
  }), [actionItems, allQueueItems]);
  const filteredActionItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const source = queueTab === "ALL" ? allQueueItems : actionItems.filter((item) => item.queue === queueTab);
    return source.filter((item) => {
      if (!normalizedQuery) return true;
      const haystack = [item.candidateName, item.recruitmentName, item.title, item.description, item.category, item.meta]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [actionItems, allQueueItems, query, queueTab]);
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(filteredActionItems.length / pageSize));
  const pageNumbers = useMemo(() => paginationPages(page, pageCount), [page, pageCount]);
  const visibleActionItems = useMemo(() => filteredActionItems.slice((page - 1) * pageSize, page * pageSize), [filteredActionItems, page, pageSize]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  useEffect(() => {
    setPage(1);
  }, [query, queueTab]);
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);
  const upcoming = useMemo(() => {
    const localSchedules: UpcomingInterview[] = data.dashboard.cases
      .filter((interviewCase) => interviewCase.scheduledDate && interviewCase.scheduledStartTime && interviewCase.scheduledEndTime && ["CONFIRMED", "AWAITING_CANDIDATE_CONFIRMATION"].includes(interviewCase.status))
      .map((interviewCase) => ({
        id: interviewCase.id,
        candidateName: interviewCase.candidateName,
        recruitmentName: interviewCase.recruitmentName,
        date: interviewCase.scheduledDate!,
        startTime: interviewCase.scheduledStartTime!,
        endTime: interviewCase.scheduledEndTime!,
        href: `/cases/${interviewCase.id}`,
        source: "LOCAL" as const,
      }));
    const calendarSchedules: UpcomingInterview[] = (data.externalConfirmedInterviews ?? [])
      .filter((interview) => !interview.linkedCaseId)
      .map((interview) => ({
        id: `daou:${interview.id}`,
        candidateName: interview.candidateName,
        recruitmentName: interview.recruitmentName,
        date: interview.date,
        startTime: interview.startTime,
        endTime: interview.endTime,
        href: null,
        source: "DAOU_OFFICE_CALENDAR" as const,
      }));
    const today = todayInSeoulDate();
    return [...localSchedules, ...calendarSchedules]
      .filter((interview) => interview.date >= today)
      .sort((left, right) => {
        const leftKey = `${left.date}T${left.startTime}`;
        const rightKey = `${right.date}T${right.startTime}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
  }, [data.dashboard.cases, data.externalConfirmedInterviews]);
  const visibleUpcoming = upcoming.slice(0, 5);
  const summary = data.dashboard.summary;
  const freshnessWarnings = [
    summary.worker.status !== "RUNNING" || summary.freshness.worker.state !== "FRESH" ? "워커 처리" : null,
    summary.freshness.slack.state !== "FRESH" ? "Slack 알림" : null,
    summary.freshness.ninehire.state !== "FRESH" ? "나인하이어 데이터" : null,
    summary.freshness.daouOffice.state !== "FRESH" ? "회의실 예약" : null,
    summary.freshness.daouOfficeCalendar.state !== "FRESH" ? "다우오피스 인터뷰 일정" : null,
  ].filter((source): source is string => Boolean(source));
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
      <main className="mx-auto max-w-[1440px] px-5 pb-12 sm:px-8" id="main-content">
        <PageHeader
          actions={<Button disabled={refreshing} variant="outline" onClick={() => void refresh().catch((caught) => setError(caught instanceof Error ? caught.message : "운영 현황을 새로 불러오지 못했습니다."))}>{refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {refreshing ? "갱신 중" : "새로고침"}</Button>}
          description="판단하거나 처리해야 하는 인터뷰 업무부터 확인하고, 확정된 일정과 운영 상태를 함께 살펴보세요."
          eyebrow="INTERVIEW OPERATIONS"
          title="오늘의 인터뷰 운영"
        />

        {error ? <div className="mb-6 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800"><AlertCircle className="size-4" />{error}</div> : null}
        {freshnessWarnings.length > 0 ? (
          <div aria-live="polite" className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-amber-950 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3"><TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-700" /><div><p className="text-sm font-bold">최신 운영 데이터 확인이 필요합니다.</p><p className="mt-1 text-sm leading-6 text-amber-900">{freshnessWarnings.join(", ")} 상태가 최신이 아닙니다. 아래 큐는 마지막으로 성공한 동기화 기준으로 표시됩니다.</p></div></div>
            <Button className="shrink-0" disabled={refreshing} onClick={() => void refresh().catch((caught) => setError(caught instanceof Error ? caught.message : "운영 현황을 새로 불러오지 못했습니다."))} size="sm" variant="outline">{refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}다시 확인</Button>
          </div>
        ) : null}

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
            <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{upcoming.length}</p>
            <p className="mt-1 text-xs text-slate-500">확정 또는 후보자 응답 대기</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-slate-600">워커 상태</span><Wifi className="size-5 text-slate-500" /></div>
            <p className="mt-2 text-lg font-semibold tracking-tight text-slate-950">{summary.worker.status === "RUNNING" ? "정상 작동" : summary.worker.status}</p>
            <p className="mt-1 text-xs text-slate-500">마지막 갱신 {hydrated ? formatGeneratedAt(data.dashboard.generatedAt) : "초기 데이터 로드"}</p>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card aria-busy={refreshing} className="overflow-hidden">
            <CardHeader className="border-b border-slate-200 p-6 sm:p-7">
              <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">PRIORITY QUEUE</p><CardTitle className="mt-2 flex items-center gap-2 text-2xl">인터뷰 운영 큐 <Badge>{filteredActionItems.length}</Badge></CardTitle><CardDescription className="mt-2">한 화면에서는 지금 확인할 후보자만 보여주고, 나머지는 페이지로 나눠 관리합니다.</CardDescription></div>
            </CardHeader>
            <div className="border-b border-slate-200 px-6 py-4 sm:px-7">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-wrap gap-2" role="group" aria-label="운영 큐 필터">
                  {queueTabs.map((tab) => <button aria-pressed={queueTab === tab.id} className={`rounded-full px-3 py-2 text-sm font-semibold transition-colors ${queueTab === tab.id ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`} key={tab.id} onClick={() => setQueueTab(tab.id)} type="button">{tab.label} <span className="ml-1 opacity-75">{queueCounts[tab.id]}</span></button>)}
                </div>
                <label className="relative block w-full lg:max-w-xs"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><span className="sr-only">후보자 또는 채용 검색</span><input className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100" onChange={(event) => setQuery(event.target.value)} placeholder="후보자·채용·업무 검색" type="search" value={query} /></label>
              </div>
            </div>
            {filteredActionItems.length === 0 ? (
              <CardContent aria-live="polite" className="grid min-h-64 place-items-center p-8 text-center"><div>
                {query.trim() ? <SearchX className="mx-auto size-9 text-slate-400" /> : <CheckCircle2 className="mx-auto size-9 text-emerald-600" />}
                <p className="mt-4 text-lg font-semibold">{query.trim() ? "검색 결과가 없습니다." : queueTab === "ACTION" ? "지금 처리할 업무가 없습니다." : "이 큐에 해당하는 업무가 없습니다."}</p>
                <p className="mt-2 text-base text-slate-600">{query.trim() ? "후보자 이름이나 채용명을 다르게 검색해 보세요." : queueTab === "ACTION" ? "새로운 평가 완료나 회신이 들어오면 이곳에 표시됩니다." : "다른 큐를 선택하거나 새로고침해 보세요."}</p>
              </div></CardContent>
            ) : <>
              <div className="divide-y divide-slate-200 sm:min-h-[1460px]">{visibleActionItems.map((item) => <ActionRow key={item.id} item={item} loading={loadingId === item.id} onCreateCaseDecision={createCaseDecision} onCreateReviewDecision={createReviewDecision} onOpenDecision={(decision) => setActiveDecision({ decision, dismissOnClose: false })} />)}</div>
              <div className="flex flex-col gap-3 border-t border-slate-200 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7"><p className="text-sm text-slate-500">전체 {filteredActionItems.length}건 중 {Math.min((page - 1) * pageSize + 1, filteredActionItems.length)}–{Math.min(page * pageSize, filteredActionItems.length)}건</p><nav aria-label="인터뷰 운영 큐 페이지" className="flex items-center justify-end gap-1"><Button aria-label="이전 페이지 묶음" disabled={pageNumbers[0] === undefined || pageNumbers[0] <= 1} onClick={() => setPage((pageNumbers[0] ?? 1) - 5)} size="icon-sm" title="이전 5페이지" variant="outline"><ChevronLeft className="size-4" /></Button>{pageNumbers.map((pageNumber) => <Button aria-current={pageNumber === page ? "page" : undefined} aria-label={`${pageNumber}페이지`} className={pageNumber === page ? "ring-2 ring-blue-200" : undefined} key={pageNumber} onClick={() => setPage(pageNumber)} size="sm" variant={pageNumber === page ? "secondary" : "outline"}>{pageNumber}</Button>)}<Button aria-label="다음 페이지 묶음" disabled={(pageNumbers[pageNumbers.length - 1] ?? pageCount) >= pageCount} onClick={() => setPage(Math.min(pageCount, (pageNumbers[0] ?? 1) + 5))} size="icon-sm" title="다음 5페이지" variant="outline"><ChevronRight className="size-4" /></Button></nav></div>
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
                {upcoming.length === 0 ? <p className="text-base leading-7 text-slate-600">기록된 일정 인터뷰가 없습니다.</p> : <div className="divide-y divide-slate-200">{visibleUpcoming.map((interview) => (
                  <UpcomingInterviewItem interview={interview} key={interview.id} />
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

        <section className="mt-8 grid gap-4 md:grid-cols-3" aria-label="운영 상태">
          <SummaryMetricCard description="필수 면접관 중 아직 가능 일정을 제출하지 않은 인원 수입니다." icon={<UsersRound className="size-5" />} label="면접관 일정 회신 대기" tone="amber" value={summary.pendingRequiredInterviewerResponses} />
          <SummaryMetricCard description="Slack 또는 나인하이어 연동에서 다시 확인이 필요한 작업 수입니다." icon={<Wifi className="size-5" />} label="연동 오류 확인" tone="rose" value={summary.pendingIntegrationRetries + summary.failedIntegrationRetries} />
          <SummaryMetricCard description="이 대시보드의 정보를 마지막으로 불러온 시각입니다." icon={<ClipboardList className="size-5" />} label="대시보드 확인 시각" tone="blue" value={hydrated ? formatGeneratedAt(data.dashboard.generatedAt) : "초기 로드"} />
        </section>
        <section className="mt-6" aria-label="데이터 신선도">
          <Card>
            <CardHeader className="border-b-0 pb-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">DATA FRESHNESS</p>
                <CardTitle className="mt-2 text-xl">외부 연동 확인 상태</CardTitle>
                <CardDescription className="mt-2">화면을 연 시각과 Slack·나인하이어·다우오피스·워커가 마지막으로 정상 처리한 시각을 구분해 보여줍니다. 최신 확인 필요가 표시되면 해당 연동을 점검하세요.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 p-5 pt-0 sm:grid-cols-2 xl:grid-cols-5">
              {([
                ["Slack 알림", summary.freshness?.slack],
                ["나인하이어 일정", summary.freshness?.ninehire],
                ["다우오피스 회의실", summary.freshness?.daouOffice],
                ["다우오피스 인터뷰 일정", summary.freshness?.daouOfficeCalendar],
                ["워커 처리", summary.freshness?.worker],
              ] as const).map(([label, source]) => {
                const info = freshnessStatusInfo(source?.state);
                return (
                  <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4" key={label}>
                    <p className="text-sm font-semibold text-slate-900">{label}</p>
                    <p className={`mt-2 flex items-center gap-2 text-sm font-medium ${info.className}`}><span aria-hidden="true" className={`size-2 rounded-full ${info.dot}`} />{info.label}</p>
                    <p className="mt-2 text-xs text-slate-500">{source?.lastSuccessfulAt ? formatDateTime(source.lastSuccessfulAt) : "성공 기록이 아직 없습니다."}</p>
                  </div>
                );
              })}
            </CardContent>
          </Card>
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
