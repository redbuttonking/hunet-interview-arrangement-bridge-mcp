import { createHash } from "node:crypto";
import type { CandidateContext } from "../domain/types.js";

export interface ParsedSlackNotification extends CandidateContext {
  eventType:
    | "EVALUATION_COMPLETED"
    | "APPLICATION_CREATED"
    | "CANDIDATE_REJECTED"
    | "CANDIDATE_MESSAGE"
    | "CANDIDATE_INTERVIEW_ABSENCE"
    | "SCHEDULE_CONFIRMED"
    | "REPLY_DEADLINE_EXPIRED"
    | "EVALUATION_DEADLINE_EXPIRED"
    | "OTHER";
  title: string;
  text: string;
  links: Array<{ url: string; label?: string }>;
  payloadHash: string;
  payloadJson: string;
  scheduledDate?: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  location?: string;
  candidateMessage?: string;
}

function collectText(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if (
      ["text", "fallback", "title", "value"].includes(key) &&
      typeof child === "string"
    ) {
      output.add(child);
      continue;
    }
    collectText(child, output);
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
  return match?.[1] ? cleanFieldValue(match[1]) : undefined;
}

function cleanFieldValue(value: string): string | undefined {
  const cleaned = cleanSlackText(value)
    .replace(/^[-–—]\s*/, "")
    .replace(/^[*_`~]+|[*_`~]+$/g, "")
    .trim();
  return cleaned || undefined;
}

function attachmentField(value: unknown, label: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = attachmentField(item, label);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.fields)) {
    for (const item of object.fields) {
      if (!item || typeof item !== "object") continue;
      const field = item as Record<string, unknown>;
      const title =
        typeof field.title === "string"
          ? cleanFieldValue(field.title)?.replace(/:$/, "")
          : undefined;
      if (title === label && typeof field.value === "string") {
        return cleanFieldValue(field.value);
      }
    }
  }
  for (const child of Object.values(object)) {
    const found = attachmentField(child, label);
    if (found) return found;
  }
  return undefined;
}

export function isCandidateInterviewAbsenceText(text: string): boolean {
  return (
    text.includes("지원자로부터 메시지가 도착했습니다.") &&
    text.includes("일정에 불참합니다")
  );
}

export function isCandidateScheduleRelatedMessage(text: string): boolean {
  const value = cleanSlackText(text);
  return [
    /(?:\uBA74\uC811|\uC778\uD130\uBDF0).{0,16}(?:\uC77C\uC815|\uC2DC\uAC04|\uB0A0\uC9DC|\uC77C\uC790|\uCC38\uC11D|\uBD88\uCC38|\uBCC0\uACBD|\uC870\uC728|\uC5F0\uAE30|\uCDE8\uC18C|\uAC00\uB2A5|\uBD88\uAC00|\uC5B4\uB835|\uD798\uB4E4|\uC548\s*\uB418|\uC548\uB3FC)/u,
    /(?:\uC77C\uC815|\uC2DC\uAC04|\uB0A0\uC9DC|\uC77C\uC790).{0,12}(?:\uBA74\uC811|\uC778\uD130\uBDF0|\uC5B4\uB835|\uD798\uB4E4|\uBD88\uAC00|\uBD88\uAC00\uB2A5|\uAC00\uB2A5|\uC548\s*\uB418|\uC548\uB3FC|\uBCC0\uACBD|\uC870\uC728|\uC7AC\uC870\uC728|\uC5F0\uAE30|\uCDE8\uC18C|\uBD88\uCC38|\uCC38\uC11D)/u,
    /(?:\uB2E4\uC74C\s*\uC8FC|\uC774\uBC88\s*\uC8FC|\uAE08\uC8FC|\uCC28\uC8FC).{0,20}(?:\uBA74\uC811|\uC778\uD130\uBDF0|\uC77C\uC815|\uC2DC\uAC04|\uB0A0\uC9DC|\uC77C\uC790)/u,
    /(?:\d{1,2}\s*\uC6D4\s*\d{1,2}\s*\uC77C|\d{1,2}\s*\uC77C|\d{1,2}:\d{2}).{0,20}(?:\uBA74\uC811|\uC778\uD130\uBDF0|\uC77C\uC815|\uC2DC\uAC04|\uB0A0\uC9DC|\uC77C\uC790)/u,
    /(?:schedule|reschedule|proposed\s+time|interview\s+time|unavailable|cannot\s+attend|cancel)/iu,
  ].some((pattern) => pattern.test(value));
}

function classify(text: string): ParsedSlackNotification["eventType"] {
  if (text.includes("일정이 확정되었습니다")) {
    return "SCHEDULE_CONFIRMED";
  }
  if (
    text.includes("서류 평가가 완료되었습니다.") ||
    text.includes("평가가 완료되었습니다.") ||
    text.includes("평가표 제출이 완료되었습니다.")
  ) {
    return "EVALUATION_COMPLETED";
  }
  if (text.includes("새 지원자가 등록되었습니다.")) {
    return "APPLICATION_CREATED";
  }
  if (text.includes("지원자가 불합격하였습니다.")) {
    return "CANDIDATE_REJECTED";
  }
  if (isCandidateInterviewAbsenceText(text)) {
    return "CANDIDATE_INTERVIEW_ABSENCE";
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

export function parseConfirmedScheduleDateTime(text: string):
  | { date: string; startTime: string; endTime: string }
  | undefined {
  const match = text.match(
    /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(?:[가-힣]+\s*)?(\d{1,2}:\d{2})\s*[-~]\s*(\d{1,2}:\d{2})/,
  );
  if (!match) return undefined;
  const [, year, month, day, startTime, endTime] = match;
  if (!year || !month || !day || !startTime || !endTime) return undefined;
  return {
    date: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
    startTime,
    endTime,
  };
}

export function parseNinehireSlackMessage(
  payload: unknown,
): ParsedSlackNotification {
  const fragments = new Set<string>();
  collectText(payload, fragments);
  const text = cleanSlackText([...fragments].join("\n"));
  const links = linksFrom(payload);
  const candidateName = attachmentField(payload, "지원자") ?? field(text, "지원자");
  const recruitmentName = attachmentField(payload, "채용") ?? field(text, "채용");
  const candidateMessage =
    attachmentField(payload, "메시지") ?? field(text, "메시지");
  const candidateLink = links.find(
    (link) => candidateName && link.label?.trim() === candidateName,
  );
  const recruitmentLink = links.find(
    (link) => recruitmentName && link.label?.trim() === recruitmentName,
  );
  const eventType = classify(text);
  const schedule =
    eventType === "SCHEDULE_CONFIRMED"
      ? parseConfirmedScheduleDateTime(text)
      : undefined;
  const location =
    eventType === "SCHEDULE_CONFIRMED"
      ? attachmentField(payload, "장소") ?? field(text, "장소")
      : undefined;
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
    ...(candidateMessage ? { candidateMessage } : {}),
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
    ...(schedule
      ? {
          scheduledDate: schedule.date,
          scheduledStartTime: schedule.startTime,
          scheduledEndTime: schedule.endTime,
        }
      : {}),
    ...(location ? { location } : {}),
    ...(candidateMessage ? { candidateMessage } : {}),
  };
}
