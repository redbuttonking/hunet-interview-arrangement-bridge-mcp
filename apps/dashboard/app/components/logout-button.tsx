"use client";

// 현재 대시보드 세션을 종료한다.

import { useState } from "react";
import { LogOut } from "lucide-react";

export function LogoutButton() {
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  };

  return (
    <button aria-label="로그아웃" className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-transparent text-slate-500 transition-colors hover:border-slate-200 hover:bg-slate-100 hover:text-slate-950" disabled={signingOut} onClick={() => void signOut()} title="로그아웃" type="button">
      <LogOut className="size-4" />
    </button>
  );
}
