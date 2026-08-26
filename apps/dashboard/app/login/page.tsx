// 대시보드 단일 관리자 로그인 화면을 제공한다.

import { LoginForm } from "../components/login-form";

type LoginPageProps = {
  searchParams: Promise<{ next?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { next } = await searchParams;
  const safeNext = next?.startsWith("/") && !next.startsWith("//") ? next : "/";

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 py-10">
      <LoginForm nextPath={safeNext} />
    </main>
  );
}
