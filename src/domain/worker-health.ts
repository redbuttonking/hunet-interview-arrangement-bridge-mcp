// 로컬 Slack 워커의 상태 감지 기준을 정의한다.
export const INTERVIEW_BRIDGE_WORKER_KEY = "INTERVIEW_BRIDGE_WORKER";
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
export const WORKER_DOWNTIME_THRESHOLD_MS = 90_000;
// 중복 실행된 워커가 같은 외부 작업을 처리하지 못하도록 보유하는 임대 시간이다.
export const WORKER_LEASE_DURATION_MS = 75_000;
