// 사용자가 선택한 운영 결정을 기존 업무 서비스에 적용한다.
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveDashboardDecision } from "../../../../../../dist/src/dashboard/runtime.js";

const bodySchema = z.object({
  optionId: z.string().min(1),
  note: z.string().trim().max(500).optional(),
});

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json());
    const outcome = await resolveDashboardDecision({
      decisionId: id,
      optionId: body.optionId,
      ...(body.note ? { note: body.note } : {}),
    });
    return NextResponse.json(outcome);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "결정을 처리할 수 없습니다." },
      { status: 400 },
    );
  }
}
