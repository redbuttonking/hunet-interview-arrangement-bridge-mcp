// 외부 연동 오류의 재시도 대기열 기준을 정의한다.
export type IntegrationRetryJobType =
  | "NINEHIRE_EVALUATION_LOOKUP"
  | "NINEHIRE_SCHEDULE_RECONCILIATION"
  | "SLACK_NOTIFICATION_RECONCILIATION"
  | "DAOU_CALENDAR_RECONCILIATION";

export const INTEGRATION_RETRY_INITIAL_DELAY_MS = 60_000;
export const INTEGRATION_RETRY_MAX_ATTEMPTS = 3;
export const INTEGRATION_RETRY_POLL_INTERVAL_MS = 30_000;
export const NINEHIRE_RATE_LIMIT_UNTIL_CURSOR = "ninehire:rate_limit_until";

export function retryDelayMs(attemptCount: number): number {
  return INTEGRATION_RETRY_INITIAL_DELAY_MS * 2 ** (attemptCount - 1);
}

export function isNinehireEvaluationRateLimitError(message: string): boolean {
  return /(?:000132|API\s*요청\s*한도를\s*초과|rate\s*limit|too\s*many\s*requests)/iu.test(message);
}

export const isNinehireRateLimitError = isNinehireEvaluationRateLimitError;
