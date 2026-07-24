import type {
  CandidateContext,
  EvaluationLookup,
  EvaluationSummary,
  InterviewerLookup,
  NinehireInterviewer,
} from "../domain/types.js";
import { NinehireMcpGateway } from "./gateway.js";

export interface NinehireWorkflowAdapter {
  lookupCompletedEvaluation(
    context: CandidateContext,
  ): Promise<EvaluationLookup>;
  listInterviewers(context: CandidateContext): Promise<InterviewerLookup>;
}

export function upstreamPayload(result: Record<string, unknown>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content;
  if (!Array.isArray(content)) return result;
  const text = content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).type === "text" &&
        typeof (item as Record<string, unknown>).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
  if (!text) return result;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
      })
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalized(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ko-KR");
}

function sameText(left: unknown, right: unknown): boolean {
  return normalized(left) === normalized(right);
}

function identifierFromReference(reference?: string): string | undefined {
  if (!reference) return undefined;
  try {
    const url = new URL(reference);
    return url.pathname.split("/").filter(Boolean).at(-1);
  } catch {
    return reference.includes("/") ? undefined : reference;
  }
}

function codeOf(value: unknown): string | undefined {
  return text(asRecord(value)?.code);
}

function nameOf(value: unknown): string | undefined {
  return text(asRecord(value)?.name);
}

function uniqueRecord(
  values: Record<string, unknown>[],
  description: string,
): { value?: Record<string, unknown>; reason?: string } {
  if (values.length === 1) return { value: values[0] };
  if (values.length === 0) {
    return { reason: `${description}을(를) 찾지 못했습니다.` };
  }
  return { reason: `${description}이(가) ${values.length}건으로 중복됩니다.` };
}

function summarizeCompletedScoreSheets(
  detail: Record<string, unknown>,
  recruitmentId: string,
): EvaluationSummary | undefined {
  const applicantProgressId = text(detail.applicantProgressId);
  if (!applicantProgressId) return undefined;
  const scoreSheets = records(detail.scoreSheets)
    .filter((sheet) => codeOf(sheet.status) === "done")
    .map((sheet) => {
      const evaluators = records(sheet.scorings).map((scoring) => ({
        name: text(asRecord(scoring.user)?.name) ?? "이름 미확인 평가자",
        ...(text(scoring.createdAt)
          ? { submittedAt: text(scoring.createdAt) }
          : {}),
        ...(text(scoring.comment) ? { comment: text(scoring.comment) } : {}),
        items: records(scoring.items).map((item) => ({
          title: text(item.title) ?? "제목 없는 평가 항목",
          finalEvaluation: item.finalEvaluation === true,
          selectedOptions: records(item.options)
            .filter((option) => option.checked === true)
            .map((option) => ({
              title: text(option.title) ?? "선택값 미확인",
              ...(typeof option.score === "number" ? { score: option.score } : {}),
            })),
          ...(text(item.comment) ? { comment: text(item.comment) } : {}),
        })),
      }));
      return {
        scoreSheetId: text(sheet.scoreSheetId) ?? "ID 미확인 평가표",
        title: text(sheet.title) ?? "제목 없는 평가표",
        ...(nameOf(sheet.evaluationMethod)
          ? { evaluationMethod: nameOf(sheet.evaluationMethod) }
          : {}),
        ...(text(sheet.doneAt) ? { completedAt: text(sheet.doneAt) } : {}),
        participants: records(sheet.participants)
          .map((participant) => text(participant.name))
          .filter((name): name is string => Boolean(name)),
        evaluators,
      };
    });
  if (scoreSheets.length === 0) return undefined;
  return { applicantProgressId, recruitmentId, scoreSheets };
}

