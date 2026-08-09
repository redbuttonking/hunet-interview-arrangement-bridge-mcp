// 대시보드 데이터를 읽는 동안 화면 구조를 유지하는 로딩 표시를 제공한다.

export default function DashboardLoading() {
  return (
    <main aria-busy="true" aria-label="인터뷰 운영 정보를 불러오는 중" className="min-h-screen bg-slate-50 px-4 py-10 sm:px-8">
      <div className="mx-auto max-w-[1440px] animate-pulse">
        <div className="h-5 w-40 rounded bg-slate-200" />
        <div className="mt-4 h-10 w-72 max-w-full rounded bg-slate-200" />
        <div className="mt-3 h-6 w-full max-w-xl rounded bg-slate-100" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <div className="h-32 rounded-2xl border border-slate-200 bg-white" key={index} />)}
        </div>
        <div className="mt-6 h-[32rem] rounded-2xl border border-slate-200 bg-white" />
      </div>
    </main>
  );
}
