// 필수 면접관의 일정 제출이 완료된 건을 회의실과 대조해 승인용 일정 추천으로 준비한다.
import type { BridgeDatabase, InterviewSkillDecisionRow } from "../db/database.js";
import type { DaouOfficeReservationAdapter } from "../domain/daou-office.js";

export interface SchedulingDecisionCreator {
  createInterviewSchedulingDecision(caseId: string): InterviewSkillDecisionRow;
}

export interface AutomaticSchedulingPreparationResult {
  caseId: string;
  roomSync: "SYNCED" | "UNAVAILABLE";
  decision: InterviewSkillDecisionRow;
}

export class AutomaticSchedulingPreparationService {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly daouOffice: DaouOfficeReservationAdapter,
    private readonly scheduling: SchedulingDecisionCreator,
  ) {}

  async prepareReadyCases(limit = 100): Promise<AutomaticSchedulingPreparationResult[]> {
    const pendingSchedulingCaseIds = new Set(
      this.db
        .listInterviewSkillDecisions({ status: "PENDING", limit: 500 })
        .filter((decision) => decision.skillKey === "INTERVIEW_SCHEDULING" && decision.caseId)
        .map((decision) => decision.caseId!),
    );
    const results: AutomaticSchedulingPreparationResult[] = [];

    for (const interviewCase of this.db.listCases("READY_TO_SCHEDULE", limit)) {
      if (pendingSchedulingCaseIds.has(interviewCase.id)) continue;

      this.db.discardPendingInterviewSkillDecisionsForCase(
        interviewCase.id,
        "AVAILABILITY_COLLECTION",
      );

      let roomSync: AutomaticSchedulingPreparationResult["roomSync"] = "SYNCED";
      let roomSynced = true;
      try {
        const blocks = await this.daouOffice.listMeetingRoomBlocks(
          interviewCase.proposalDates,
        );
        this.db.syncMeetingRoomBlocks(interviewCase.proposalDates, blocks);
      } catch {
        roomSync = "UNAVAILABLE";
        roomSynced = false;
      }

      const decision = roomSynced
        ? this.scheduling.createInterviewSchedulingDecision(interviewCase.id)
        : this.db.createOrGetPendingInterviewSkillDecision({
          skillKey: "INTERVIEW_SCHEDULING",
          decisionType: "MEETING_ROOM_SYNC_UNAVAILABLE",
          fingerprint: `case:${interviewCase.id}:meeting-room-sync-unavailable:${interviewCase.updatedAt}`,
          caseId: interviewCase.id,
          title: "회의실 확인 필요",
          prompt:
            "면접관 일정은 모두 제출됐지만 다우오피스 회의실 예약 현황을 지금 확인할 수 없습니다.",
          selectionMode: "SINGLE",
          options: [
            {
              id: "OPEN_ROOM_SYNC",
              label: "회의실 다시 확인",
              description: "다우오피스 로그인과 회의실 예약 현황을 확인한 뒤 시간 추천을 만듭니다.",
            },
            {
              id: "HOLD",
              label: "보류",
              description: "회의실 확인이 가능할 때까지 일정 조율을 보류합니다.",
            },
          ],
          context: {
            caseId: interviewCase.id,
            candidateName: interviewCase.candidateName,
            recruitmentName: interviewCase.recruitmentName,
            proposalDates: interviewCase.proposalDates,
          },
        });

      this.db.addEvent(interviewCase.id, "SCHEDULING_RECOMMENDATION_PREPARED", "SYSTEM", {
        roomSync,
        decisionId: decision.id,
        decisionType: decision.decisionType,
      });
      results.push({ caseId: interviewCase.id, roomSync, decision });
    }

    return results;
  }
}
