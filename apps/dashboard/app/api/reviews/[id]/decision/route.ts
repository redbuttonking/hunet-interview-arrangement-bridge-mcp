// 검토 건을 사용자 선택용 결정으로 바꾸는 로컬 API를 제공한다.
import { NextResponse } from "next/server";
import { createDashboardReviewDecision } from "../../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await createDashboardReviewDecision(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "결정을 만들 수 없습니다." },
      { status: 400 },
    );
  }
}
