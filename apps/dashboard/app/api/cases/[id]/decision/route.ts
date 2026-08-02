// 후보자 상태에 맞는 반복 조율 선택지를 만드는 로컬 API다.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createDashboardCaseDecision } from "../../../../../../../dist/src/dashboard/runtime.js";

const bodySchema = z.object({
  skillKey: z.enum(["AVAILABILITY_COLLECTION", "INTERVIEW_SCHEDULING"]),
});

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json());
    const decision = await createDashboardCaseDecision({ caseId: id, skillKey: body.skillKey });
    return NextResponse.json({ decision });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "선택지를 만들 수 없습니다." },
      { status: 400 },
    );
  }
}
