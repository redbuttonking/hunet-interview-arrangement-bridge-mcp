"use client";
// 인터뷰 조율 운영 보드와 사용자 판단 상호작용을 제공한다.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CandidateCase, DashboardSnapshot, Decision, InterviewCaseStatus, Review } from "../lib/dashboard-types";

type BoardColumn = {
  id: "triage" | "collecting" | "scheduling" | "awaiting" | "confirmed";
  title: string;
  description: string;
};

const columns: BoardColumn[] = [
  { id: "triage", title: "검토·조율 시작", description: "평가 결과와 인터뷰 유형을 확인합니다." },
  { id: "collecting", title: "면접관 일정 수집", description: "가능 시간 제출을 기다립니다." },
  { id: "scheduling", title: "시간·회의실 검토", description: "추천 일정과 회의실을 선택합니다." },
  { id: "awaiting", title: "후보자 응답 대기", description: "나인하이어 일정 제안 후 확답을 기다립니다." },
  { id: "confirmed", title: "최종 확정", description: "인터뷰 일정을 확인합니다." },
];

function formatDate(value: string | null | undefined) {
  if (!value) return "미정";
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short" }).format(
    new Date(`${value}T00:00:00+09:00`),
  );
}

function formatTime(value: string | null | undefined) {
  return value ?? "";
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
    READY_FOR_DRAFT: "요청 초안 준비",
    DRAFT_CREATED: "초안 검토 대기",
    REQUEST_SENT: "요청 발송됨",
    COLLECTING_AVAILABILITY: "일정 수집 중",
    READY_TO_SCHEDULE: "시간 추천 가능",
    AWAITING_CANDIDATE_CONFIRMATION: "후보자 응답 대기",
    CONFIRMED: "최종 확정",
    CANCELLED: "취소",
    REVIEW_REQUIRED: "예외 검토",
    CLOSED: "종료",
  };
  return labels[status];
}

function columnForCase(interviewCase: CandidateCase): BoardColumn["id"] {
  if (interviewCase.status === "CONFIRMED") return "confirmed";
  if (interviewCase.status === "AWAITING_CANDIDATE_CONFIRMATION") return "awaiting";
  if (["READY_TO_SCHEDULE", "REVIEW_REQUIRED"].includes(interviewCase.status)) return "scheduling";
  if (["REQUEST_SENT", "COLLECTING_AVAILABILITY"].includes(interviewCase.status)) return "collecting";
  return "triage";
}

function CandidateCard({ interviewCase }: { interviewCase: CandidateCase }) {
  const hasSchedule = interviewCase.scheduledDate && interviewCase.scheduledStartTime;
  return (
    <Link className={`candidate-card ${interviewCase.needsAttention ? "attention" : ""}`} href={`/cases/${interviewCase.id}`}>
      <div className="candidate-card__top">
        <strong>{interviewCase.candidateName ?? "이름 미확인"}</strong>
        <span className={`status-chip status-${interviewCase.status.toLowerCase()}`}>{statusText(interviewCase.status)}</span>
      </div>
      <p className="recruitment-name">{interviewCase.recruitmentName ?? "채용 미확인"}</p>
      <p className="stage-label">{stageLabel(interviewCase)} · {interviewCase.interviewPlan?.durationMinutes ?? 60}분</p>
      {hasSchedule ? (
        <div className="schedule-line">
          <span>{formatDate(interviewCase.scheduledDate)} {formatTime(interviewCase.scheduledStartTime)}~{formatTime(interviewCase.scheduledEndTime)}</span>
          <span>{interviewCase.scheduledRoomName ?? "회의실 확인 필요"}</span>
        </div>
      ) : (
        <div className="response-line">
          면접관 응답 {interviewCase.interviewerResponses.submitted}/{interviewCase.interviewerResponses.required}
          {interviewCase.interviewerResponses.pending > 0 ? ` · 미응답 ${interviewCase.interviewerResponses.pending}` : ""}
        </div>
      )}
      {interviewCase.isReschedule ? <span className="reschedule-label">재조율 {interviewCase.isReschedule ? "진행" : ""}</span> : null}
    </Link>
  );
}

