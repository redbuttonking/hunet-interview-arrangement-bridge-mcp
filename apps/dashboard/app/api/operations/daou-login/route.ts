// 다우오피스 전용 브라우저를 열어 사용자가 직접 로그인할 수 있게 한다.
import { NextResponse } from "next/server";
import { openDashboardDaouOfficeLogin } from "../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function POST() {
  try {
    return NextResponse.json(await openDashboardDaouOfficeLogin());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "다우오피스 로그인 창을 열지 못했습니다." },
      { status: 400 },
    );
  }
}
