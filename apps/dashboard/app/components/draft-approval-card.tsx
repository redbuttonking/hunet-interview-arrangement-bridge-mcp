"use client";
// Slack 초안을 확인하고 사용자가 승인한 경우에만 발송한다.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, CheckCircle2, Loader2, Send } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

type DashboardDraft = {
  id: string;
  messageType: string;
  status: string;
  previewText: string;
  blocksJson: string;
  createdAt: string;
};

type SlackBlock = {
  type?: string;
  text?: { text?: string };
  elements?: Array<{
    type?: string;
    text?: string | { text?: string };
  }>;
};

function dashboardText(value: string, interviewerNames: Record<string, string>): string {
  return value
    .replace(/<@([A-Z0-9]+)>/gu, (_match, slackUserId: string) =>
      interviewerNames[slackUserId] ?? "면접관 정보 확인 필요",
    )
    .replace(/\*([^*]+)\*/gu, "$1")
    .replace(/[*_~]/gu, "");
}

function slackPreview(
  draft: DashboardDraft,
  interviewerNames: Record<string, string>,
): string {
  try {
    const blocks = JSON.parse(draft.blocksJson) as SlackBlock[];
    const lines = blocks.flatMap((block) => {
      const text = block.text?.text?.trim();
      if (text) return [dashboardText(text, interviewerNames)];
      if (block.type === "actions") {
        const labels = (block.elements ?? [])
          .flatMap((element) => {
            const label = typeof element.text === "string"
              ? element.text
              : element.text?.text;
            return label?.trim() ? [label.trim()] : [];
          });
        return labels.length > 0
          ? [`버튼: ${labels.map((label) => dashboardText(label, interviewerNames)).join(" · ")}`]
          : [];
      }
      if (block.type === "context") {
        return (block.elements ?? []).flatMap((element) => {
          const value = typeof element.text === "string"
            ? element.text
            : element.text?.text;
          return value?.trim() ? [dashboardText(value.trim(), interviewerNames)] : [];
        });
      }
      return [];
    });
    return lines.length > 0 ? lines.join("\n\n") : draft.previewText;
  } catch {
    return draft.previewText;
  }
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const hour24 = shifted.getUTCHours();
  const period = hour24 >= 12 ? "오후" : "오전";
  const hour = hour24 % 12 || 12;
  return `${shifted.getUTCMonth() + 1}. ${shifted.getUTCDate()}. ${period} ${hour}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

function messageTypeLabel(messageType: string) {
  const labels: Record<string, string> = {
    INTERVIEWER_REQUEST: "면접관 가능 일정 요청",
    SCHEDULE_CONFIRMATION: "확정 인터뷰 안내",
    AVAILABILITY_RECOVERY: "가능 일정 재제출 요청",
    SCHEDULE_CHANGE: "인터뷰 일정 변경 안내",
    SCHEDULE_CANCELLATION: "인터뷰 취소 안내",
  };
  return labels[messageType] ?? messageType;
}

function isAvailabilityRequest(draft: DashboardDraft): boolean {
  return ["INTERVIEWER_REQUEST", "AVAILABILITY_RECOVERY"].includes(draft.messageType);
}

function proposalDateLabels(
  draft: DashboardDraft,
  interviewerNames: Record<string, string>,
): string[] {
  if (!isAvailabilityRequest(draft)) return [];
  try {
    const blocks = JSON.parse(draft.blocksJson) as SlackBlock[];
    const text = blocks
      .flatMap((block) => block.text?.text ? [dashboardText(block.text.text, interviewerNames)] : [])
      .flatMap((value) => value.split("\n"))
      .find((line) => line.trim().startsWith("제안 날짜:"));
    return text
      ? text.replace(/^\s*제안 날짜:\s*/u, "").split(",").map((date) => date.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function previewWithoutProposalDates(
  draft: DashboardDraft,
  interviewerNames: Record<string, string>,
): string {
  const preview = slackPreview(draft, interviewerNames);
  return isAvailabilityRequest(draft)
    ? preview.replace(/^제안 날짜:.*(?:\r?\n|$)/mu, "").replace(/\n{3,}/gu, "\n\n").trim()
    : preview;
}

export function DraftApprovalCard({
  drafts,
  interviewerNames,
  variant = "full",
  triggerLabel = "내용 확인 후 Slack 발송",
}: {
  drafts: DashboardDraft[];
  interviewerNames: Record<string, string>;
  variant?: "full" | "trigger";
  triggerLabel?: string;
}) {
  const router = useRouter();
  const [selectedDraft, setSelectedDraft] = useState<DashboardDraft | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approveAndSend = async () => {
    if (!selectedDraft) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/drafts/${selectedDraft.id}/send`, { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Slack 메시지를 발송하지 못했습니다.");
      setSelectedDraft(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Slack 메시지를 발송하지 못했습니다.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {variant === "trigger" ? (() => {
        const draft = drafts.find((item) => item.status === "DRAFT");
        return draft ? <Button onClick={() => setSelectedDraft(draft)}>{triggerLabel}</Button> : null;
      })() : <div className="divide-y divide-slate-200">
        {drafts.map((draft) => {
          const dates = proposalDateLabels(draft, interviewerNames);
          return (
          <article className="py-5 first:pt-0 last:pb-0" key={draft.id}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div><p className="text-base font-semibold text-slate-950">{messageTypeLabel(draft.messageType)}</p><p className="mt-1 text-sm text-slate-600">{formatDateTime(draft.createdAt)}</p></div>
              <Badge variant={draft.status === "SENT" ? "success" : draft.status === "DRAFT" ? "warning" : "secondary"}>{draft.status === "SENT" ? "발송 완료" : draft.status === "DRAFT" ? "발송 승인 대기" : draft.status}</Badge>
            </div>
            {dates.length > 0 ? <section className="mt-4 rounded-xl border border-blue-200 bg-blue-50/70 p-4" aria-label="일정 제출 대상 날짜"><div className="flex items-center gap-2 text-sm font-bold text-blue-950"><CalendarDays className="size-4 text-blue-600" />일정 제출 대상 날짜</div><div className="mt-3 flex flex-wrap gap-2">{dates.map((date) => <span className="rounded-md border border-blue-200 bg-white px-3 py-1.5 text-sm font-bold text-blue-800 shadow-sm" key={date}>{date}</span>)}</div></section> : null}
            <pre className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-4 font-sans text-sm leading-6 text-slate-700">{previewWithoutProposalDates(draft, interviewerNames)}</pre>
            {draft.status === "DRAFT" ? <Button className="mt-4" onClick={() => setSelectedDraft(draft)}><Send className="size-4" />내용 확인 후 Slack 발송</Button> : null}
          </article>
          );
        })}
      </div>}

      <Dialog open={Boolean(selectedDraft)} onOpenChange={(open) => !open && setSelectedDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">SLACK SEND APPROVAL</p>
            <DialogTitle>{selectedDraft ? messageTypeLabel(selectedDraft.messageType) : "Slack 메시지 발송"}</DialogTitle>
            <DialogDescription>발송 후에는 해당 Slack 채널의 면접관에게 메시지가 전달됩니다.</DialogDescription>
          </DialogHeader>
          <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm leading-6 text-blue-900">아래 내용과 버튼이 Slack에 그대로 발송됩니다. 발송은 오른쪽 아래의 승인 버튼을 누를 때만 실행됩니다.</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-4 font-sans text-sm leading-6 text-slate-700">{selectedDraft ? slackPreview(selectedDraft, interviewerNames) : ""}</pre>
          {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedDraft(null)}>취소</Button>
            <Button disabled={sending} onClick={() => void approveAndSend()}>{sending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}Slack 발송 승인</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
