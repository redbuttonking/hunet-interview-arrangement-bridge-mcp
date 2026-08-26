// 사용자가 요청했을 때 설치 폴더를 기준으로 Codex CLI 대화 터미널을 연다.

import { NextResponse } from "next/server";
import { openCodexConversation } from "../../../../../../../dist/src/installation/management-settings.js";

export const runtime = "nodejs";

export async function POST() {
  try {
    openCodexConversation();
    return NextResponse.json({ opened: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Codex 대화 창을 열지 못했습니다." },
      { status: 400 },
    );
  }
}
