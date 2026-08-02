// 사용자가 검토한 Slack 초안을 승인 후 발송하는 로컬 API다.

import { NextResponse } from "next/server";
import { approveDashboardDraft } from "../../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const draft = await approveDashboardDraft(id);
    return NextResponse.json({ draft });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Slack 메시지를 발송할 수 없습니다." },
      { status: 400 },
    );
  }
}
