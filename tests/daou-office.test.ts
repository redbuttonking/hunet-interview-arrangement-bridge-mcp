// 다우오피스 예약에서 허용된 면접실 블록만 추출하는 규칙을 검증한다.
import { describe, expect, it } from "vitest";
import { toMeetingRoomBlock } from "../src/domain/daou-office.js";

const reservation = {
  id: 100,
  itemId: 103,
  itemName: "[818호] 행복룸",
  user: { name: "강해빈" },
  startTime: "2026-07-27T15:00:00.000+09:00",
  endTime: "2026-07-27T18:00:00.000+09:00",
  properties: [{ attributeId: 10, content: "면접" }],
};

describe("DaouOffice meeting room policy", () => {
  it("keeps only the configured room, reserver, and interview purpose", () => {
    expect(toMeetingRoomBlock(reservation, 10)).toMatchObject({
      sourceKey: "DAOU:100",
      roomId: "103",
      roomName: "[818호] 행복룸",
      reservedBy: "강해빈",
      purpose: "면접",
      date: "2026-07-27",
      startTime: "15:00",
      endTime: "18:00",
    });
    expect(
      toMeetingRoomBlock(
        { ...reservation, user: { name: "다른 예약자" } },
        10,
      ),
    ).toBeUndefined();
    expect(
      toMeetingRoomBlock(
        { ...reservation, properties: [{ attributeId: 10, content: "회의" }] },
        10,
      ),
    ).toBeUndefined();
    expect(
      toMeetingRoomBlock({ ...reservation, itemName: "[818호] 일반 회의실" }, 10),
    ).toBeUndefined();
  });
});
