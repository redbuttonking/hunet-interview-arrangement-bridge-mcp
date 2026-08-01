// 후보자별 인터뷰 조율 여정과 업무 이력을 보여준다.
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCaseDetail } from "../../lib/data";

export const dynamic = "force-dynamic";

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
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

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = loadCaseDetail(id);
  if (!data) notFound();
  const { bundle, plan, events } = data;
  const interviewCase = bundle.interviewCase;
  const journey = ["평가 완료", ...(plan?.stepNames ?? ["인터뷰 계획 확인"]), "최종 확정"];

  return (
    <main className="dashboard-shell case-page">
      <header className="case-header">
        <Link className="back-link" href="/">← 운영 보드</Link>
        <div className="case-header__title">
          <div>
            <span className="eyebrow">CANDIDATE JOURNEY</span>
            <h1>{interviewCase.candidateName ?? "후보자 확인 필요"}</h1>
            <p>{interviewCase.recruitmentName ?? "채용 정보 확인 필요"}</p>
          </div>
          <span className="detail-status">{interviewCase.status}</span>
        </div>
      </header>

      <section className="journey-card">
        <div className="section-heading"><div><span className="eyebrow">INTERVIEW FLOW</span><h2>전형과 조율 진행 상태</h2></div></div>
        <ol className="journey-steps">
          {journey.map((step, index) => {
            const isLast = index === journey.length - 1;
            const isCurrent = !isLast && index === journey.length - 2;
            return <li key={`${step}-${index}`} className={isCurrent ? "current" : "completed"}><span>{index + 1}</span><strong>{step}</strong></li>;
          })}
        </ol>
        <p className="journey-summary">
          {plan
            ? `${plan.mode === "COMBINED" ? "통합" : plan.mode === "SEQUENTIAL" ? "연속" : "단일"} 인터뷰 · ${plan.durationMinutes}분.`
            : "인터뷰 유형과 소요시간 확인이 필요합니다."}
        </p>
      </section>

      <div className="detail-grid">
        <section className="detail-card schedule-detail">
          <span className="eyebrow">SCHEDULE</span><h2>일정·회의실</h2>
          {interviewCase.scheduledDate ? (
            <dl>
              <div><dt>일정</dt><dd>{interviewCase.scheduledDate} {interviewCase.scheduledStartTime}~{interviewCase.scheduledEndTime}</dd></div>
              <div><dt>회의실</dt><dd>{interviewCase.scheduledRoomName ?? "회의실 선택 또는 확인 필요"}</dd></div>
              <div><dt>상태</dt><dd>{interviewCase.status}</dd></div>
            </dl>
          ) : <p className="empty-message">아직 내부 확정된 일정이 없습니다.</p>}
        </section>

        <section className="detail-card">
          <span className="eyebrow">INTERVIEWERS</span><h2>면접관 일정 제출</h2>
          <div className="interviewer-list">
            {bundle.interviewers.map((interviewer) => (
              <div key={interviewer.id} className="interviewer-row">
                <div><strong>{interviewer.displayName}</strong><small>{interviewer.required ? "필수 면접관" : "선택 면접관"}</small></div>
                <span className={`interviewer-status interviewer-${interviewer.status.toLowerCase()}`}>{interviewerStatus(interviewer.status)}</span>
              </div>
            ))}
            {bundle.interviewers.length === 0 ? <p className="empty-message">동기화된 면접관이 없습니다.</p> : null}
          </div>
        </section>

        <section className="detail-card">
          <span className="eyebrow">MESSAGES</span><h2>Slack 안내 상태</h2>
          <div className="draft-list">
            {bundle.drafts.map((draft) => (
              <div key={draft.id} className="draft-row"><div><strong>{draft.messageType}</strong><small>{formatDateTime(draft.createdAt)}</small></div><span>{draft.status}</span></div>
            ))}
            {bundle.drafts.length === 0 ? <p className="empty-message">생성된 Slack 초안이 없습니다.</p> : null}
          </div>
        </section>

        <section className="detail-card">
          <span className="eyebrow">ACTIVITY</span><h2>업무 이력</h2>
          <ol className="event-list">
            {events.map((event) => <li key={event.id}><span>{formatDateTime(event.createdAt)}</span><strong>{event.eventType}</strong><small>{event.actor}</small></li>)}
            {events.length === 0 ? <p className="empty-message">기록된 업무 이력이 없습니다.</p> : null}
          </ol>
        </section>
      </div>
    </main>
  );
}
