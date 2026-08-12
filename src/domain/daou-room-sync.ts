// 다우오피스 회의실 예약 자동 동기화 대상 날짜를 계산한다.
export const DAOU_ROOM_SYNC_WINDOW_DAYS = 14;

const KOREA_OFFSET_MS = 9 * 60 * 60 * 1_000;

function formatUtcDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function upcomingKoreanDates(
  now = new Date(),
  windowDays = DAOU_ROOM_SYNC_WINDOW_DAYS,
): string[] {
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new Error("DaouOffice room sync window must contain at least one day.");
  }

  const koreaNow = new Date(now.getTime() + KOREA_OFFSET_MS);
  const start = new Date(
    Date.UTC(
      koreaNow.getUTCFullYear(),
      koreaNow.getUTCMonth(),
      koreaNow.getUTCDate(),
    ),
  );

  return Array.from({ length: windowDays }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return formatUtcDate(date);
  });
}
