// 회의실 예약 블록과 인터뷰 배정 시간표를 렌더링한다.
import { RoomsClient } from "../components/rooms-client";
import { loadDashboardSnapshot } from "../lib/data";

export const dynamic = "force-dynamic";

export default function RoomsPage() {
  return <RoomsClient data={loadDashboardSnapshot()} />;
}
