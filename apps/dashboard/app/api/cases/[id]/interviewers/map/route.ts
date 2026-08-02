// 선택한 나인하이어 면접관과 Slack 사용자를 연결하고 해당 건을 다시 동기화한다.
import { NextResponse } from "next/server";
import { z } from "zod";
import { mapDashboardInterviewerToSlack } from "../../../../../../../../dist/src/dashboard/runtime.js";

const bodySchema = z.object({
  ninehireUserId: z.string().min(1),
  slackUserId: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().email().nullable().optional(),
});

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json());
    return NextResponse.json(await mapDashboardInterviewerToSlack({ caseId: id, ...body }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "면접관 Slack 연결을 저장하지 못했습니다." },
      { status: 400 },
    );
  }
}
