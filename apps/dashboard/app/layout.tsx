// 로컬 인터뷰 어레인지 대시보드의 공통 문서 구조를 정의한다.
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "인터뷰 어레인지 운영",
  description: "로컬 인터뷰 어레인지 운영 대시보드",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
