import type {
  CandidateContext,
  EvaluationLookup,
  EvaluationSummary,
  InterviewerLookup,
  NinehireCandidateSchedule,
  NinehireInterviewer,
  NinehireRecruitmentList,
  RecruitmentPipeline,
} from "../domain/types.js";
import { NinehireMcpGateway } from "./gateway.js";

export interface NinehireWorkflowAdapter {
  lookupCompletedEvaluation(
    context: CandidateContext,
  ): Promise<EvaluationLookup>;
  listInterviewers(context: CandidateContext): Promise<InterviewerLookup>;
  listInProgressRecruitments(input: {
    keyword?: string;
    limit: number;
    offset: number;
  }): Promise<NinehireRecruitmentList>;
  listClosedRecruitments?(input: {
    keyword?: string;
    limit: number;
    offset: number;
  }): Promise<NinehireRecruitmentList>;
  getRecruitmentPipeline?(recruitmentId: string): Promise<RecruitmentPipeline>;
  listCandidateSchedules?(contexts: CandidateContext[]): Promise<NinehireCandidateSchedule[]>;
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
    const identifier = url.pathname.split("/").filter(Boolean).at(-1);
    return identifier === "applicants" || identifier === "recruitment"
      ? undefined
      : identifier;
  } catch {
    return reference.includes("/") ? undefined : reference;
  }
}

function identifierAfterPathSegment(
  reference: string | undefined,
  segment: string,
): string | undefined {
  if (!reference) return undefined;
  try {
    const url = new URL(reference);
    const segments = url.pathname.split("/").filter(Boolean);
    const segmentIndex = segments.lastIndexOf(segment);
    return segmentIndex >= 0 ? segments[segmentIndex + 1] : undefined;
  } catch {
    return undefined;
  }
}

function recruitmentIdFromReference(reference?: string): string | undefined {
  if (!reference) return undefined;
  try {
    const url = new URL(reference);
    return (
      url.searchParams.get("recruitmentId") ??
      identifierAfterPathSegment(reference, "recruitment") ??
      identifierAfterPathSegment(reference, "recruitments") ??
      identifierFromReference(reference)
    );
  } catch {
    return identifierFromReference(reference);
  }
}

function applicantProgressIdFromReference(
  reference?: string,
): string | undefined {
  if (!reference) return undefined;
  try {
    const url = new URL(reference);
    return (
      url.searchParams.get("applicantProgressId") ??
      identifierAfterPathSegment(reference, "applicants") ??
      identifierFromReference(reference)
    );
  } catch {
    return identifierFromReference(reference);
  }
}

function codeOf(value: unknown): string | undefined {
  return text(asRecord(value)?.code);
}

function nameOf(value: unknown): string | undefined {
  return text(asRecord(value)?.name);
}

