// 대시보드 화면과 API를 단일 관리자 세션으로 보호한다.

import { NextRequest, NextResponse } from "next/server";
import {
  DASHBOARD_SESSION_COOKIE,
  validateDashboardSession,
} from "../../dist/src/installation/dashboard-auth.js";

const PUBLIC_PATHS = new Set([
  "/login",
  "/icon.svg",
  "/favicon.ico",
  "/hunet-logotype-red.png",
  "/hunet-symboltype-red.png",
]);

function isMutation(request: NextRequest): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
}

function hasSameOrigin(request: NextRequest): boolean {
  return request.headers.get("origin") === request.nextUrl.origin;
}

function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

function unauthorized(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return applySecurityHeaders(NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }));
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return applySecurityHeaders(NextResponse.redirect(loginUrl));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/_next/") || PUBLIC_PATHS.has(pathname)) {
    return applySecurityHeaders(NextResponse.next());
  }

  if (pathname === "/api/auth/login") {
    if (isMutation(request) && !hasSameOrigin(request)) {
      return applySecurityHeaders(NextResponse.json({ error: "허용되지 않은 요청입니다." }, { status: 403 }));
    }
    return applySecurityHeaders(NextResponse.next());
  }

  const sessionToken = request.cookies.get(DASHBOARD_SESSION_COOKIE)?.value;
  if (!validateDashboardSession(sessionToken)) return unauthorized(request);

  if (pathname.startsWith("/api/") && isMutation(request) && !hasSameOrigin(request)) {
    return applySecurityHeaders(NextResponse.json({ error: "허용되지 않은 요청입니다." }, { status: 403 }));
  }

  return applySecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
