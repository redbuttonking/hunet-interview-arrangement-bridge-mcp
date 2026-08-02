// 보류한 후보자 조율 검토를 다시 열고 선택지를 반환한다.
import { NextResponse } from "next/server";
import { resumeDashboardHeldReview } from "../../../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await resumeDashboardHeldReview(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "보류한 조율을 다시 시작할 수 없습니다." },
      { status: 400 },
    );
  }
}
