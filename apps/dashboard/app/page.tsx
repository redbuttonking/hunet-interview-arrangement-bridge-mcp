// 인터뷰 조율 운영 보드의 초기 데이터를 읽어 화면에 전달한다.
import { DashboardClient } from "./components/dashboard-client";
import { loadDashboardSnapshot } from "./lib/data";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return <DashboardClient initialData={loadDashboardSnapshot()} />;
}
