// 후보자별 인터뷰 조율 여정과 다음 운영 행동을 보여준다.
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCaseDetail } from "../../lib/data";

export const dynamic = "force-dynamic";

const journeySteps = ["조율 시작", "면접관 일정", "시간·회의실", "후보자 응답", "최종 확정"];

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
    CANCELLED: "취소",
    CLOSED: "종료",
  };
  return labels[status] ?? status;
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
    READY_FOR_DRAFT: { title: "인터뷰 조율 시작 여부를 확인하세요.", description: "운영 보드의 사용자 판단 항목에서 인터뷰 유형을 선택합니다." },
    DRAFT_CREATED: { title: "면접관 일정 요청 초안을 검토하세요.", description: "초안을 승인하기 전에는 Slack 메시지가 발송되지 않습니다." },
    READY_TO_SCHEDULE: { title: "추천 시간과 회의실을 선택하세요.", description: "면접관 가용시간과 다우오피스 회의실 블록을 함께 확인합니다." },
    AWAITING_CANDIDATE_CONFIRMATION: { title: "후보자의 일정 확답을 기다리고 있습니다.", description: "나인하이어에서 후보자가 확정하면 로컬 운영 상태에 반영됩니다." },
    CONFIRMED: { title: "인터뷰가 최종 확정되었습니다.", description: "면접관 안내 메시지 발송 여부와 일정 정보를 확인하세요." },
    REVIEW_REQUIRED: { title: "예외 상황을 확인하고 다음 조치를 결정하세요.", description: "자동 처리하지 않은 사유를 검토한 뒤 조율·보류·취소 중 하나를 선택합니다." },
    CANCELLED: { title: "인터뷰 조율이 취소된 상태입니다.", description: "다우오피스의 기존 회의실 예약 블록은 그대로 유지됩니다." },
  };
  if (["REQUEST_SENT", "COLLECTING_AVAILABILITY"].includes(status)) {
    return {
      title: pendingResponses > 0 ? `필수 면접관 ${pendingResponses}명의 응답을 기다리고 있습니다.` : "면접관 응답을 확인하고 있습니다.",
      description: "미응답이 지속되면 리마인드 또는 재수집 여부를 운영 보드에서 판단합니다.",
    };
  }
  return actions[status] ?? { title: "현재 상태를 확인하세요.", description: "운영 보드에서 필요한 다음 작업을 확인합니다." };
}

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = loadCaseDetail(id);
  if (!data) notFound();
  const { bundle, plan, events } = data;
  const interviewCase = bundle.interviewCase;
  const currentJourneyIndex = journeyIndex(interviewCase.status);
  const action = nextAction(interviewCase.status, bundle.interviewers.filter((interviewer) => interviewer.required && interviewer.status === "PENDING").length);
  const interviewType = plan
    ? `${plan.mode === "COMBINED" ? "통합" : plan.mode === "SEQUENTIAL" ? "연속" : "단일"} · ${plan.stepNames.join(plan.mode === "SEQUENTIAL" ? " → " : " + ")}`
    : "인터뷰 유형 확인 필요";

  return (
    <main className="ops-shell case-page">
      <header className="app-header">
        <Link className="brand" href="/"><span className="brand-mark">H</span><span>HUNET <b>OPS</b></span></Link>
        <nav className="primary-nav" aria-label="대시보드 메뉴">
          <Link className="active" href="/">운영</Link>
          <Link href="/rooms">회의실</Link>
        </nav>
      </header>

      <header className="case-header">
        <Link className="back-link" href="/"><span>←</span> 운영 보드</Link>
        <div className="case-hero">
          <div>
            <span className="section-kicker">CANDIDATE OVERVIEW</span>
            <h1>{interviewCase.candidateName ?? "후보자 확인 필요"}</h1>
            <p>{interviewCase.recruitmentName ?? "채용 정보 확인 필요"}</p>
          </div>
          <span className="case-status">{statusLabel(interviewCase.status)}</span>
        </div>
      </header>

      <section className="journey-card">
        <span className="section-kicker">INTERVIEW JOURNEY</span>
        <h2>전형과 조율 진행 상태</h2>
        <ol className="journey-steps">
          {journeySteps.map((step, index) => {
            const state = index < currentJourneyIndex ? "completed" : index === currentJourneyIndex ? "current" : "";
            return <li key={step} className={state}><span>{index + 1}</span><strong>{step}</strong></li>;
          })}
        </ol>
        <p className="journey-summary">{interviewType} · {plan?.durationMinutes ?? interviewCase.durationMinutes}분 인터뷰.</p>
        <div className="case-next-action">
          <span>NEXT ACTION</span>
          <strong>{action.title}</strong>
          <p>{action.description}</p>
        </div>
      </section>

      <div className="case-detail-grid">
        <section className="case-section">
          <span className="section-kicker">INTERVIEW DETAILS</span>
          <h2>인터뷰 요약</h2>
          <dl>
            <div><dt>인터뷰 유형</dt><dd>{interviewType}</dd></div>
            <div><dt>소요 시간</dt><dd>{plan?.durationMinutes ?? interviewCase.durationMinutes}분</dd></div>
            <div><dt>일정</dt><dd>{interviewCase.scheduledDate ? `${interviewCase.scheduledDate} ${interviewCase.scheduledStartTime}–${interviewCase.scheduledEndTime}` : "아직 내부 확정된 일정이 없습니다."}</dd></div>
            <div><dt>회의실</dt><dd>{interviewCase.scheduledRoomName ?? "회의실 선택 또는 확인 필요"}</dd></div>
          </dl>
        </section>

        <section className="case-section">
          <span className="section-kicker">INTERVIEWERS</span>
          <h2>면접관 일정 제출</h2>
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

        <section className="case-section">
          <span className="section-kicker">SLACK MESSAGES</span>
          <h2>안내 메시지 상태</h2>
          <div className="draft-list">
            {bundle.drafts.map((draft) => (
              <div key={draft.id} className="draft-row"><div><strong>{draft.messageType}</strong><small>{formatDateTime(draft.createdAt)}</small></div><span>{draft.status}</span></div>
            ))}
            {bundle.drafts.length === 0 ? <p className="empty-message">생성된 Slack 초안이 없습니다.</p> : null}
          </div>
        </section>

        <section className="case-section">
          <span className="section-kicker">ACTIVITY LOG</span>
          <h2>업무 이력</h2>
          <ol className="event-list">
            {events.map((event) => <li key={event.id}><span>{formatDateTime(event.createdAt)}</span><strong>{event.eventType}</strong><small>{event.actor}</small></li>)}
            {events.length === 0 ? <p className="empty-message">기록된 업무 이력이 없습니다.</p> : null}
          </ol>
        </section>
      </div>
    </main>
  );
}
