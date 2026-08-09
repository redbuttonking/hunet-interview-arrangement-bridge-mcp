"use client";
// 대시보드 화면을 불러오지 못했을 때 다시 시도할 수 있는 오류 화면을 제공한다.

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "./components/ui/button";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("대시보드 화면 오류", error);
  }, [error]);

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4" id="main-content">
      <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
        <AlertTriangle aria-hidden="true" className="size-9 text-amber-600" />
        <p className="mt-5 text-sm font-bold uppercase tracking-[0.16em] text-blue-600">INTERVIEW OPERATIONS</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">운영 화면을 불러오지 못했습니다.</h1>
        <p className="mt-3 text-base leading-7 text-slate-600">잠시 후 다시 시도해 주세요. 계속 발생하면 워커와 로컬 데이터베이스 상태를 확인해 주세요.</p>
        <Button className="mt-6" onClick={reset}>
          <RefreshCw className="size-4" />
          다시 시도
        </Button>
      </section>
    </main>
  );
}
