"use client";

// 단일 관리자 로그인을 처리하고 대시보드로 이동한다.

import { FormEvent, useState } from "react";
import { LockKeyhole, LoaderCircle } from "lucide-react";
import { Button } from "./ui/button";

type LoginFormProps = {
  nextPath: string;
};

export function LoginForm({ nextPath }: LoginFormProps) {
  const [email, setEmail] = useState("hr@hunet.co.kr");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "로그인하지 못했습니다.");
      window.location.assign(nextPath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "로그인하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-[0_18px_45px_rgb(15_23_42_/_0.12)] sm:p-8">
      <div className="flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-xl bg-red-50 text-red-700"><LockKeyhole className="size-5" /></span>
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.14em] text-red-600">HUNET OPS</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">운영자 로그인</h1>
        </div>
      </div>
      <p className="mt-5 text-[0.9375rem] leading-6 text-slate-600">이 컴퓨터의 인터뷰 운영 정보에 접근하려면 로그인하세요.</p>

      <form className="mt-7 grid gap-5" onSubmit={submit}>
        <label className="grid gap-2 text-sm font-semibold text-slate-800">
          아이디
          <input autoComplete="username" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
        </label>
        <label className="grid gap-2 text-sm font-semibold text-slate-800">
          비밀번호
          <input autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
        </label>
        {error ? <p aria-live="polite" className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm leading-6 text-rose-800">{error}</p> : null}
        <Button className="mt-1 w-full" disabled={submitting} size="lg" type="submit">
          {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
          로그인
        </Button>
      </form>
    </section>
  );
}
