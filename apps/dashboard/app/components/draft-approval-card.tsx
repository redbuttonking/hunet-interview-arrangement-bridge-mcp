"use client";
// Slack 초안을 확인하고 사용자가 승인한 경우에만 발송한다.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Send } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

type DashboardDraft = {
  id: string;
  messageType: string;
  status: string;
  previewText: string;
  createdAt: string;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
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

export function DraftApprovalCard({ drafts }: { drafts: DashboardDraft[] }) {
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
      <div className="divide-y divide-slate-200">
        {drafts.map((draft) => (
          <article className="py-5 first:pt-0 last:pb-0" key={draft.id}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div><p className="text-base font-semibold text-slate-950">{messageTypeLabel(draft.messageType)}</p><p className="mt-1 text-sm text-slate-600">{formatDateTime(draft.createdAt)}</p></div>
              <Badge variant={draft.status === "SENT" ? "success" : draft.status === "DRAFT" ? "warning" : "secondary"}>{draft.status === "SENT" ? "발송 완료" : draft.status === "DRAFT" ? "발송 승인 대기" : draft.status}</Badge>
            </div>
            <pre className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-4 font-sans text-sm leading-6 text-slate-700">{draft.previewText}</pre>
            {draft.status === "DRAFT" ? <Button className="mt-4" onClick={() => setSelectedDraft(draft)}><Send className="size-4" />내용 확인 후 Slack 발송</Button> : null}
          </article>
        ))}
      </div>

      <Dialog open={Boolean(selectedDraft)} onOpenChange={(open) => !open && setSelectedDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">SLACK SEND APPROVAL</p>
            <DialogTitle>{selectedDraft ? messageTypeLabel(selectedDraft.messageType) : "Slack 메시지 발송"}</DialogTitle>
            <DialogDescription>발송 후에는 해당 Slack 채널의 면접관에게 메시지가 전달됩니다.</DialogDescription>
          </DialogHeader>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-4 font-sans text-sm leading-6 text-slate-700">{selectedDraft?.previewText}</pre>
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
