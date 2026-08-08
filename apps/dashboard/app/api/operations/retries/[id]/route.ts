// 운영자가 선택한 외부 연동 재시도 작업을 다시 대기열에 넣는다.
import { NextResponse } from "next/server";
import { retryDashboardIntegrationJob } from "../../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return NextResponse.json(retryDashboardIntegrationJob(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "연동 재시도 작업을 다시 넣지 못했습니다." },
      { status: 400 },
    );
  }
}
