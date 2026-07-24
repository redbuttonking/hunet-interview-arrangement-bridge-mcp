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
});
