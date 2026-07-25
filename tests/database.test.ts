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
});
