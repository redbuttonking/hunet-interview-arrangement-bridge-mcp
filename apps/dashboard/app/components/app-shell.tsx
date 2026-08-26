// 모든 대시보드 화면에 같은 탐색과 페이지 제목 체계를 제공한다.

import Link from "next/link";
import { CalendarDays, CircleAlert, CircleCheck, LayoutDashboard, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { LogoutButton } from "./logout-button";

type AppHeaderProps = {
  active: "operations" | "rooms" | "management";
  workerStatus?: string;
};

export function AppHeader({ active, workerStatus }: AppHeaderProps) {
  const isRunning = workerStatus === "RUNNING";

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/90 bg-white/85 shadow-[0_1px_12px_rgb(15_23_42_/_0.04)] backdrop-blur-xl" role="banner">
      <Link className="sr-only z-50 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4" href="#main-content">본문으로 건너뛰기</Link>
      <div className="mx-auto flex h-16 max-w-[1440px] min-w-0 items-center gap-4 px-4 sm:gap-8 sm:px-8">
        <Link aria-label="HUNET OPS 운영 홈" className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-lg font-semibold tracking-tight text-slate-950 focus-visible:outline-none" href="/">
          <img
            alt="HUNET OPS"
            className="h-7 w-auto object-contain sm:h-8"
            src="/hunet-logotype-red.png"
          />
        </Link>
        <nav className="flex h-full items-center gap-1" aria-label="대시보드 메뉴">
          <Link aria-current={active === "operations" ? "page" : undefined} className={cn("flex h-full items-center gap-2 border-b-2 px-2 text-[0.9375rem] font-semibold transition-colors focus-visible:outline-none sm:px-3", active === "operations" ? "border-blue-600 text-slate-950" : "border-transparent text-slate-500 hover:text-slate-950")} href="/">
            <LayoutDashboard className="size-4" />운영
          </Link>
          <Link aria-current={active === "rooms" ? "page" : undefined} className={cn("flex h-full items-center gap-2 border-b-2 px-2 text-[0.9375rem] font-semibold transition-colors focus-visible:outline-none sm:px-3", active === "rooms" ? "border-blue-600 text-slate-950" : "border-transparent text-slate-500 hover:text-slate-950")} href="/rooms">
            <CalendarDays className="size-4" />회의실
          </Link>
        </nav>
        <Link
          aria-current={active === "management" ? "page" : undefined}
          aria-label="관리"
          className={cn(
            "ml-auto inline-flex size-9 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none",
            active === "management"
              ? "border-blue-200 bg-blue-50 text-blue-700"
              : "border-transparent text-slate-500 hover:border-slate-200 hover:bg-slate-100 hover:text-slate-950",
          )}
          href="/management"
          title="관리"
        >
          <Settings className="size-4" />
        </Link>
        <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm font-medium text-slate-600 sm:px-3">
          {workerStatus ? (
            <><span aria-hidden="true" className={cn("grid size-5 place-items-center rounded-full", isRunning ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}>{isRunning ? <CircleCheck className="size-3.5" /> : <CircleAlert className="size-3.5" />}</span><span className="hidden sm:inline" title={`워커 상태: ${workerStatus}`}>워커 {isRunning ? "정상 작동" : "확인 필요"}</span></>
          ) : <span className="hidden sm:inline">로컬 인터뷰 운영</span>}
        </div>
        <LogoutButton />
      </div>
    </header>
  );
}

type PageHeaderProps = {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
};

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <section className="flex flex-col justify-between gap-6 py-10 sm:flex-row sm:items-end sm:py-12">
      <div>
        <p className="text-sm font-bold uppercase tracking-[0.16em] text-blue-600">{eyebrow}</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-[-0.04em] text-slate-950 sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-2xl text-[0.9375rem] leading-7 text-slate-600 sm:text-base">{description}</p>
      </div>
      {actions ? <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">{actions}</div> : null}
    </section>
  );
}
