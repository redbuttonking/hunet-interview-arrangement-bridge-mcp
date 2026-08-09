// 존재하지 않거나 삭제된 후보자 상세 주소에 대한 안내를 제공한다.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "./components/ui/button";

export default function DashboardNotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4" id="main-content">
      <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
        <p className="text-sm font-bold uppercase tracking-[0.16em] text-blue-600">INTERVIEW OPERATIONS</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">해당 후보자 정보를 찾을 수 없습니다.</h1>
        <p className="mt-3 text-base leading-7 text-slate-600">주소가 잘못되었거나, 조율 건이 종료되어 운영 목록에서 제외되었을 수 있습니다.</p>
        <Button asChild className="mt-6" variant="outline">
          <Link href="/"><ArrowLeft className="size-4" />운영 보드로 돌아가기</Link>
        </Button>
      </section>
    </main>
  );
}