function koreaDateTime(value: unknown): { date: string; time: string } | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  const time = `${part("hour")}:${part("minute")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time)
    ? { date, time }
    : undefined;
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
  const stepId = text(detail.stepId);
  const stepName = text(detail.stepName);
  return {
    applicantProgressId,
    recruitmentId,
    scoreSheets,
    ...(stepId && stepName
      ? {
          currentStep: {
            stepId,
            name: stepName,
            ...(typeof detail.stepOrder === "number"
              ? { order: detail.stepOrder }
              : {}),
          },
        }
      : {}),
  };
}

export class NinehireRecruitmentWorkflowAdapter
  implements NinehireWorkflowAdapter
{
  constructor(
    private readonly gateway: Pick<NinehireMcpGateway, "callTool">,
  ) {}

  async listInProgressRecruitments(input: {
    keyword?: string;
    limit: number;
    offset: number;
  }): Promise<NinehireRecruitmentList> {
    const payload = asRecord(
      upstreamPayload(
        await this.gateway.callTool("get_recruitments", {
          status: "in_progress",
          limit: input.limit,
          offset: input.offset,
          ...(input.keyword ? { keyword: input.keyword } : {}),
        }),
      ),
    );
    const upstreamRecruitments = records(payload?.results);
    const recruitments = upstreamRecruitments
      .filter((recruitment) => codeOf(recruitment.status) === "in_progress")
      .flatMap((recruitment) => {
        const recruitmentId = text(recruitment.recruitmentId);
        const title = text(recruitment.title);
        if (!recruitmentId || !title) return [];
        return [
          {
            recruitmentId,
            title,
            ...(text(recruitment.externalTitle)
              ? { externalTitle: text(recruitment.externalTitle) }
              : {}),
            status: nameOf(recruitment.status) ?? "진행 중",
            ...(nameOf(recruitment.deadlineType)
              ? { deadlineType: nameOf(recruitment.deadlineType) }
              : {}),
            ...(text(recruitment.deadlineValue)
              ? { deadlineValue: text(recruitment.deadlineValue) }
              : {}),
            isPrivate: recruitment.isPrivate === true,
          },
        ];
      });
    return {
      count:
        upstreamRecruitments.length === recruitments.length &&
        typeof payload?.count === "number"
          ? payload.count
          : recruitments.length,
      limit:
        typeof payload?.limit === "number" ? payload.limit : input.limit,
      offset:
        typeof payload?.offset === "number" ? payload.offset : input.offset,
      recruitments,
    };
  }

  async listClosedRecruitments(input: {
    keyword?: string;
    limit: number;
    offset: number;
  }): Promise<NinehireRecruitmentList> {
    const payload = asRecord(
      upstreamPayload(
        await this.gateway.callTool("get_recruitments", {
          status: "closed",
          limit: input.limit,
          offset: input.offset,
          ...(input.keyword ? { keyword: input.keyword } : {}),
        }),
      ),
    );
    const upstreamRecruitments = records(payload?.results);
    const recruitments = upstreamRecruitments
      .filter((recruitment) => codeOf(recruitment.status) === "closed")
      .flatMap((recruitment) => {
        const recruitmentId = text(recruitment.recruitmentId);
        const title = text(recruitment.title);
        if (!recruitmentId || !title) return [];
        return [
          {
            recruitmentId,
            title,
            ...(text(recruitment.externalTitle)
              ? { externalTitle: text(recruitment.externalTitle) }
              : {}),
            status: nameOf(recruitment.status) ?? "종료",
            ...(text(recruitment.closedAt)
              ? { closedAt: text(recruitment.closedAt) }
              : {}),
            ...(nameOf(recruitment.deadlineType)
              ? { deadlineType: nameOf(recruitment.deadlineType) }
              : {}),
            ...(text(recruitment.deadlineValue)
              ? { deadlineValue: text(recruitment.deadlineValue) }
              : {}),
            isPrivate: recruitment.isPrivate === true,
          },
        ];
      });
    return {
      count:
        upstreamRecruitments.length === recruitments.length &&
        typeof payload?.count === "number"
          ? payload.count
          : recruitments.length,
      limit:
        typeof payload?.limit === "number" ? payload.limit : input.limit,
      offset:
        typeof payload?.offset === "number" ? payload.offset : input.offset,
      recruitments,
    };
  }

  async getRecruitmentPipeline(recruitmentId: string): Promise<RecruitmentPipeline> {
    const recruitment = asRecord(
      upstreamPayload(
        await this.gateway.callTool("get_recruitment", { recruitmentId }),
      ),
    );
    if (!recruitment) {
      throw new Error("NineHire recruitment result format is invalid.");
    }
    const resolvedRecruitmentId = text(recruitment.recruitmentId);
    const recruitmentName = text(recruitment.title);
    if (!resolvedRecruitmentId || !recruitmentName) {
      throw new Error("NineHire recruitment is missing its ID or title.");
    }
    return {
      recruitmentId: resolvedRecruitmentId,
      recruitmentName,
      steps: records(recruitment.steps)
        .flatMap((step) => {
          const stepId = text(step.stepId);
          const title = text(step.title);
          const name = text(step.name);
          const order = step.order;
          if (!stepId || !title || !name || typeof order !== "number") return [];
          return [{
            stepId,
            title,
            name,
            order,
            applicantCount:
              typeof step.applicantCount === "number" ? step.applicantCount : 0,
          }];
        })
        .sort((left, right) => left.order - right.order),
    };
  }

  async listCandidateSchedules(
    contexts: CandidateContext[],
  ): Promise<NinehireCandidateSchedule[]> {
    const grouped = new Map<string, CandidateContext[]>();
    for (const context of contexts) {
      const recruitmentId = identifierFromReference(context.recruitmentRef);
      const applicantProgressId = identifierFromReference(context.candidateRef);
      if (!recruitmentId || !applicantProgressId) continue;
      grouped.set(recruitmentId, [...(grouped.get(recruitmentId) ?? []), context]);
    }

    const schedules: NinehireCandidateSchedule[] = [];
    for (const [recruitmentId, groupedContexts] of grouped) {
      for (let index = 0; index < groupedContexts.length; index += 100) {
        const chunk = groupedContexts.slice(index, index + 100);
        const contextsByApplicantId = new Map(
          chunk.flatMap((context) => {
            const applicantProgressId = identifierFromReference(context.candidateRef);
            return applicantProgressId ? [[applicantProgressId, context] as const] : [];
          }),
        );
        const payload = asRecord(
          upstreamPayload(
            await this.gateway.callTool("get_applicant_progresses", {
              recruitmentId,
              applicantProgressIds: [...contextsByApplicantId.keys()],
              limit: 100,
            }),
          ),
        );
        for (const applicant of records(payload?.results)) {
          const applicantProgressId = text(applicant.applicantProgressId);
          if (!applicantProgressId) continue;
          const context = contextsByApplicantId.get(applicantProgressId);
          const candidateName = text(context?.candidateName);
          const recruitmentName = text(context?.recruitmentName);
          const candidateRef = text(context?.candidateRef);
          const recruitmentRef = text(context?.recruitmentRef);
          if (!context || !candidateName || !recruitmentName || !candidateRef || !recruitmentRef) {
            continue;
          }
          for (const event of records(applicant.events)) {
            if (codeOf(event.type) !== "single") continue;
            const eventId = text(event.eventId);
            const start = koreaDateTime(event.startAt);
            const end = koreaDateTime(event.endAt);
            if (!eventId || !start || !end || start.date !== end.date || start.time >= end.time) {
              continue;
            }
            schedules.push({
              eventId,
              candidateRef,
              candidateName,
              recruitmentRef,
              recruitmentName,
              date: start.date,
              startTime: start.time,
              endTime: end.time,
              ...(text(event.location) ? { location: text(event.location) } : {}),
              attendeeNames: records(event.attendees)
                .map((attendee) => text(attendee.name))
                .filter((name): name is string => Boolean(name)),
            });
          }
        }
      }
    }
    return schedules;
  }

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
    const referencedId =
      recruitmentIdFromReference(context.recruitmentRef) ??
      recruitmentIdFromReference(context.candidateRef);
    if (referencedId) {
      try {
        const result = asRecord(
          upstreamPayload(
            await this.gateway.callTool("get_recruitment", {
              recruitmentId: referencedId,
            }),
          ),
        );
        if (result) {
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
    const referencedId = applicantProgressIdFromReference(context.candidateRef);
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
