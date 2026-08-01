// 모든 대시보드 화면에 같은 탐색과 페이지 제목 체계를 제공한다.

import Link from "next/link";
import { CalendarDays, CircleAlert, CircleCheck, LayoutDashboard } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

type AppHeaderProps = {
  active: "operations" | "rooms";
  workerStatus?: string;
};

export function AppHeader({ active, workerStatus }: AppHeaderProps) {
  const isRunning = workerStatus === "RUNNING";

  return (
    <header className="border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-7 px-5 sm:px-8">
        <Link className="flex items-center gap-2.5 font-semibold tracking-tight text-slate-950" href="/">
          <span className="grid size-8 place-items-center rounded-lg bg-slate-900 text-xs font-bold text-white">H</span>
          <span>HUNET <b className="font-semibold text-blue-600">OPS</b></span>
        </Link>
        <nav className="flex h-full items-center gap-1" aria-label="대시보드 메뉴">
          <Link className={cn("flex h-full items-center gap-2 border-b-2 px-3 text-sm font-semibold transition-colors", active === "operations" ? "border-blue-600 text-slate-950" : "border-transparent text-slate-500 hover:text-slate-950")} href="/">
            <LayoutDashboard className="size-4" />운영
          </Link>
          <Link className={cn("flex h-full items-center gap-2 border-b-2 px-3 text-sm font-semibold transition-colors", active === "rooms" ? "border-blue-600 text-slate-950" : "border-transparent text-slate-500 hover:text-slate-950")} href="/rooms">
            <CalendarDays className="size-4" />회의실
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-2 text-sm font-medium text-slate-600">
          {workerStatus ? (
            <><span className={cn("grid size-5 place-items-center rounded-full", isRunning ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600")}>{isRunning ? <CircleCheck className="size-3.5" /> : <CircleAlert className="size-3.5" />}</span><span className="hidden sm:inline">워커 {isRunning ? "정상" : workerStatus}</span></>
          ) : <span className="hidden sm:inline">로컬 인터뷰 운영</span>}
        </div>
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
    <section className="flex flex-col justify-between gap-5 py-9 sm:flex-row sm:items-end sm:py-11">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">{eyebrow}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </section>
  );
}
