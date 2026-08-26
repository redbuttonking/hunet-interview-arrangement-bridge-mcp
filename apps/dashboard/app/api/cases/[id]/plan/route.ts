// 후보자별 통합 또는 연속 인터뷰 예외 계획을 저장한다.
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  resetDashboardCaseInterviewPlanToTemplate,
  setDashboardCaseInterviewPlan,
} from "../../../../../../../dist/src/dashboard/runtime.js";

const bodySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("COMBINED"),
    stepIds: z.array(z.string().min(1)).min(2),
    interviewerIds: z.array(z.string().uuid()).min(1),
  }),
  z.object({
    mode: z.literal("SEQUENTIAL"),
    sessions: z.array(z.object({
      stepId: z.string().min(1),
      interviewerIds: z.array(z.string().uuid()).min(1),
    })).min(2),
  }),
]);

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json());
    return NextResponse.json(await setDashboardCaseInterviewPlan({ caseId: id, ...body }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "인터뷰 예외 계획을 저장하지 못했습니다." },
      { status: 400 },
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return NextResponse.json(
      await resetDashboardCaseInterviewPlanToTemplate({ caseId: id }),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "기본 인터뷰 계획으로 되돌리지 못했습니다." },
      { status: 400 },
    );
  }
}
