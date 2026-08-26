// 관리 화면에서 채용별 Slack 채널을 연결할 수 있도록 진행 중인 나인하이어 채용을 조회한다.

import { NextResponse } from "next/server";
import { listInProgressRecruitmentsForManagement } from "../../../../../../dist/src/installation/management-settings.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ recruitments: await listInProgressRecruitmentsForManagement() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "진행 중인 나인하이어 채용을 불러오지 못했습니다." },
      { status: 400 },
    );
  }
}
