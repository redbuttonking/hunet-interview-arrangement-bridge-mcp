import type { AppConfig } from "../config.js";
import type {
  CandidateContext,
  EvaluationLookup,
  NinehireInterviewer,
} from "../domain/types.js";
import { NinehireMcpGateway } from "./gateway.js";

export interface NinehireWorkflowAdapter {
  lookupEvaluation(context: CandidateContext): Promise<EvaluationLookup>;
  listInterviewers(context: CandidateContext): Promise<NinehireInterviewer[]>;
}

function valueAtPath(value: unknown, path?: string): unknown {
  if (!path || path === "$") return value;
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (typeof current !== "object" || current === null) return undefined;
      return (current as Record<string, unknown>)[segment];
    }, value);
}

function escapedTemplateValue(value: string | undefined): string {
  return JSON.stringify(value ?? "").slice(1, -1);
}

function renderArgs(
  template: string,
  context: CandidateContext,
): Record<string, unknown> {
  const replacements: Record<string, string | undefined> = {
    candidateRef: context.candidateRef,
    candidateName: context.candidateName,
    recruitmentRef: context.recruitmentRef,
    recruitmentName: context.recruitmentName,
  };
  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(
      `{{${key}}}`,
      escapedTemplateValue(value),
    );
  }
  const parsed = JSON.parse(rendered) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("NineHire argument template must render to a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function upstreamPayload(result: Record<string, unknown>): unknown {
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

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase("ko-KR");
}

export class MappedNinehireWorkflowAdapter
  implements NinehireWorkflowAdapter
{
  constructor(
    private readonly config: AppConfig["ninehire"],
    private readonly gateway: NinehireMcpGateway,
  ) {}

  async lookupEvaluation(
    context: CandidateContext,
  ): Promise<EvaluationLookup> {
    const mapping = this.config.evaluation;
    if (!mapping.toolName || !mapping.argsJson || !mapping.resultPath) {
      return {
        decision: "REVIEW_REQUIRED",
        reason:
          "NineHire evaluation mapping is not configured. Run `npm run inspect:ninehire` and fill the NINEHIRE_EVALUATION_* settings.",
      };
    }

    const result = await this.gateway.callTool(
      mapping.toolName,
      renderArgs(mapping.argsJson, context),
    );
    const rawValue = valueAtPath(
      upstreamPayload(result),
      mapping.resultPath,
    );
    const comparable = normalized(rawValue);
    if (mapping.passValues.some((value) => normalized(value) === comparable)) {
      return { decision: "PASS", rawValue: String(rawValue) };
    }
    if (mapping.failValues.some((value) => normalized(value) === comparable)) {
      return { decision: "FAIL", rawValue: String(rawValue) };
    }
    return {
      decision: "REVIEW_REQUIRED",
      rawValue: String(rawValue ?? ""),
      reason: `Unmapped evaluation result: ${String(rawValue)}`,
    };
  }

  async listInterviewers(
    context: CandidateContext,
  ): Promise<NinehireInterviewer[]> {
    const mapping = this.config.interviewers;
    if (!mapping.toolName || !mapping.argsJson || !mapping.resultPath) {
      return [];
    }
    const result = await this.gateway.callTool(
      mapping.toolName,
      renderArgs(mapping.argsJson, context),
    );
    const raw = valueAtPath(upstreamPayload(result), mapping.resultPath);
    if (!Array.isArray(raw)) {
      throw new Error(
        `NineHire interviewer result path did not resolve to an array: ${mapping.resultPath}`,
      );
    }
    return raw.map((item, index) => {
      const id = valueAtPath(item, mapping.idPath);
      const name = valueAtPath(item, mapping.namePath);
      const email = valueAtPath(item, mapping.emailPath);
      if (!id || !name) {
        throw new Error(
          `NineHire interviewer item ${index} is missing its mapped id or name.`,
        );
      }
      return {
        ninehireUserId: String(id),
        displayName: String(name),
        ...(email ? { email: String(email) } : {}),
        required: true,
      };
    });
  }
}
