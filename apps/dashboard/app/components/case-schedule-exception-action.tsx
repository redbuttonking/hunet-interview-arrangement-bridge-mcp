"use client";
// 확정 일정 삭제처럼 후보자별 예외 상황을 상세 페이지에서 바로 처리한다.

import { useState } from "react";
import { Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "./ui/button";

type Decision = {
  id: string;
  title: string;
  prompt: string;
  options: Array<{ id: string; label: string; description: string }>;
};

function isDecision(value: unknown): value is Decision {
  return typeof value === "object"
    && value !== null
    && "id" in value
    && "title" in value
    && "prompt" in value
    && "options" in value
    && Array.isArray((value as { options?: unknown }).options);
}

function followUpDecision(value: unknown): Decision | null {
  if (isDecision(value)) return value;
  if (
    typeof value === "object"
    && value !== null
    && "decision" in value
    && isDecision((value as { decision?: unknown }).decision)
  ) {
    return (value as { decision: Decision }).decision;
  }
  return null;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const raw = await response.text();
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(fallback);
  }
}

export function CaseScheduleExceptionAction({
  reviewId,
  embedded = false,
}: {
  reviewId: string;
  embedded?: boolean;
}) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (optionId: string) => {
    setLoading(optionId);
    setError(null);
    setNotice(null);
    try {
      let activeDecision = decision;
      if (!activeDecision) {
        const response = await fetch(`/api/reviews/${reviewId}/decision`, { method: "POST" });
        const result = await readJson<{ decision?: Decision; error?: string }>(
          response,
          "예외 상황 처리 선택지를 불러오지 못했습니다.",
        );
        if (!response.ok || !result.decision) {
          throw new Error(result.error ?? "예외 상황 처리 선택지를 불러오지 못했습니다.");
        }
        activeDecision = result.decision;
        setDecision(activeDecision);
      }

      const response = await fetch(`/api/decisions/${activeDecision.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId }),
      });
      const result = await readJson<{ followUp?: unknown; error?: string }>(
        response,
        "예외 상황을 처리하지 못했습니다.",
      );
      if (!response.ok) {
        throw new Error(result.error ?? "예외 상황을 처리하지 못했습니다.");
      }
      const followUp = followUpDecision(result.followUp);
      if (followUp) {
        setDecision(followUp);
        setNotice("재조율 방식을 선택해 주세요.");
        return;
      }
      setNotice("처리 결과를 반영했습니다.");
      window.setTimeout(() => window.location.reload(), 500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "예외 상황을 처리하지 못했습니다.");
    } finally {
      setLoading(null);
    }
  };

  const initialActions = [
    {
      id: "RESCHEDULE",
      label: "재조율",
      description: "기존 면접관 일정으로 다시 찾을지, 새로 받을지 다음 단계에서 선택합니다.",
      variant: "default" as const,
    },
    {
      id: "CANCEL",
      label: "인터뷰 종료",
      description: "로컬 인터뷰 기록과 배정만 종료하며 다우오피스 예약은 유지합니다.",
      variant: "destructive" as const,
    },
    {
      id: "HOLD",
      label: "보류",
      description: "현재 기록을 유지한 채 추가 판단 전까지 보류합니다.",
      variant: "outline" as const,
    },
  ];
  const actions = decision
    ? decision.options.map((option) => ({ ...option, variant: "outline" as const }))
    : initialActions;

  return (
    <section className={`${embedded ? "" : "mt-6 "}rounded-2xl border border-amber-200 bg-amber-50/70 p-5 shadow-sm sm:p-6`}>
      <div className="flex items-start gap-3">
        <XCircle className="mt-0.5 size-5 shrink-0 text-amber-700" />
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-800">SCHEDULE DELETION DETECTED</p>
          <h2 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-slate-950">나인하이어 일정 삭제가 확인되었습니다.</h2>
          <p className="mt-2 text-base leading-7 text-slate-700">기존 확정 일정은 나인하이어에서 삭제됐습니다. 다음 조치를 선택해 주세요.</p>
        </div>
      </div>
      {notice ? <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900">{notice}</p> : null}
      {error ? <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800">{error}</p> : null}
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {actions.map((action) => (
          <div className="rounded-xl border border-amber-200 bg-white p-4" key={action.id}>
            <p className="text-base font-semibold text-slate-950">{action.label}</p>
            <p className="mt-2 min-h-12 text-sm leading-6 text-slate-600">{action.description}</p>
            <Button className="mt-4 w-full" disabled={loading !== null} onClick={() => void submit(action.id)} type="button" variant={action.variant}>
              {loading === action.id ? <Loader2 className="size-4 animate-spin" /> : action.id === "RESCHEDULE" ? <RefreshCw className="size-4" /> : null}
              {action.label}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
