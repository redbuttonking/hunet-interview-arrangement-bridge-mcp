// 대시보드 서버 화면에서 로컬 운영 데이터를 안전하게 읽는다.
import { getConfig } from "../../../../dist/src/config.js";
import { BridgeDatabase } from "../../../../dist/src/db/database.js";
import { buildCandidateJourney } from "../../../../dist/src/dashboard/candidate-journey.js";
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
    const roomBlocks = new Map(db.listMeetingRoomBlocks(undefined, false).map((block) => [block.id, block]));
    const scheduledSegments = db.listRoomAllocations(caseId)
      .filter((allocation) => allocation.status === "ACTIVE")
      .map((allocation) => {
        const block = roomBlocks.get(allocation.roomBlockId);
        return block ? {
          stepId: allocation.interviewStepId,
          roomName: block.roomName,
          date: allocation.date,
          startTime: allocation.startTime,
          endTime: allocation.endTime,
          sequenceIndex: allocation.sequenceIndex,
        } : null;
      })
      .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment))
      .sort((left, right) => left.sequenceIndex - right.sequenceIndex || `${left.date}T${left.startTime}`.localeCompare(`${right.date}T${right.startTime}`));
    const template = bundle.interviewCase.recruitmentRef
      ? db.getRecruitmentInterviewTemplate(bundle.interviewCase.recruitmentRef) ?? null
      : null;
    const plan = db.getCaseInterviewPlan(caseId) ?? null;
    return {
      bundle: {
        ...bundle,
        interviewCase: {
          ...bundle.interviewCase,
          candidateScheduleProposalSent: db.hasCandidateScheduleProposalSent(caseId),
        },
      },
      plan,
      template,
      candidateJourney: buildCandidateJourney({
        template: template ?? undefined,
        interviewCase: bundle.interviewCase,
        plannedStepIds: plan?.stepIds,
      }),
      scheduledSegments,
      events: db.listCaseEvents(caseId, 100),
    };
  } finally {
    db.close();
  }
}
