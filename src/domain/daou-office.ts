// 다우오피스 예약 응답에서 인터뷰 회의실 블록만 추출하는 도메인 규칙을 제공한다.
import { createHash } from "node:crypto";
export const DAOU_INTERVIEW_ROOM_NAMES = [
  "열정룸",
  "행복룸",
  "게임체인저",
  "疑問堂(의문당)",
];

export const DAOU_MEETING_ROOM_ASSET_NAME = "1. 회의실";

export const DAOU_ALLOWED_RESERVER_NAMES = ["박현수", "강해빈", "김성은"];

export interface DaouRoomItem {
  id: number;
  assetId: number;
  name: string;
}

export interface DaouReservation {
  id: number;
  itemId: number;
  itemName: string;
  user?: { name?: string };
  startTime: string;
  endTime: string;
  properties?: Array<{ attributeId: number; content?: string }>;
}

export interface MeetingRoomBlockInput {
  sourceKey: string;
  roomId: string;
  roomName: string;
  reservedBy: string;
  purpose: string;
  date: string;
  startTime: string;
  endTime: string;
  sourcePayloadHash: string;
}

export interface DaouOfficeReservationAdapter {
  listMeetingRoomBlocks(dates: string[]): Promise<MeetingRoomBlockInput[]>;
}

function localDateAndTime(value: string): { date: string; time: string } {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) {
    throw new Error(`Unsupported DaouOffice date value: ${value}`);
  }
  return { date: match[1]!, time: match[2]! };
}

function isInterviewRoom(name: string): boolean {
  return DAOU_INTERVIEW_ROOM_NAMES.some((roomName) => name.includes(roomName));
}

export function toMeetingRoomBlock(
  reservation: DaouReservation,
  purposeAttributeId: number,
): MeetingRoomBlockInput | undefined {
  if (!isInterviewRoom(reservation.itemName)) return undefined;
  const reservedBy = reservation.user?.name?.trim();
  if (!reservedBy || !DAOU_ALLOWED_RESERVER_NAMES.includes(reservedBy)) {
    return undefined;
  }
  const purpose = reservation.properties
    ?.find((property) => property.attributeId === purposeAttributeId)
    ?.content?.trim();
  if (purpose !== "면접") return undefined;

  const start = localDateAndTime(reservation.startTime);
  const end = localDateAndTime(reservation.endTime);
  if (start.date !== end.date || start.time >= end.time) {
    throw new Error(`Unsupported DaouOffice reservation period: ${reservation.id}`);
  }
  return {
    sourceKey: `DAOU:${reservation.id}`,
    roomId: String(reservation.itemId),
    roomName: reservation.itemName,
    reservedBy,
    purpose,
    date: start.date,
    startTime: start.time,
    endTime: end.time,
    sourcePayloadHash: createHash("sha256")
      .update(
        JSON.stringify({
          id: reservation.id,
          itemId: reservation.itemId,
          reservedBy,
          purpose,
          startTime: reservation.startTime,
          endTime: reservation.endTime,
        }),
      )
      .digest("hex"),
  };
}