export class NinehireRecruitmentWorkflowAdapter
  implements NinehireWorkflowAdapter
{
  constructor(
    private readonly gateway: Pick<NinehireMcpGateway, "callTool">,
  ) {}

  async lookupCompletedEvaluation(
    context: CandidateContext,
  ): Promise<EvaluationLookup> {
    if (!context.candidateName || !context.recruitmentName) {
      return {
        reason:
          "Slack 알림에서 지원자 이름 또는 채용명을 찾지 못해 평가표를 조회할 수 없습니다.",
      };
    }
    const recruitment = await this.findRecruitment(context);
    if (!recruitment.value) return { reason: recruitment.reason };
    const recruitmentId = text(recruitment.value.recruitmentId);
    if (!recruitmentId) {
      return { reason: "조회한 채용에 recruitmentId가 없습니다." };
    }
    const applicant = await this.findApplicant(context, recruitmentId);
    if (!applicant.value) return { reason: applicant.reason };
    const applicantProgressId = text(applicant.value.applicantProgressId);
    if (!applicantProgressId) {
      return { reason: "조회한 지원자에 applicantProgressId가 없습니다." };
    }
    const detail = asRecord(
      upstreamPayload(
        await this.gateway.callTool("get_applicant_progress", {
          applicantProgressId,
        }),
      ),
    );
    if (!detail) {
      return { reason: "지원자 상세 조회 결과 형식이 예상과 다릅니다." };
    }
    const summary = summarizeCompletedScoreSheets(detail, recruitmentId);
    if (!summary) {
      return { reason: "완료된 평가표(status=done)를 찾지 못했습니다." };
    }
    return {
      context: {
        candidateRef: summary.applicantProgressId,
        candidateName: text(detail.name) ?? context.candidateName,
        recruitmentRef: summary.recruitmentId,
        recruitmentName:
          text(recruitment.value.title) ?? context.recruitmentName,
      },
      summary,
    };
  }

  private async findRecruitment(
    context: CandidateContext,
  ): Promise<{ value?: Record<string, unknown>; reason?: string }> {
    const referencedId = identifierFromReference(context.recruitmentRef);
    if (referencedId) {
      try {
        const result = asRecord(
          upstreamPayload(
            await this.gateway.callTool("get_recruitment", {
              recruitmentId: referencedId,
            }),
          ),
        );
        if (
          result &&
          (sameText(result.title, context.recruitmentName) ||
            sameText(result.externalTitle, context.recruitmentName))
        ) {
          return { value: result };
        }
      } catch {
        // Slack 링크의 마지막 경로가 채용 ID가 아닐 수 있어 제목 조회로 보완합니다.
      }
    }
    const payload = asRecord(
      upstreamPayload(
        await this.gateway.callTool("get_recruitments", {
          keyword: context.recruitmentName,
          limit: 20,
        }),
      ),
    );
    const matches = records(payload?.results).filter(
      (recruitment) =>
        sameText(recruitment.title, context.recruitmentName) ||
        sameText(recruitment.externalTitle, context.recruitmentName),
    );
    return uniqueRecord(matches, `채용명 '${context.recruitmentName}'`);
  }

  private async findApplicant(
    context: CandidateContext,
    recruitmentId: string,
  ): Promise<{ value?: Record<string, unknown>; reason?: string }> {
    const referencedId = identifierFromReference(context.candidateRef);
    if (referencedId) {
      try {
        const detail = asRecord(
          upstreamPayload(
            await this.gateway.callTool("get_applicant_progress", {
              applicantProgressId: referencedId,
            }),
          ),
        );
        if (detail && sameText(detail.name, context.candidateName)) {
          return { value: detail };
        }
      } catch {
        // Slack 링크의 마지막 경로가 지원자 진행 ID가 아닐 수 있어 이름 조회로 보완합니다.
      }
    }
    const payload = asRecord(
      upstreamPayload(
        await this.gateway.callTool("get_applicant_progresses", {
          recruitmentId,
          keyword: context.candidateName,
          limit: 20,
        }),
      ),
    );
    const matches = records(payload?.results).filter((applicant) =>
      sameText(applicant.applicantName, context.candidateName),
    );
    return uniqueRecord(matches, `지원자 '${context.candidateName}'`);
  }

  async listInterviewers(
    context: CandidateContext,
  ): Promise<InterviewerLookup> {
    const recruitmentId = identifierFromReference(context.recruitmentRef);
    if (!recruitmentId) {
      return { interviewers: [], unresolvedUserGroups: [] };
    }
    const recruitment = asRecord(
      upstreamPayload(
        await this.gateway.callTool("get_recruitment", { recruitmentId }),
      ),
    );
    if (!recruitment) {
      throw new Error("NineHire recruitment result format is invalid.");
    }
    const unresolvedUserGroups = records(recruitment.participants)
      .filter((participant) => codeOf(participant.type) === "user_group")
      .map((participant) => text(asRecord(participant.userGroup)?.name))
      .filter((name): name is string => Boolean(name));
    const seenUserIds = new Set<string>();
    const interviewers: NinehireInterviewer[] = [];
    for (const participant of records(recruitment.participants)) {
      if (codeOf(participant.type) !== "user") continue;
      const user = asRecord(participant.user);
      const ninehireUserId = text(user?.userId);
      const displayName = text(user?.name);
      if (!ninehireUserId || !displayName || seenUserIds.has(ninehireUserId)) {
        continue;
      }
      seenUserIds.add(ninehireUserId);
      interviewers.push({
        ninehireUserId,
        displayName,
        ...(text(user?.email) ? { email: text(user?.email) } : {}),
        required: true,
      });
    }
    return { interviewers, unresolvedUserGroups };
  }
}
