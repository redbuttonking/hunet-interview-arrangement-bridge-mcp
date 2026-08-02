"use client";
// 후보자별 통합 또는 연속 인터뷰 예외 계획을 사용자 승인으로 저장한다.

import { useMemo, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "./ui/button";

type TemplateStep = {
  stepId: string;
  name: string;
  order: number;
};

type Interviewer = {
  id: string;
  displayName: string;
  required: boolean;
};

export function CasePlanOverrides({
  caseId,
  editable,
  steps,
  interviewers,
}: {
  caseId: string;
  editable: boolean;
  steps: TemplateStep[];
  interviewers: Interviewer[];
}) {
  const defaultStepIds = useMemo(() => steps.slice(0, 2).map((step) => step.stepId), [steps]);
  const [mode, setMode] = useState<"COMBINED" | "SEQUENTIAL">("COMBINED");
  const [selectedStepIds, setSelectedStepIds] = useState<string[]>(defaultStepIds);
  const [selectedInterviewerIds, setSelectedInterviewerIds] = useState<string[]>(
    interviewers.filter((interviewer) => interviewer.required).map((interviewer) => interviewer.id),
  );
  const [sessionInterviewerIds, setSessionInterviewerIds] = useState<Record<string, string[]>>(
    () => Object.fromEntries(
      steps.map((step) => [
        step.stepId,
        interviewers.filter((interviewer) => interviewer.required).map((interviewer) => interviewer.id),
      ]),
    ),
  );
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editable || steps.length < 2 || interviewers.length === 0) return null;

  const toggleStep = (stepId: string) => {
    setSelectedStepIds((current) => current.includes(stepId)
      ? current.filter((item) => item !== stepId)
      : [...current, stepId]);
  };
  const toggleInterviewer = (interviewerId: string) => {
    setSelectedInterviewerIds((current) => current.includes(interviewerId)
      ? current.filter((item) => item !== interviewerId)
      : [...current, interviewerId]);
  };
  const toggleSessionInterviewer = (stepId: string, interviewerId: string) => {
    setSessionInterviewerIds((current) => {
      const currentIds = current[stepId] ?? [];
      return {
        ...current,
        [stepId]: currentIds.includes(interviewerId)
          ? currentIds.filter((item) => item !== interviewerId)
          : [...currentIds, interviewerId],
      };
    });
  };
  const save = async () => {
    setLoading(true);
    setSaved(false);
    setError(null);
    try {
      const payload = mode === "COMBINED"
        ? { mode, stepIds: selectedStepIds, interviewerIds: selectedInterviewerIds }
        : {
            mode,
            sessions: selectedStepIds.map((stepId) => ({
              stepId,
              interviewerIds: sessionInterviewerIds[stepId] ?? [],
            })),
          };
      const response = await fetch(`/api/cases/${caseId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "인터뷰 예외 계획을 저장하지 못했습니다.");
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "인터뷰 예외 계획을 저장하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">CANDIDATE EXCEPTION</p>
      <h2 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-slate-950">후보자별 인터뷰 예외 계획</h2>
      <p className="mt-2 text-base leading-7 text-slate-600">기본 채용 규칙과 다르게 진행할 때만 설정합니다. 면접관 일정 요청을 발송하기 전까지 수정할 수 있습니다.</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {(["COMBINED", "SEQUENTIAL"] as const).map((option) => (
          <label className={`cursor-pointer rounded-xl border p-4 ${mode === option ? "border-blue-500 bg-blue-50/70" : "border-slate-200"}`} key={option}>
            <input checked={mode === option} className="sr-only" name="exception-mode" onChange={() => setMode(option)} type="radio" />
            <strong className="block text-base text-slate-950">{option === "COMBINED" ? "60분 통합 인터뷰" : "같은 날 연속 인터뷰"}</strong>
            <span className="mt-1 block text-sm leading-6 text-slate-600">{option === "COMBINED" ? "선택한 모든 단계의 면접관이 한 번에 60분 동안 진행합니다." : "선택한 단계를 연속으로 진행하고, 단계별 면접관 일정은 따로 계산합니다."}</span>
          </label>
        ))}
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <fieldset className="rounded-xl border border-slate-200 p-4"><legend className="px-1 text-sm font-semibold text-slate-900">진행할 인터뷰 단계</legend><div className="mt-2 grid gap-2">{steps.map((step) => <label className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50" key={step.stepId}><input checked={selectedStepIds.includes(step.stepId)} className="size-4 accent-blue-600" onChange={() => toggleStep(step.stepId)} type="checkbox" /><span className="text-base text-slate-800">{step.order}. {step.name}</span></label>)}</div></fieldset>
        <fieldset className="rounded-xl border border-slate-200 p-4"><legend className="px-1 text-sm font-semibold text-slate-900">{mode === "COMBINED" ? "이번 인터뷰에 참여할 면접관" : "단계별 면접관"}</legend>{mode === "COMBINED" ? <div className="mt-2 grid gap-2">{interviewers.map((interviewer) => <label className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50" key={interviewer.id}><input checked={selectedInterviewerIds.includes(interviewer.id)} className="size-4 accent-blue-600" onChange={() => toggleInterviewer(interviewer.id)} type="checkbox" /><span className="text-base text-slate-800">{interviewer.displayName}</span></label>)}</div> : <div className="mt-3 grid gap-4">{steps.filter((step) => selectedStepIds.includes(step.stepId)).map((step) => <div className="rounded-lg bg-slate-50 p-3" key={step.stepId}><p className="text-sm font-semibold text-slate-900">{step.order}. {step.name}</p><div className="mt-2 grid gap-2">{interviewers.map((interviewer) => <label className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white" key={interviewer.id}><input checked={(sessionInterviewerIds[step.stepId] ?? []).includes(interviewer.id)} className="size-4 accent-blue-600" onChange={() => toggleSessionInterviewer(step.stepId, interviewer.id)} type="checkbox" /><span className="text-sm text-slate-800">{interviewer.displayName}</span></label>)}</div></div>)}</div>}</fieldset>
      </div>
      {mode === "SEQUENTIAL" ? <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600">각 단계의 면접관 가용 시간은 독립적으로 계산합니다. 시간 여유가 없을 때만 2차 인터뷰를 먼저 진행하는 추천이 나올 수 있습니다.</p> : null}
      {error ? <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
      {saved ? <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">예외 인터뷰 계획을 저장했습니다. 이후 면접관 일정 요청은 이 계획을 기준으로 만듭니다.</p> : null}
      <Button className="mt-5" disabled={loading || selectedStepIds.length < 2 || (mode === "COMBINED" ? selectedInterviewerIds.length === 0 : selectedStepIds.some((stepId) => (sessionInterviewerIds[stepId] ?? []).length === 0))} onClick={() => void save()}>{loading ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}예외 계획 저장</Button>
    </section>
  );
}
