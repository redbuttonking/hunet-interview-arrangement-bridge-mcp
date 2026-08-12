// 로컬 인터뷰 운영 대시보드의 공통 문서 구조를 제공한다.

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  icons: {
    icon: "/hunet-symboltype-red.png",
  },
  title: "인터뷰 운영 대시보드",
  description: "나인하이어, Slack, 다우오피스 기반 로컬 인터뷰 운영 화면입니다.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
