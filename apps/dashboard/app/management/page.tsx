// 설치형 인터뷰 운영 앱의 사용자별 연동 설정을 관리하는 화면이다.

import { AppHeader, PageHeader } from "../components/app-shell";
import { ManagementSettingsClient } from "../components/management-settings-client";
import { loadDashboardSnapshot } from "../lib/data";
import { getManagementSettings } from "../../../../dist/src/installation/management-settings.js";

export const dynamic = "force-dynamic";

export default async function ManagementPage() {
  const [snapshot, settings] = await Promise.all([
    Promise.resolve(loadDashboardSnapshot()),
    getManagementSettings(),
  ]);
  return (
    <>
      <AppHeader active="management" workerStatus={snapshot.dashboard.summary.worker.status} />
      <main className="mx-auto max-w-[1440px] px-4 sm:px-8" id="main-content">
        <PageHeader eyebrow="ADMINISTRATION" title="관리" description="이 PC에서 사용하는 인터뷰 운영 연동을 관리합니다. 변경한 Slack 채널은 워커를 다시 시작한 뒤 적용됩니다." />
        <ManagementSettingsClient initialSettings={settings} />
      </main>
    </>
  );
}
