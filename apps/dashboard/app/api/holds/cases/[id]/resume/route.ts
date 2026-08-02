// 보류한 인터뷰 조율 건을 이전 로컬 상태로 되돌린다.
import { NextResponse } from "next/server";
import { resumeDashboardHeldCase } from "../../../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await resumeDashboardHeldCase(id));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "보류한 조율을 다시 시작할 수 없습니다." },
      { status: 400 },
    );
  }
}
