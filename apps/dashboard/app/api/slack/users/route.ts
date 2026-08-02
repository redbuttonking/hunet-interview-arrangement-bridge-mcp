// 이름이나 이메일로 Slack 사용자를 검색해 면접관 연결에 사용한다.
import { NextResponse } from "next/server";
import { searchDashboardSlackUsers } from "../../../../../../dist/src/dashboard/runtime.js";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("query") ?? "";
    return NextResponse.json({ users: await searchDashboardSlackUsers(query) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Slack 사용자를 검색하지 못했습니다." },
      { status: 400 },
    );
  }
}
