// 대시보드에서 외부 연동 데이터를 발송 없이 즉시 다시 읽는다.
import { NextResponse } from "next/server";
import { refreshDashboardExternalData } from "../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function POST() {
  try {
    return NextResponse.json(await refreshDashboardExternalData());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "외부 데이터를 업데이트하지 못했습니다." },
      { status: 400 },
    );
  }
}
