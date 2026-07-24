import { createHash } from "node:crypto";
import type { CandidateContext } from "../domain/types.js";

export interface ParsedSlackNotification extends CandidateContext {
  eventType:
    | "EVALUATION_COMPLETED"
    | "APPLICATION_CREATED"
    | "CANDIDATE_REJECTED"
    | "CANDIDATE_MESSAGE"
    | "REPLY_DEADLINE_EXPIRED"
    | "EVALUATION_DEADLINE_EXPIRED"
    | "OTHER";
  title: string;
  text: string;
  links: Array<{ url: string; label?: string }>;
  payloadHash: string;
  payloadJson: string;
}

function collectText(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (typeof object.text === "string") output.add(object.text);
  else if (object.text !== undefined) collectText(object.text, output);
  for (const [key, child] of Object.entries(object)) {
    if (key !== "text") collectText(child, output);
  }
}

function cleanSlackText(text: string): string {
  return text
    .replace(/<([^>|]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/\r/g, "")
    .trim();
}

function linksFrom(value: unknown): Array<{ url: string; label?: string }> {
  const serialized = JSON.stringify(value);
  const links: Array<{ url: string; label?: string }> = [];
  const seen = new Set<string>();
  const pattern = /<(https?:\/\/[^>|]+)(?:\|([^>]+))?>/g;
  for (const match of serialized.matchAll(pattern)) {
    const url = match[1];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ url, ...(match[2] ? { label: match[2] } : {}) });
  }
  return links;
}

function field(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escaped}:\\s*([^\\n]+)`));
  return match?.[1]?.replace(/^[-–—]\s*/, "").trim() || undefined;
}

function classify(text: string): ParsedSlackNotification["eventType"] {
  if (
    text.includes("서류 평가가 완료되었습니다.") ||
    text.includes("평가가 완료되었습니다.")
  ) {
    return "EVALUATION_COMPLETED";
  }
  if (text.includes("새 지원자가 등록되었습니다.")) {
    return "APPLICATION_CREATED";
  }
  if (text.includes("지원자가 불합격하였습니다.")) {
    return "CANDIDATE_REJECTED";
  }
  if (text.includes("지원자로부터 메시지가 도착했습니다.")) {
    return "CANDIDATE_MESSAGE";
  }
  if (text.includes("회신 기한이 지나 자동으로 불참되었습니다.")) {
    return "REPLY_DEADLINE_EXPIRED";
  }
  if (text.includes("평가 기한이 만료되었습니다.")) {
    return "EVALUATION_DEADLINE_EXPIRED";
  }
  return "OTHER";
}

export function parseNinehireSlackMessage(
  payload: unknown,
): ParsedSlackNotification {
  const fragments = new Set<string>();
  collectText(payload, fragments);
  const text = cleanSlackText([...fragments].join("\n"));
  const links = linksFrom(payload);
  const candidateName = field(text, "지원자");
  const recruitmentName = field(text, "채용");
  const candidateLink = links.find(
    (link) => candidateName && link.label?.trim() === candidateName,
  );
  const recruitmentLink = links.find(
    (link) => recruitmentName && link.label?.trim() === recruitmentName,
  );
  const eventType = classify(text);
  const title =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) =>
        [
          "완료되었습니다.",
          "등록되었습니다.",
          "불합격하였습니다.",
          "도착했습니다.",
          "불참되었습니다.",
          "만료되었습니다.",
        ].some((ending) => line.endsWith(ending)),
      ) ?? eventType;
  const retainedPayload = {
    text,
    links,
  };
  const payloadJson = JSON.stringify(retainedPayload);
  return {
    eventType,
    title,
    text,
    links,
    payloadHash: createHash("sha256").update(payloadJson).digest("hex"),
    payloadJson,
    ...(candidateName ? { candidateName } : {}),
    ...(recruitmentName ? { recruitmentName } : {}),
    ...(candidateLink ? { candidateRef: candidateLink.url } : {}),
    ...(recruitmentLink ? { recruitmentRef: recruitmentLink.url } : {}),
  };
}
