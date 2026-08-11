// 일정 선택 직전에 다우오피스 회의실 예약을 다시 읽어 오래된 추천을 막는다.
import type { BridgeDatabase, InterviewSkillDecisionRow } from "../db/database.js";
import type { DaouOfficeReservationAdapter } from "../domain/daou-office.js";
import type { SchedulingDecisionCreator } from "./automatic-scheduling-preparation.js";

const SCHEDULING_SELECTION_DECISION_TYPES = new Set([
  "CONFIRM_STANDARD_SCHEDULE",
  "CONFIRM_SEQUENTIAL_SCHEDULE",
]);

export class ScheduleSelectionRevalidationService {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly daouOffice: DaouOfficeReservationAdapter,
    private readonly scheduling: SchedulingDecisionCreator,
  ) {}

  async refreshIfNeeded(
    decision: InterviewSkillDecisionRow,
  ): Promise<InterviewSkillDecisionRow | undefined> {
    if (
      !decision.caseId
      || !SCHEDULING_SELECTION_DECISION_TYPES.has(decision.decisionType)
    ) {
      return undefined;
    }
    const interviewCase = this.db.getCase(decision.caseId);
    if (!interviewCase) throw new Error(`Case not found: ${decision.caseId}`);

    const blocks = await this.daouOffice.listMeetingRoomBlocks(
      interviewCase.proposalDates,
    );
    this.db.syncMeetingRoomBlocks(interviewCase.proposalDates, blocks);
    const refreshed = this.scheduling.createInterviewSchedulingDecision(interviewCase.id);
    if (refreshed.id === decision.id) return undefined;

    this.db.discardPendingInterviewSkillDecision(decision.id);
    this.db.addEvent(interviewCase.id, "SCHEDULING_RECOMMENDATION_REFRESHED", "SYSTEM", {
      previousDecisionId: decision.id,
      refreshedDecisionId: refreshed.id,
      refreshedDecisionType: refreshed.decisionType,
    });
    return refreshed;
  }
}
