// 현재 Windows 사용자 계정의 Codex 설정에 인터뷰 브릿지 MCP만 안전하게 등록한다.

import { NextResponse } from "next/server";
import { connectCodexMcpServer } from "../../../../../../../dist/src/installation/management-settings.js";

export const runtime = "nodejs";

export async function POST() {
  try {
    return NextResponse.json(await connectCodexMcpServer());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Codex MCP 연결을 설정하지 못했습니다." },
      { status: 500 },
    );
  }
}
