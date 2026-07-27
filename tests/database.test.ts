import { afterEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../src/db/database.js";

let db: BridgeDatabase | undefined;
afterEach(() => db?.close());

describe("BridgeDatabase", () => {
  it("deduplicates Slack messages and preserves excluded interviewer history", () => {
    db = new BridgeDatabase(":memory:");
    const input = {
      channelId: "C1",
      messageTs: "1.0",
      eventType: "EVALUATION_COMPLETED",
      title: "서류 평가가 완료되었습니다.",
      payloadHash: "hash",
      payloadJson: "{}",
    };
    const first = db.insertNotification(input, "EVALUATION_LOOKUP_PENDING");
    const second = db.insertNotification(input, "EVALUATION_LOOKUP_PENDING");
    expect(first.inserted).toBe(true);
    expect(second).toEqual({ id: first.id, inserted: false });

    const interviewCase = db.createInterviewCase({
      notificationId: first.id,
      candidateName: "홍길동",
      proposalDates: ["2026-07-30"],
    });
    const interviewer = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "김면접",
      slackUserId: "U1",
      ninehireUserId: "N1",
      source: "NINEHIRE",
    });
    db.excludeInterviewer(interviewCase.id, interviewer.id);
    db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "김면접",
      slackUserId: "U1",
      ninehireUserId: "N1",
      source: "NINEHIRE",
    });

    expect(db.listInterviewers(interviewCase.id)).toHaveLength(0);
    expect(db.listInterviewers(interviewCase.id, false)[0]?.active).toBe(false);
    expect(db.listInterviewers(interviewCase.id, false)[0]?.status).toBe(
      "EXCLUDED_BY_USER",
    );
  });

  it("stores internal room allocations without overlapping a pre-booked block", () => {
    db = new BridgeDatabase(":memory:");
    const firstCase = db.createInterviewCase({
      candidateName: "지원자 1",
      proposalDates: ["2026-07-30"],
    });
    const secondCase = db.createInterviewCase({
      candidateName: "지원자 2",
      proposalDates: ["2026-07-30"],
    });
    const [block] = db.syncMeetingRoomBlocks(
      ["2026-07-30"],
      [
        {
          sourceKey: "DAOU:1",
          roomId: "103",
          roomName: "[818호] 행복룸",
          reservedBy: "강해빈",
          purpose: "면접",
          date: "2026-07-30",
          startTime: "15:00",
          endTime: "18:00",
          sourcePayloadHash: "hash",
        },
      ],
    );
    expect(block).toBeDefined();
    const first = db.allocateRoomBlock({
      caseId: firstCase.id,
      roomBlockId: block!.id,
      startTime: "15:00",
      endTime: "16:00",
    });
    expect(first.status).toBe("ACTIVE");
    expect(() =>
      db!.allocateRoomBlock({
        caseId: secondCase.id,
        roomBlockId: block!.id,
        startTime: "15:30",
        endTime: "16:30",
      }),
    ).toThrow("already allocated");
    expect(
      db.allocateRoomBlock({
        caseId: secondCase.id,
        roomBlockId: block!.id,
        startTime: "16:00",
        endTime: "17:00",
      }),
    ).toMatchObject({ status: "ACTIVE", startTime: "16:00" });
  });

  it("confirms an allocated room slot while preserving the candidate confirmation boundary", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "지원자 1",
      proposalDates: ["2026-07-30"],
    });
    const [block] = db.syncMeetingRoomBlocks(
      ["2026-07-30"],
      [
        {
          sourceKey: "DAOU:confirmed",
          roomId: "103",
          roomName: "[818호] 행복룸",
          reservedBy: "강해빈",
          purpose: "면접",
          date: "2026-07-30",
          startTime: "15:00",
          endTime: "18:00",
          sourcePayloadHash: "confirmed-hash",
        },
      ],
    );
    const allocation = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: block!.id,
      startTime: "15:00",
      endTime: "16:00",
    });
    db!.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");

    const confirmed = db!.confirmInternalSchedule(interviewCase.id);

    expect(confirmed).toMatchObject({
      roomAllocationId: allocation.id,
      date: "2026-07-30",
      startTime: "15:00",
      endTime: "16:00",
      roomName: "[818호] 행복룸",
    });
    expect(db!.getCase(interviewCase.id)).toMatchObject({
      status: "AWAITING_CANDIDATE_CONFIRMATION",
      scheduledRoomAllocationId: allocation.id,
    });
    expect(() =>
      db!.cancelRoomAllocation(interviewCase.id, allocation.id),
    ).toThrow("internally confirmed schedule");
  });

  it("reopens a confirmed schedule without reusing stale availability", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "지원자 1",
      proposalDates: ["2026-07-30"],
    });
    const interviewer = db.addOrUpdateInterviewer({
      caseId: interviewCase.id,
      displayName: "면접관 1",
      slackUserId: "U1",
      source: "MANUAL",
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    db.replaceAvailabilityForInterviewer(interviewCase.id, interviewer.id, [
      { date: "2026-07-30", start: "15:00", end: "16:00" },
    ]);
    const [block] = db.syncMeetingRoomBlocks(
      ["2026-07-30"],
      [
        {
          sourceKey: "DAOU:reschedule",
          roomId: "103",
          roomName: "[818호] 행복룸",
          reservedBy: "강해빈",
          purpose: "면접",
          date: "2026-07-30",
          startTime: "15:00",
          endTime: "18:00",
          sourcePayloadHash: "reschedule-hash",
        },
      ],
    );
    const allocation = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: block!.id,
      startTime: "15:00",
      endTime: "16:00",
    });
    db.confirmInternalSchedule(interviewCase.id);
    const sentDraft = db.createDraft({
      caseId: interviewCase.id,
      channelId: "C1",
      previewText: "기존 일정 안내",
      blocksJson: "[]",
      payloadHash: "sent-schedule-confirmation",
      messageType: "SCHEDULE_CONFIRMATION",
    });
    db.approveDraft(sentDraft.id);
    db.markDraftSent(sentDraft.id, "100.0");

    const reopened = db.reopenScheduleForReschedule({
      caseId: interviewCase.id,
      availabilityPolicy: "RECOLLECT",
      reason: "후보자가 일정 변경을 요청했습니다.",
    });

    expect(reopened).toMatchObject({
      previousSchedule: { roomAllocationId: allocation.id },
      hadSentScheduleConfirmation: true,
      interviewCase: { status: "READY_FOR_DRAFT", scheduleRound: 2 },
    });
    expect(db.listRoomAllocations(interviewCase.id)).toMatchObject([
      { id: allocation.id, status: "CANCELLED" },
    ]);
    expect(db.getCaseBundle(interviewCase.id)?.availability).toEqual([]);
    expect(db.listInterviewers(interviewCase.id)[0]?.status).toBe("PENDING");

    const cancelled = db.cancelInterviewArrangement({
      caseId: interviewCase.id,
      reason: "재조율 중 후보자가 인터뷰를 취소했습니다.",
    });
    expect(cancelled).toMatchObject({
      previousSchedule: { roomAllocationId: allocation.id },
      interviewCase: { status: "CANCELLED" },
    });
  });

  it("cancels an arrangement and releases its local room allocation", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "지원자 2",
      proposalDates: ["2026-07-30"],
    });
    const [block] = db.syncMeetingRoomBlocks(
      ["2026-07-30"],
      [
        {
          sourceKey: "DAOU:cancel",
          roomId: "103",
          roomName: "[818호] 행복룸",
          reservedBy: "강해빈",
          purpose: "면접",
          date: "2026-07-30",
          startTime: "15:00",
          endTime: "18:00",
          sourcePayloadHash: "cancel-hash",
        },
      ],
    );
    const allocation = db.allocateRoomBlock({
      caseId: interviewCase.id,
      roomBlockId: block!.id,
      startTime: "15:00",
      endTime: "16:00",
    });
    db.setCaseStatus(interviewCase.id, "READY_TO_SCHEDULE");
    db.confirmInternalSchedule(interviewCase.id);

    const cancelled = db.cancelInterviewArrangement({
      caseId: interviewCase.id,
      reason: "후보자가 인터뷰를 취소했습니다.",
    });

    expect(cancelled.interviewCase.status).toBe("CANCELLED");
    expect(db.listRoomAllocations(interviewCase.id)).toMatchObject([
      { id: allocation.id, status: "CANCELLED" },
    ]);
    expect(db.getStatus()).toMatchObject({ activeCases: 0 });
  });

  it("tracks and resolves external follow-ups for a cancelled arrangement", () => {
    db = new BridgeDatabase(":memory:");
    const interviewCase = db.createInterviewCase({
      candidateName: "테스트1",
      recruitmentName: "인터뷰 어레인지 자동화 테스트 채용",
      proposalDates: ["2026-07-30"],
    });
    db.cancelInterviewArrangement({
      caseId: interviewCase.id,
      reason: "후보자 불참으로 취소합니다.",
    });

    const followUps = db.createCancellationExternalFollowUps(interviewCase.id);
    expect(followUps).toMatchObject([
      { followUpType: "NINEHIRE_CANDIDATE_SCHEDULE", status: "PENDING" },
      { followUpType: "DAOU_ROOM_RESERVATION", status: "PENDING" },
    ]);
    expect(db.backfillCancellationExternalFollowUps()).toEqual({
      cancelledCases: 1,
      followUpsCreated: 0,
    });

    const daouFollowUp = followUps.find(
      (item) => item.followUpType === "DAOU_ROOM_RESERVATION",
    )!;
    expect(
      db.resolveCancellationExternalFollowUp({
        followUpId: daouFollowUp.id,
        status: "NOT_REQUIRED",
        resolutionNote: "공용 3시간 회의실 예약은 유지합니다.",
      }),
    ).toMatchObject({ status: "NOT_REQUIRED" });
    expect(db.getOperationsDashboard()).toMatchObject({
      summary: {
        caseCountsByStatus: { CANCELLED: 1 },
        pendingCancellationExternalFollowUps: 1,
      },
      cases: [
        {
          candidateName: "테스트1",
          status: "CANCELLED",
          cancellationExternalFollowUps: [
            { status: "PENDING" },
            { status: "NOT_REQUIRED" },
          ],
        },
      ],
    });
  });
});
