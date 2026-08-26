// 관리자 로그인 요청을 검증하고 안전한 세션 쿠키를 발급한다.

import { NextRequest, NextResponse } from "next/server";
import {
  authenticateDashboardAdmin,
  clearDashboardLoginFailures,
  DASHBOARD_SESSION_COOKIE,
  getDashboardLoginRetryAfterMs,
  recordDashboardLoginFailure,
  sessionCookieOptions,
} from "../../../../../../dist/src/installation/dashboard-auth.js";

export const runtime = "nodejs";

function clientKey(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

export async function POST(request: NextRequest) {
  const key = clientKey(request);
  const retryAfterMs = getDashboardLoginRetryAfterMs(key);
  if (retryAfterMs > 0) {
    return NextResponse.json(
      { error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1_000)) } },
    );
  }

  try {
    const body = await request.json() as { email?: unknown; password?: unknown };
    if (typeof body.email !== "string" || typeof body.password !== "string") {
      recordDashboardLoginFailure(key);
      return NextResponse.json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." }, { status: 401 });
    }

    const session = await authenticateDashboardAdmin({ email: body.email, password: body.password });
    if (!session) {
      recordDashboardLoginFailure(key);
      return NextResponse.json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." }, { status: 401 });
    }

    clearDashboardLoginFailures(key);
    const response = NextResponse.json({ authenticated: true });
    response.cookies.set(DASHBOARD_SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
    return response;
  } catch {
    recordDashboardLoginFailure(key);
    return NextResponse.json({ error: "로그인 요청을 처리하지 못했습니다." }, { status: 400 });
  }
}
