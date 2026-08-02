// 대시보드 서버 화면에서 로컬 운영 데이터를 안전하게 읽는다.
import { getConfig } from "../../../../dist/src/config.js";
import { BridgeDatabase } from "../../../../dist/src/db/database.js";
import { getDashboardSnapshot } from "../../../../dist/src/dashboard/service.js";
import type { DashboardSnapshot } from "./dashboard-types";

export function loadDashboardSnapshot(): DashboardSnapshot {
  const config = getConfig();
  const db = new BridgeDatabase(config.dbPath);
  try {
    return getDashboardSnapshot(db, 200) as unknown as DashboardSnapshot;
  } finally {
    db.close();
  }
}

export function loadCaseDetail(caseId: string) {
  const config = getConfig();
  const db = new BridgeDatabase(config.dbPath);
  try {
    const bundle = db.getCaseBundle(caseId);
    if (!bundle) return undefined;
    return {
      bundle,
      plan: db.getCaseInterviewPlan(caseId) ?? null,
      template: bundle.interviewCase.recruitmentRef
        ? db.getRecruitmentInterviewTemplate(bundle.interviewCase.recruitmentRef) ?? null
        : null,
      events: db.listCaseEvents(caseId, 100),
    };
  } finally {
    db.close();
  }
}
