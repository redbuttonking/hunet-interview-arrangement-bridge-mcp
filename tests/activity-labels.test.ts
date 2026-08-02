// 업무 이력 한국어 표기 규칙을 검증한다.
import { describe, expect, it } from "vitest";
import { activityActorLabel, activityEventLabel } from "../apps/dashboard/app/lib/activity-labels.js";

describe("activity labels", () => {
  it("translates a known activity code into a Korean explanation", () => {
    expect(activityEventLabel("TEMPLATE_INTERVIEW_ROUTE_APPLIED")).toBe(
      "채용 인터뷰 규칙을 적용했습니다.",
    );
    expect(activityActorLabel("USER")).toBe("사용자");
  });

  it("keeps an unknown activity identifiable with a Korean fallback", () => {
    expect(activityEventLabel("UNKNOWN_EVENT")).toBe(
      "인터뷰 조율 업무 이력을 기록했습니다.",
    );
  });
});
