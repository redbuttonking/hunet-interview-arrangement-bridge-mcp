// 대시보드에서 연동 상태와 자동 재시도 대기열을 안전하게 조회한다.
import { NextResponse } from "next/server";
import { getDashboardOperationalReadiness } from "../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const checkExternal = new URL(request.url).searchParams.get("external") === "true";
    return NextResponse.json(await getDashboardOperationalReadiness({ checkExternal }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "운영 연동 상태를 확인하지 못했습니다." },
      { status: 400 },
    );
  }
}
