// 선택한 나인하이어 채용과 Slack 면접관 일정 요청 채널의 로컬 매핑을 저장한다.

import { NextResponse } from "next/server";
import { saveRecruitmentChannelMapping } from "../../../../../../dist/src/installation/management-settings.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      recruitmentId?: unknown;
      recruitmentName?: unknown;
      channelId?: unknown;
    };
    if (
      typeof body.recruitmentId !== "string"
      || typeof body.recruitmentName !== "string"
      || typeof body.channelId !== "string"
    ) {
      return NextResponse.json({ error: "채용과 Slack 채널 ID를 확인해 주세요." }, { status: 400 });
    }
    return NextResponse.json(await saveRecruitmentChannelMapping({
      recruitmentId: body.recruitmentId,
      recruitmentName: body.recruitmentName,
      channelId: body.channelId,
    }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "채용별 채널을 저장하지 못했습니다." },
      { status: 400 },
    );
  }
}
