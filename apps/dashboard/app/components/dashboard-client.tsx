"use client";
// 인터뷰 운영자가 지금 처리해야 할 일에 집중하도록 작업 화면을 제공한다.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CandidateCase, DashboardSnapshot, Decision, InterviewCaseStatus, Review } from "../lib/dashboard-types";

type ActionPriority = "urgent" | "normal" | "watch";

type ActionItem = {
  id: string;
  priority: ActionPriority;
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
};

const actionableReviewType = "INTERVIEW_ARRANGEMENT_START_REQUIRED";

function formatDate(value: string | null | undefined) {
  if (!value) return "일정 미정";
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short" }).format(
    new Date(`${value}T00:00:00+09:00`),
  );
}

function formatGeneratedAt(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
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

function statusText(status: InterviewCaseStatus) {
  const labels: Record<InterviewCaseStatus, string> = {
    READY_FOR_DRAFT: "조율 시작 준비",
    DRAFT_CREATED: "요청 초안 검토",
    REQUEST_SENT: "면접관 응답 대기",
    COLLECTING_AVAILABILITY: "면접관 일정 수집",
    READY_TO_SCHEDULE: "시간·회의실 선택",
    AWAITING_CANDIDATE_CONFIRMATION: "후보자 응답 대기",
    CONFIRMED: "최종 확정",
    CANCELLED: "취소",
    REVIEW_REQUIRED: "예외 검토",
    CLOSED: "종료",
  };
  return labels[status];
}

function reviewCategory(review: Review) {
  const labels: Record<string, string> = {
    INTERVIEW_ARRANGEMENT_START_REQUIRED: "조율 시작 확인",
    CANDIDATE_INTERVIEW_ABSENCE_REVIEW_REQUIRED: "후보자 응답 확인",
    WORKER_DOWNTIME_AVAILABILITY_REVIEW_REQUIRED: "가용시간 복구 확인",
  };
  return labels[review.reviewType] ?? "운영 확인";
}

function caseAction(interviewCase: CandidateCase): ActionItem | undefined {
  const base = {
    id: `case:${interviewCase.id}`,
    candidateName: interviewCase.candidateName,
    recruitmentName: interviewCase.recruitmentName,
    href: `/cases/${interviewCase.id}`,
    decision: undefined,
    review: undefined,
  };

  if (interviewCase.status === "READY_TO_SCHEDULE") {
    return {
      ...base,
      priority: "urgent",
      category: "시간·회의실 검토",
      title: "인터뷰 시간과 회의실을 선택할 수 있습니다.",
      description: `${stageLabel(interviewCase)} · 면접관 응답 ${interviewCase.interviewerResponses.submitted}/${interviewCase.interviewerResponses.required}`,
      meta: "추천 결과를 확인하세요.",
      actionLabel: "일정 검토",
    };
  }
  if (interviewCase.status === "DRAFT_CREATED") {
    return {
      ...base,
      priority: "normal",
      category: "면접관 요청 초안",
      title: "면접관에게 보낼 일정 요청 초안을 검토하세요.",
      description: stageLabel(interviewCase),
      meta: "승인 전에는 Slack으로 발송되지 않습니다.",
      actionLabel: "초안 확인",
    };
  }
  if (interviewCase.status === "REVIEW_REQUIRED") {
    return {
      ...base,
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
  const caseIdsWithDecision = new Set(
    data.decisions.map((decision) => decision.caseId).filter((caseId): caseId is string => Boolean(caseId)),
  );
  const reviewIdsWithDecision = new Set(
    data.decisions.map((decision) => decision.reviewId).filter((reviewId): reviewId is string => Boolean(reviewId)),
  );
  const caseIdsWithReview = new Set(
    data.reviews.map((review) => review.caseId).filter((caseId): caseId is string => Boolean(caseId)),
  );

  const decisionItems: ActionItem[] = data.decisions.map((decision) => ({
    id: `decision:${decision.id}`,
    priority: "urgent",
    category: "선택 대기",
    title: decision.title,
    description: decision.prompt,
    candidateName: decision.candidateName,
    recruitmentName: decision.recruitmentName,
    meta: "선택 내용을 확인한 뒤 적용합니다.",
    actionLabel: "결정하기",
    href: decision.caseId ? `/cases/${decision.caseId}` : null,
    decision,
  }));
  const reviewItems: ActionItem[] = data.reviews
    .filter((review) => !reviewIdsWithDecision.has(review.id))
    .map((review) => ({
      id: `review:${review.id}`,
      priority: review.reviewType === actionableReviewType ? "urgent" : "normal",
      category: reviewCategory(review),
      title: review.reviewType === actionableReviewType ? "인터뷰 조율을 시작할지 확인하세요." : review.reason,
      description: review.reviewType === actionableReviewType
        ? `${review.currentStepName ?? "평가 완료"} · ${review.reason}`
        : review.currentStepName ?? "상세 내용 확인이 필요합니다.",
      candidateName: review.candidateName,
      recruitmentName: review.recruitmentName,
      meta: review.reviewType === actionableReviewType ? "승인 전에는 나인하이어·Slack에 변경이 없습니다." : null,
      actionLabel: review.reviewType === actionableReviewType ? "판단하기" : review.caseId ? "상세 보기" : null,
      href: review.caseId ? `/cases/${review.caseId}` : null,
      review,
    }));
  const caseItems = data.dashboard.cases
    .filter((interviewCase) => !caseIdsWithDecision.has(interviewCase.id) && !caseIdsWithReview.has(interviewCase.id))
    .map(caseAction)
    .filter((item): item is ActionItem => Boolean(item));

  return [...decisionItems, ...reviewItems, ...caseItems]
    .sort((left, right) => ({ urgent: 0, normal: 1, watch: 2 }[left.priority] - { urgent: 0, normal: 1, watch: 2 }[right.priority]));
}

function DecisionModal({ decision, onClose, onResolve, loading }: {
  decision: Decision;
  onClose: () => void;
  onResolve: (optionId: string) => void;
  loading: boolean;
}) {
  const [selectedOptionId, setSelectedOptionId] = useState(decision.options[0]?.id ?? "");
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="decision-modal" role="dialog" aria-modal="true" aria-labelledby="decision-title">
        <button type="button" className="close-button" onClick={onClose} aria-label="닫기">×</button>
        <span className="section-kicker">확인 후 선택</span>
        <h2 id="decision-title">{decision.title}</h2>
        <p className="modal-context">{decision.candidateName ?? "후보자"} · {decision.recruitmentName ?? "채용"}</p>
        <p className="modal-prompt">{decision.prompt}</p>
        <div className="decision-options">
          {decision.options.map((option) => (
            <label key={option.id} className={`decision-option ${selectedOptionId === option.id ? "selected" : ""}`}>
              <input type="radio" name="decision" value={option.id} checked={selectedOptionId === option.id} onChange={() => setSelectedOptionId(option.id)} />
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>나중에 결정</button>
          <button type="button" className="button button-primary" disabled={!selectedOptionId || loading} onClick={() => onResolve(selectedOptionId)}>
            {loading ? "처리 중" : "선택 적용"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ActionRow({ item, onCreateDecision, onOpenDecision, loading }: {
  item: ActionItem;
  onCreateDecision: (review: Review) => void;
  onOpenDecision: (decision: Decision) => void;
  loading: boolean;
}) {
  const directDecision = item.decision;
  const actionableReview = item.review?.reviewType === actionableReviewType;
  return (
    <article className={`action-row priority-${item.priority}`}>
      <div className="action-priority" aria-hidden="true"><span /></div>
      <div className="action-copy">
        <div className="action-meta"><span>{item.category}</span>{item.meta ? <small>{item.meta}</small> : null}</div>
        <h3>{item.candidateName ?? "후보자 확인 필요"}</h3>
        <p className="action-recruitment">{item.recruitmentName ?? "채용 정보 확인 필요"}</p>
        <p className="action-title">{item.title}</p>
        <p className="action-description">{item.description}</p>
      </div>
      <div className="action-control">
        {directDecision ? <button type="button" className="button button-primary" onClick={() => onOpenDecision(directDecision)}>결정하기</button> : null}
        {!directDecision && actionableReview && item.review ? (
          <button type="button" className="button button-primary" disabled={loading} onClick={() => onCreateDecision(item.review!)}>
            {loading ? "준비 중" : "판단하기"}
          </button>
        ) : null}
        {!directDecision && !actionableReview && item.href && item.actionLabel ? <Link className="button button-secondary" href={item.href}>{item.actionLabel}</Link> : null}
      </div>
    </article>
  );
}

export function DashboardClient({ initialData }: { initialData: DashboardSnapshot }) {
  const [data, setData] = useState(initialData);
  const [activeDecision, setActiveDecision] = useState<Decision | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok) throw new Error("운영 현황을 새로 불러오지 못했습니다.");
    setData(await response.json() as DashboardSnapshot);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => void refresh().catch(() => undefined), 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const createDecision = async (review: Review) => {
    setLoadingId(review.id);
    setError(null);
    try {
      const response = await fetch(`/api/reviews/${review.id}/decision`, { method: "POST" });
      const result = await response.json() as { decision?: Decision; error?: string };
      if (!response.ok || !result.decision) throw new Error(result.error ?? "결정을 만들지 못했습니다.");
      setActiveDecision(result.decision);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "결정을 만들지 못했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  const resolveDecision = async (optionId: string) => {
    if (!activeDecision) return;
    setLoadingId(activeDecision.id);
    setError(null);
    try {
      const response = await fetch(`/api/decisions/${activeDecision.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "결정을 처리하지 못했습니다.");
      setActiveDecision(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "결정을 처리하지 못했습니다.");
    } finally {
      setLoadingId(null);
    }
  };

  const actionItems = useMemo(() => buildActionItems(data), [data]);
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
  ].map((item) => ({
    ...item,
    count: item.statuses.reduce((total, status) => total + summary.caseCountsByStatus[status as InterviewCaseStatus], 0),
  }));

  return (
    <main className="ops-shell">
      <header className="app-header">
        <Link className="brand" href="/"><span className="brand-mark">H</span><span>HUNET <b>OPS</b></span></Link>
        <nav className="primary-nav" aria-label="대시보드 메뉴">
          <Link className="active" href="/">운영</Link>
          <Link href="/rooms">회의실</Link>
        </nav>
        <div className={`connection-state worker-${summary.worker.status.toLowerCase()}`}><span />워커 {summary.worker.status === "RUNNING" ? "정상" : summary.worker.status}</div>
      </header>

      <section className="ops-intro">
        <div>
          <span className="section-kicker">INTERVIEW OPERATIONS</span>
          <h1>오늘의 인터뷰 운영</h1>
          <p>지금 판단하거나 처리해야 하는 업무부터 확인하세요.</p>
        </div>
        <button type="button" className="button button-secondary refresh-button" onClick={() => void refresh().catch((caught) => setError(caught.message))}>새로고침</button>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      <div className="operations-grid">
        <section className="work-queue" aria-labelledby="work-queue-title">
          <div className="section-heading work-heading">
            <div><span className="section-kicker">PRIORITY QUEUE</span><h2 id="work-queue-title">지금 처리할 일 <em>{actionItems.length}</em></h2></div>
            <p>후보자별 중복을 제거한 우선순위 목록입니다.</p>
          </div>
          {actionItems.length === 0 ? (
            <div className="queue-empty"><strong>지금 바로 처리할 업무가 없습니다.</strong><span>면접관 응답과 후보자 확답을 기다리고 있습니다.</span></div>
          ) : (
            <div className="action-list">
              {actionItems.map((item) => <ActionRow key={item.id} item={item} loading={loadingId === item.review?.id} onCreateDecision={createDecision} onOpenDecision={setActiveDecision} />)}
            </div>
          )}
        </section>

        <aside className="operations-rail">
          <section className="rail-panel upcoming-panel" aria-labelledby="upcoming-title">
            <div className="rail-heading"><span className="section-kicker">UP NEXT</span><h2 id="upcoming-title">다가오는 인터뷰</h2></div>
            {upcoming.length === 0 ? <p className="rail-empty">기록된 예정 인터뷰가 없습니다.</p> : (
              <div className="upcoming-list">
                {upcoming.map((interviewCase) => (
                  <Link href={`/cases/${interviewCase.id}`} key={interviewCase.id} className="upcoming-item">
                    <span className="upcoming-date">{formatDate(interviewCase.scheduledDate)}</span>
                    <strong>{interviewCase.candidateName ?? "후보자 확인 필요"}</strong>
                    <small>{formatSchedule(interviewCase)}</small>
                  </Link>
                ))}
              </div>
            )}
            <Link className="text-link" href="/rooms">회의실 시간표 보기 <span>→</span></Link>
          </section>

          <section className="rail-panel progress-panel" aria-labelledby="progress-title">
            <div className="rail-heading"><span className="section-kicker">PIPELINE</span><h2 id="progress-title">진행 중 조율</h2></div>
            <div className="progress-list">
              {progress.map((item) => <div className="progress-row" key={item.label}><span>{item.label}</span><strong>{item.count}</strong></div>)}
            </div>
            <div className="confirmed-summary"><span>최종 확정</span><strong>{summary.caseCountsByStatus.CONFIRMED}</strong></div>
          </section>
        </aside>
      </div>

      <section className="health-strip" aria-label="운영 상태">
        <div><span>면접관 미응답</span><strong>{summary.pendingRequiredInterviewerResponses}</strong><small>제출 확인이 필요한 필수 면접관입니다.</small></div>
        <div><span>연동 재시도</span><strong>{summary.pendingIntegrationRetries + summary.failedIntegrationRetries}</strong><small>Slack·나인하이어 동기화 오류를 확인하세요.</small></div>
        <div><span>데이터 갱신</span><strong>{formatGeneratedAt(data.dashboard.generatedAt)}</strong><small>30초마다 로컬 상태를 다시 확인합니다.</small></div>
      </section>

      {activeDecision ? <DecisionModal key={activeDecision.id} decision={activeDecision} loading={loadingId === activeDecision.id} onClose={() => setActiveDecision(null)} onResolve={resolveDecision} /> : null}
    </main>
  );
}
