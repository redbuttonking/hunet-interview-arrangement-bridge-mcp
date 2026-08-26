// 로그인한 관리자의 비밀번호를 변경하고 기존 세션을 폐기한다.

import { NextRequest, NextResponse } from "next/server";
import {
  changeDashboardPassword,
  DASHBOARD_SESSION_COOKIE,
  sessionCookieOptions,
} from "../../../../../../dist/src/installation/dashboard-auth.js";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { currentPassword?: unknown; nextPassword?: unknown };
    if (typeof body.currentPassword !== "string" || typeof body.nextPassword !== "string") {
      return NextResponse.json({ error: "현재 비밀번호와 새 비밀번호를 입력해 주세요." }, { status: 400 });
    }
    const session = await changeDashboardPassword({
      currentPassword: body.currentPassword,
      nextPassword: body.nextPassword,
    });
    if (!session) return NextResponse.json({ error: "현재 비밀번호가 올바르지 않습니다." }, { status: 401 });

    const response = NextResponse.json({ changed: true });
    response.cookies.set(DASHBOARD_SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "비밀번호를 변경하지 못했습니다." },
      { status: 400 },
    );
  }
}