function ReviewCard({ review, onCreateDecision, loading }: {
  review: Review;
  onCreateDecision: (review: Review) => void;
  loading: boolean;
}) {
  const actionable = review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED";
  return (
    <article className="review-card">
      <div>
        <span className="review-type">{review.reviewType === "INTERVIEW_ARRANGEMENT_START_REQUIRED" ? "조율 시작 검토" : "판단 필요"}</span>
        <strong>{review.candidateName ?? "후보자 확인 필요"}</strong>
        <p>{review.recruitmentName ?? "채용 정보 확인 필요"}</p>
        {review.currentStepName ? <small>현재 전형. {review.currentStepName}</small> : null}
        <small>{review.reason}</small>
      </div>
      {actionable ? (
        <button type="button" className="secondary-button" disabled={loading} onClick={() => onCreateDecision(review)}>
          조율 판단하기
        </button>
      ) : null}
    </article>
  );
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
        <span className="eyebrow">사용자 판단 필요</span>
        <h2 id="decision-title">{decision.title}</h2>
        <p className="modal-context">{decision.candidateName ?? "후보자"} · {decision.recruitmentName ?? "채용"}</p>
        <p>{decision.prompt}</p>
        <div className="decision-options">
          {decision.options.map((option) => (
            <label key={option.id} className={`decision-option ${selectedOptionId === option.id ? "selected" : ""}`}>
              <input type="radio" name="decision" value={option.id} checked={selectedOptionId === option.id} onChange={() => setSelectedOptionId(option.id)} />
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose}>나중에 결정</button>
          <button type="button" className="primary-button" disabled={!selectedOptionId || loading} onClick={() => onResolve(selectedOptionId)}>
            {loading ? "처리 중" : "선택 적용"}
          </button>
        </div>
      </section>
    </div>
  );
}

function boardCases(data: DashboardSnapshot, column: BoardColumn["id"]) {
  return data.dashboard.cases.filter((interviewCase) => columnForCase(interviewCase) === column);
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

  const summary = data.dashboard.summary;
  const topMetrics = useMemo(() => [
    ["최종 확정 인터뷰", summary.caseCountsByStatus.CONFIRMED, "로컬에 기록된 확정 인터뷰를 일정·회의실 화면에서 확인합니다."],
    ["사용자 판단 필요", summary.openReviews + data.decisions.length, "조율 시작, 회의실 선택, 예외 판단이 필요합니다."],
    ["면접관 미응답", summary.pendingRequiredInterviewerResponses, "리마인드 또는 일정 조정이 필요할 수 있습니다."],
    ["연동 재시도", summary.pendingIntegrationRetries + summary.failedIntegrationRetries, "Slack·나인하이어 동기화 상태를 확인합니다."],
  ], [data.decisions.length, summary]);

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">HUNET RECRUITING OPS</span>
          <h1>인터뷰 어레인지 운영</h1>
        </div>
        <nav>
          <Link className="active-nav" href="/">운영 보드</Link>
          <Link href="/rooms">회의실·일정</Link>
        </nav>
        <div className={`worker-status worker-${summary.worker.status.toLowerCase()}`}>
          <span />워커 {summary.worker.status === "RUNNING" ? "정상" : summary.worker.status}
        </div>
      </header>

      <section className="metric-grid" aria-label="운영 요약">
        {topMetrics.map(([label, value, description]) => (
          <article key={String(label)} className="metric-card">
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{description}</small>
          </article>
        ))}
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="decision-inbox" aria-labelledby="decision-inbox-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ACTION INBOX</span>
            <h2 id="decision-inbox-title">지금 판단할 일</h2>
          </div>
          <button type="button" className="text-button" onClick={() => void refresh().catch((caught) => setError(caught.message))}>새로고침</button>
        </div>
        {data.decisions.length === 0 && data.reviews.length === 0 ? (
          <p className="empty-message">현재 판단 대기 항목이 없습니다.</p>
        ) : (
          <div className="inbox-grid">
            {data.decisions.map((decision) => (
              <article key={decision.id} className="review-card decision-card">
                <div>
                  <span className="review-type">선택 대기</span>
                  <strong>{decision.title}</strong>
                  <p>{decision.candidateName ?? "후보자 확인 필요"} · {decision.recruitmentName ?? "채용 확인 필요"}</p>
                  <small>{decision.prompt}</small>
                </div>
                <button type="button" className="secondary-button" onClick={() => setActiveDecision(decision)}>선택하기</button>
              </article>
            ))}
            {data.reviews.map((review) => (
              <ReviewCard key={review.id} review={review} loading={loadingId === review.id} onCreateDecision={createDecision} />
            ))}
          </div>
        )}
      </section>

      <section className="board-section" aria-labelledby="board-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">INTERVIEW JOURNEY</span>
            <h2 id="board-title">후보자별 인터뷰 조율 현황</h2>
          </div>
          <p>전형 단계와 조율 상태를 함께 확인합니다.</p>
        </div>
        <div className="kanban-board">
          {columns.map((column) => {
            const interviewCases = boardCases(data, column.id);
            const reviews = column.id === "triage" ? data.reviews : [];
            return (
              <section key={column.id} className="kanban-column">
                <header>
                  <div><h3>{column.title}</h3><span>{interviewCases.length + reviews.length}</span></div>
                  <p>{column.description}</p>
                </header>
                <div className="kanban-list">
                  {column.id === "triage" ? reviews.map((review) => (
                    <article className="pending-card" key={review.id}>
                      <span>평가 완료</span>
                      <strong>{review.candidateName ?? "후보자 확인 필요"}</strong>
                      <p>{review.currentStepName ?? "전형 단계 확인 필요"}</p>
                      <small>{review.recruitmentName ?? "채용 정보 확인 필요"}</small>
                    </article>
                  )) : null}
                  {interviewCases.map((interviewCase) => <CandidateCard key={interviewCase.id} interviewCase={interviewCase} />)}
                  {interviewCases.length === 0 && reviews.length === 0 ? <p className="column-empty">해당 항목이 없습니다.</p> : null}
                </div>
              </section>
            );
          })}
        </div>
      </section>

      <footer className="data-footer">
        마지막 데이터 생성. {new Date(data.dashboard.generatedAt).toLocaleString("ko-KR")}. 브라우저는 30초마다 로컬 운영 상태를 새로 확인합니다.
      </footer>

      {activeDecision ? <DecisionModal decision={activeDecision} loading={loadingId === activeDecision.id} onClose={() => setActiveDecision(null)} onResolve={resolveDecision} /> : null}
    </main>
  );
}
