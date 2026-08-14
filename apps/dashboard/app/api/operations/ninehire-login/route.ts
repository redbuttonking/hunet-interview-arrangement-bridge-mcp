// 나인하이어 자동화 전용 Chrome 프로필의 로그인 창을 연다.
import { NextResponse } from "next/server";
import { openDashboardNinehireLogin } from "../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function POST() {
  try {
    return NextResponse.json(await openDashboardNinehireLogin());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "나인하이어 로그인 창을 열지 못했습니다." },
      { status: 500 },
    );
  }
}
