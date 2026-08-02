// 인터뷰 조율 업무 이력의 기술 코드를 한국어 설명으로 변환한다.
const eventLabels: Record<string, string> = {
  CASE_CREATED: "인터뷰 조율 건을 만들었습니다.",
  TEMPLATE_INTERVIEW_ROUTE_APPLIED: "채용 인터뷰 규칙을 적용했습니다.",
  CANDIDATE_COMBINED_INTERVIEW_CONFIGURED: "후보자 통합 인터뷰 계획을 설정했습니다.",
  CANDIDATE_SEQUENTIAL_INTERVIEW_CONFIGURED: "후보자 연속 인터뷰 계획을 설정했습니다.",
  INTERVIEWER_ADDED: "면접관을 등록했습니다.",
  INTERVIEWER_REMOVED_UPSTREAM: "나인하이어 기준에서 제외된 면접관을 정리했습니다.",
  INTERVIEWER_EXCLUDED: "면접관을 조율 대상에서 제외했습니다.",
  INTERVIEWER_REQUIREMENT_CHANGED: "면접관 필수 여부를 변경했습니다.",
  AVAILABILITY_SUBMITTED: "면접관이 가능한 일정을 제출했습니다.",
  AVAILABILITY_MANUALLY_RECORDED: "면접관 가능한 일정을 직접 기록했습니다.",
  DRAFT_CREATED: "Slack 메시지 초안을 만들었습니다.",
  DRAFT_TEXT_REVISED: "Slack 메시지 초안을 수정했습니다.",
  DRAFT_CANCELLED: "Slack 메시지 초안을 취소했습니다.",
  REQUEST_SENT: "면접관에게 일정 요청을 발송했습니다.",
  ROOM_ALLOCATED: "인터뷰 회의실 시간을 배정했습니다.",
  SEQUENTIAL_ROOMS_ALLOCATED: "연속 인터뷰 회의실 시간을 배정했습니다.",
  INTERNAL_SCHEDULE_CONFIRMED: "내부 인터뷰 일정을 확정했습니다.",
  SEQUENTIAL_INTERNAL_SCHEDULE_CONFIRMED: "내부 연속 인터뷰 일정을 확정했습니다.",
  CANDIDATE_SCHEDULE_CONFIRMED: "후보자가 인터뷰 일정을 확정했습니다.",
  CONFIRMED_SCHEDULE_ROOM_RECORDED: "확정된 인터뷰의 회의실을 기록했습니다.",
  MANUAL_INTERVIEW_CONFIRMED: "나인하이어에서 확정한 인터뷰를 기록했습니다.",
  SCHEDULE_REOPENED: "일정 재조율을 시작했습니다.",
  INTERVIEW_CANCELLED: "인터뷰 조율을 취소했습니다.",
  INTERVIEW_ARRANGEMENT_HELD: "인터뷰 조율을 보류했습니다.",
  INTERVIEW_ARRANGEMENT_RESUMED: "보류한 인터뷰 조율을 다시 시작했습니다.",
  SCHEDULE_CONFIRMATION_SENT: "면접관에게 확정 일정을 안내했습니다.",
  SCHEDULE_UPDATE_SENT: "면접관에게 일정 변경 사항을 안내했습니다.",
  CANDIDATE_INTERVIEW_ABSENCE_HELD: "후보자 불참 검토를 보류했습니다.",
};

const actorLabels: Record<string, string> = {
  USER: "사용자",
  SYSTEM: "시스템",
  SLACK_USER: "Slack 사용자",
  NINEHIRE: "나인하이어",
  NINEHIRE_SLACK: "나인하이어 알림",
};

export function activityEventLabel(eventType: string): string {
  return eventLabels[eventType] ?? "인터뷰 조율 업무 이력을 기록했습니다.";
}

export function activityActorLabel(actor: string): string {
  return actorLabels[actor] ?? actor;
}
