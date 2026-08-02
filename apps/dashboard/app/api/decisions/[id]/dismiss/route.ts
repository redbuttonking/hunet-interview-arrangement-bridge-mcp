// 제출하지 않고 닫은 대시보드 선택지를 로컬 대기 목록에서 제거한다.
import { NextResponse } from "next/server";
import { dismissDashboardDecision } from "../../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const dismissed = await dismissDashboardDecision(id);
    return NextResponse.json({ dismissed });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "선택지를 닫을 수 없습니다." },
      { status: 400 },
    );
  }
}
