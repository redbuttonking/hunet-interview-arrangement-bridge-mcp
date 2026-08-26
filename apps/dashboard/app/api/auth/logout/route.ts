// 현재 관리자 세션을 폐기한다.

import { NextRequest, NextResponse } from "next/server";
import {
  DASHBOARD_SESSION_COOKIE,
  revokeDashboardSession,
} from "../../../../../../dist/src/installation/dashboard-auth.js";

export const runtime = "nodejs";

export function POST(request: NextRequest) {
  revokeDashboardSession(request.cookies.get(DASHBOARD_SESSION_COOKIE)?.value);
  const response = NextResponse.json({ signedOut: true });
  response.cookies.set(DASHBOARD_SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", expires: new Date(0) });
  return response;
}
