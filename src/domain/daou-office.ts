import type { TimeSlot } from "./types.js";

export interface MeetingRoomAvailability {
  roomId: string;
  roomName: string;
  availableSlots: TimeSlot[];
}

/**
 * Integration boundary intentionally kept for phase 2.
 * No DaouOffice credentials or API assumptions are made in the current phase.
 */
export interface DaouOfficeCalendarAdapter {
  listMeetingRoomAvailability(
    candidateSlots: TimeSlot[],
  ): Promise<MeetingRoomAvailability[]>;
}

export class DeferredDaouOfficeAdapter implements DaouOfficeCalendarAdapter {
  async listMeetingRoomAvailability(): Promise<MeetingRoomAvailability[]> {
    throw new Error(
      "DaouOffice integration is deferred. Meeting-room availability is not checked yet.",
    );
  }
}
