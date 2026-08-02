// 지정한 인터뷰 건의 제안 날짜에 대해 다우오피스 회의실 블록을 동기화한다.
import { NextResponse } from "next/server";
import { syncDashboardDaouMeetingRooms } from "../../../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await syncDashboardDaouMeetingRooms(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "회의실 예약 정보를 동기화하지 못했습니다." },
      { status: 400 },
    );
  }
}
