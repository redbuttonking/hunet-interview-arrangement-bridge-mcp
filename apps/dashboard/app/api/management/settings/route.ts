// 설치형 앱의 비밀값을 노출하지 않고 사용자별 운영 설정을 조회하고 저장한다.

import { NextResponse } from "next/server";
import {
  getManagementSettings,
  saveManagementSettings,
} from "../../../../../../dist/src/installation/management-settings.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await getManagementSettings());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "관리 설정을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      slackSourceChannelId?: unknown;
    };
    if (typeof body.slackSourceChannelId !== "string") {
      return NextResponse.json({ error: "나인하이어 알림 채널 ID를 입력해 주세요." }, { status: 400 });
    }
    return NextResponse.json(await saveManagementSettings({
      slackSourceChannelId: body.slackSourceChannelId,
    }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "관리 설정을 저장하지 못했습니다." },
      { status: 400 },
    );
  }
}
