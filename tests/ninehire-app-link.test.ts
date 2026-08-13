// 나인하이어 후보자 상세 링크의 대상 검증을 확인한다.

import { describe, expect, it } from "vitest";
import { buildNinehireCandidateUrl } from "../src/ninehire/app-link.js";

const recruitmentId = "a4e11650-491d-11f1-8c2c-b95ae0c9738d";
const applicantProgressId = "34fe0661-96eb-11f1-9ddd-d1df5dfa8b2b";

describe("buildNinehireCandidateUrl", () => {
  it("채용과 후보자 ID로 나인하이어 후보자 상세 링크를 만든다", () => {
    expect(buildNinehireCandidateUrl({
      appUrl: "https://app.ninehire.com/kMvNxpDB",
      recruitmentRef: recruitmentId,
      candidateRef: applicantProgressId,
    })).toBe(`https://app.ninehire.com/kMvNxpDB/recruitment/${recruitmentId}/applicants?applicantProgressId=${applicantProgressId}&pagination=kanvan`);
  });

  it("나인하이어 원본 링크에서도 채용과 후보자 ID를 추출한다", () => {
    expect(buildNinehireCandidateUrl({
      appUrl: "https://app.ninehire.com/kMvNxpDB",
      recruitmentRef: `https://app.ninehire.com/kMvNxpDB/recruitment/${recruitmentId}/applicants`,
      candidateRef: `https://app.ninehire.com/kMvNxpDB/recruitment/${recruitmentId}/applicants?applicantProgressId=${applicantProgressId}&pagination=kanvan`,
    })).toBe(`https://app.ninehire.com/kMvNxpDB/recruitment/${recruitmentId}/applicants?applicantProgressId=${applicantProgressId}&pagination=kanvan`);
  });

  it("안전하지 않은 작업공간 주소나 누락된 ID에는 링크를 만들지 않는다", () => {
    expect(buildNinehireCandidateUrl({
      appUrl: "https://example.com/kMvNxpDB",
      recruitmentRef: recruitmentId,
      candidateRef: applicantProgressId,
    })).toBeUndefined();
    expect(buildNinehireCandidateUrl({
      appUrl: "https://app.ninehire.com/kMvNxpDB",
      recruitmentRef: recruitmentId,
      candidateRef: "candidate-name",
    })).toBeUndefined();
  });
});
