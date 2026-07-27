// 외부 연동 오류의 재시도 대기열 기준을 정의한다.
export type IntegrationRetryJobType =
  | "NINEHIRE_EVALUATION_LOOKUP"
  | "SLACK_NOTIFICATION_RECONCILIATION";

export const INTEGRATION_RETRY_INITIAL_DELAY_MS = 60_000;
export const INTEGRATION_RETRY_MAX_ATTEMPTS = 3;
export const INTEGRATION_RETRY_POLL_INTERVAL_MS = 30_000;

export function retryDelayMs(attemptCount: number): number {
  return INTEGRATION_RETRY_INITIAL_DELAY_MS * 2 ** (attemptCount - 1);
}
