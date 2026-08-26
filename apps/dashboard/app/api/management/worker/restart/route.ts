// 저장한 설치형 앱 설정을 반영하도록 Windows 작업 스케줄러의 워커를 다시 시작한다.

import { NextResponse } from "next/server";
import { restartManagedWorker } from "../../../../../../../dist/src/installation/management-settings.js";

export const runtime = "nodejs";

export async function POST() {
  try {
    await restartManagedWorker();
    return NextResponse.json({ restarted: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "워커를 다시 시작하지 못했습니다." },
      { status: 400 },
    );
  }
}
