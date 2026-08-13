// 인터뷰 케이스 생성 전 후보자의 채용 여정과 평가 요약을 읽기 전용으로 보여준다.
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, ClipboardList, Clock3, FileText, GitBranch } from "lucide-react";
import { AppHeader, PageHeader } from "../../components/app-shell";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { loadReviewDetail } from "../../lib/data";
import type { EvaluationSummary } from "../../lib/dashboard-types";

export const dynamic = "force-dynamic";

function formatDateTime(value: string | undefined) {
  if (!value) return "제출 시각 미확인";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function evaluationResult(scoreSheet: EvaluationSummary["scoreSheets"][number]) {
  return scoreSheet.evaluators.flatMap((evaluator) => evaluator.items)
    .filter((item) => item.finalEvaluation)
    .flatMap((item) => item.selectedOptions)
    .map((option) => option.title)
    .join(", ") || "최종 판단 미확인";
}

export default async function ReviewDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = loadReviewDetail(id);
  if (!data) notFound();
  const { review, decision, workerStatus } = data;
  const journey = review.candidateJourney;

  return (
    <div className="min-h-screen bg-slate-50">
      <AppHeader active="operations" workerStatus={workerStatus} />
      <main className="mx-auto max-w-[1120px] px-4 pb-12 sm:px-8" id="main-content">
        <div className="pt-7"><Link className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition-colors hover:text-blue-700" href="/"><ArrowLeft className="size-4" />운영 보드</Link></div>
        <PageHeader
          actions={<Badge variant={decision ? "warning" : "secondary"}>{decision ? "사용자 결정 대기" : "검토 대기"}</Badge>}
          description={review.recruitmentName ?? "채용 정보 확인 필요"}
          eyebrow="CANDIDATE OVERVIEW"
          title={review.candidateName ?? "후보자 확인 필요"}
        />

        <Card className="overflow-hidden">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-2 text-blue-600"><GitBranch className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">CANDIDATE JOURNEY</p></div>
            <CardTitle className="mt-2">채용 진행 상태</CardTitle>
            <CardDescription>{journey ? `현재 ${journey.currentStageLabel} · ${journey.currentStageDetail}` : "채용별 인터뷰 규칙을 확인하는 중입니다."}</CardDescription>
          </CardHeader>
          <CardContent className="p-6 sm:p-7">
            {journey ? <div className="overflow-x-auto pb-2"><ol aria-label="후보자 채용 여정" className="flex min-w-max items-start">
              {journey.stages.map((stage, index) => {
                const completed = stage.state === "COMPLETED";
                const current = stage.state === "CURRENT";
                const stopped = stage.state === "STOPPED";
                return <li className="flex min-w-[9.25rem] flex-1 items-start last:min-w-0" key={stage.id}>
                  <div className="grid min-w-[7.25rem] gap-2"><span aria-current={current ? "step" : undefined} className={`grid size-10 place-items-center rounded-full text-sm font-bold ${completed ? "bg-emerald-600 text-white" : current ? "bg-blue-600 text-white ring-4 ring-blue-100" : stopped ? "bg-rose-600 text-white" : "bg-slate-100 text-slate-500"}`}>{completed ? <CheckCircle2 className="size-5" /> : index + 1}</span><strong className={`text-base leading-6 ${current ? "text-slate-950" : completed ? "text-emerald-700" : stopped ? "text-rose-700" : "text-slate-500"}`}>{stage.label}</strong><span className={`text-sm leading-5 ${current ? "font-medium text-blue-700" : "text-slate-500"}`}>{stage.detail}</span></div>
                  {index < journey.stages.length - 1 ? <span aria-hidden="true" className={`mt-5 h-px min-w-6 flex-1 ${completed ? "bg-emerald-400" : "bg-slate-200"}`} /> : null}
                </li>;
              })}
            </ol></div> : <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-base text-slate-600">채용 진행 단계는 승인된 채용별 인터뷰 규칙이 있어야 표시됩니다.</p>}
          </CardContent>
        </Card>

        <section className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <Card>
            <CardHeader className="border-b border-slate-100"><div className="flex items-center gap-2 text-blue-600"><ClipboardList className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">CURRENT WORK</p></div><CardTitle className="mt-2">현재 처리할 일</CardTitle></CardHeader>
            <CardContent className="p-6"><p className="text-lg font-bold leading-7 text-slate-950">{decision?.title ?? review.reason}</p><p className="mt-3 text-base leading-7 text-slate-600">{decision?.prompt ?? "운영 보드에서 처리 방법을 선택할 수 있습니다."}</p><Link className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-blue-700 hover:text-blue-900" href="/">운영 보드에서 처리하기 <ArrowLeft className="size-4 rotate-180" /></Link></CardContent>
          </Card>
          <Card>
            <CardHeader className="border-b border-slate-100"><div className="flex items-center gap-2 text-blue-600"><Clock3 className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">NINEHIRE STATUS</p></div><CardTitle className="mt-2">나인하이어 현재 단계</CardTitle></CardHeader>
            <CardContent className="p-6"><p className="text-lg font-bold text-slate-950">{review.currentStepName ?? "현재 단계 확인 필요"}</p><p className="mt-2 text-base leading-7 text-slate-600">완료된 평가표와 현재 칸반을 기준으로 표시합니다. 이 화면에서는 나인하이어나 Slack을 변경하지 않습니다.</p></CardContent>
          </Card>
        </section>

        <Card className="mt-6">
          <CardHeader className="border-b border-slate-100"><div className="flex items-center gap-2 text-blue-600"><FileText className="size-5" /><p className="text-xs font-bold uppercase tracking-[0.16em]">EVALUATION SUMMARY</p></div><CardTitle className="mt-2">완료된 평가표 요약</CardTitle><CardDescription>나인하이어에서 동기화한 완료 평가표만 표시합니다.</CardDescription></CardHeader>
          <CardContent className="p-6 sm:p-7">{review.evaluationSummary ? <div className="grid max-h-[38rem] gap-4 overflow-y-auto pr-1" tabIndex={0} aria-label="완료된 평가표 목록">{review.evaluationSummary.scoreSheets.map((scoreSheet, scoreSheetIndex) => <article className="rounded-xl border border-slate-200 bg-slate-50/70 p-4" key={`${scoreSheet.title}-${scoreSheetIndex}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-bold text-slate-950">{scoreSheet.title}</h2><p className="mt-1 text-sm text-slate-600">{scoreSheet.evaluationMethod ?? "평가 방식 미확인"} · {formatDateTime(scoreSheet.completedAt)}</p></div><Badge variant="outline">{evaluationResult(scoreSheet)}</Badge></div><div className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white px-4">{scoreSheet.evaluators.length > 0 ? scoreSheet.evaluators.map((evaluator, evaluatorIndex) => <div className="py-3 first:pt-3 last:pb-3" key={`${evaluator.name}-${evaluatorIndex}`}><p className="font-semibold text-slate-900">{evaluator.name}<span className="ml-2 text-sm font-normal text-slate-500">{formatDateTime(evaluator.submittedAt)}</span></p>{evaluator.comment ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">{evaluator.comment}</p> : null}</div>) : <p className="py-3 text-sm text-slate-500">제출한 평가자가 없습니다.</p>}</div></article>)}</div> : <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-base text-slate-600">동기화된 완료 평가표가 없습니다.</p>}</CardContent>
        </Card>
      </main>
    </div>
  );
}
