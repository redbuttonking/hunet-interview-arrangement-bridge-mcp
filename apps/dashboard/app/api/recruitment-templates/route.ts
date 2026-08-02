// 채용 인터뷰 규칙을 사용자 승인 뒤 로컬 운영 규칙으로 저장한다.
import { NextResponse } from "next/server";
import { z } from "zod";
import { approveDashboardRecruitmentInterviewTemplate } from "../../../../../dist/src/dashboard/runtime.js";

const bodySchema = z.object({
  recruitmentId: z.string().trim().min(1),
  reviewId: z.string().trim().min(1).nullable().optional(),
  steps: z.array(z.object({
    stepId: z.string().trim().min(1),
    mode: z.enum(["STANDARD", "COMBINED"]),
    durationMinutes: z.number().int().min(15).max(480),
  })).min(1),
});

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    return NextResponse.json(
      await approveDashboardRecruitmentInterviewTemplate(body),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "인터뷰 규칙을 저장하지 못했습니다." },
      { status: 400 },
    );
  }
}
