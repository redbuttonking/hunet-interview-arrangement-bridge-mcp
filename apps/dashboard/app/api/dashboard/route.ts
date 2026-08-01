// 대시보드 화면 갱신용 로컬 운영 현황 API를 제공한다.
import { NextResponse } from "next/server";
import { loadDashboardSnapshot } from "../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(loadDashboardSnapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}
