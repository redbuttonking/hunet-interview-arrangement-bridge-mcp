// 인증된 전용 Chrome 브라우저를 통해 다우오피스 인터뷰 회의실 예약 블록을 읽는다.
import { chromium, type Page } from "playwright-core";
import type { AppConfig } from "../config.js";
import {
  parseDaouInterviewCalendarEntries,
  parseDaouInterviewCalendarText,
  type DaouInterviewCalendarEntry,
  type DaouInterviewCalendarEvent,
} from "../domain/daou-calendar.js";
import {
  DAOU_INTERVIEW_ROOM_NAMES,
  DAOU_MEETING_ROOM_ASSET_NAME,
  toMeetingRoomBlock,
  type DaouOfficeReservationAdapter,
  type DaouReservation,
  type DaouRoomItem,
  type MeetingRoomBlockInput,
} from "../domain/daou-office.js";
import { daouOfficeDebugUrl } from "./browser.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Unexpected DaouOffice ${label} response.`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Unexpected DaouOffice ${label} response.`);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function extractRoomItem(value: unknown): DaouRoomItem | undefined {
  const item = asRecord(value, "room item");
  const id = numberValue(item.id);
  const assetId = numberValue(item.assetId);
  const name = stringValue(item.name);
  if (!id || !assetId || !name) return undefined;
  return { id, assetId, name };
}

function extractReservation(value: unknown): DaouReservation | undefined {
  const reservation = asRecord(value, "reservation");
  const id = numberValue(reservation.id);
  const itemId = numberValue(reservation.itemId);
  const itemName = stringValue(reservation.itemName);
  const startTime = stringValue(reservation.startTime);
  const endTime = stringValue(reservation.endTime);
  if (!id || !itemId || !itemName || !startTime || !endTime) return undefined;

  const user = reservation.user
    ? { name: stringValue(asRecord(reservation.user, "reservation user").name) }
    : undefined;
  const properties = Array.isArray(reservation.properties)
    ? reservation.properties.flatMap((value) => {
        const property = asRecord(value, "reservation property");
        const attributeId = numberValue(property.attributeId);
        return attributeId
          ? [{ attributeId, content: stringValue(property.content) }]
          : [];
      })
    : undefined;
  return { id, itemId, itemName, user, startTime, endTime, properties };
}

function weekStart(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  parsed.setUTCDate(parsed.getUTCDate() - parsed.getUTCDay());
  return parsed.toISOString().slice(0, 10);
}

function isInterviewRoom(name: string): boolean {
  return DAOU_INTERVIEW_ROOM_NAMES.some((roomName) => name.includes(roomName));
}

export class BrowserDaouOfficeReservationAdapter
  implements DaouOfficeReservationAdapter
{
  constructor(private readonly config: AppConfig["daouOffice"]) {}

  async listMeetingRoomBlocks(dates: string[]): Promise<MeetingRoomBlockInput[]> {
    const requestedDates = new Set(dates);
    if (requestedDates.size === 0) return [];
    const browser = await chromium
      .connectOverCDP(daouOfficeDebugUrl(this.config.remoteDebugPort))
      .catch(() => {
        throw new Error(
          "DaouOffice dedicated browser is not running. Run open_daou_office_login and sign in first.",
        );
      });
    try {
      const page = await this.assetPage(browser.contexts().flatMap((context) => context.pages()));
      const rooms = await this.findInterviewRooms(page);
      const purposeAttributeIds = new Map<number, number>();
      for (const room of rooms) {
        if (!purposeAttributeIds.has(room.assetId)) {
          purposeAttributeIds.set(
            room.assetId,
            await this.findPurposeAttributeId(page, room.assetId),
          );
        }
      }

      const weeks = [...new Set([...requestedDates].map(weekStart))];
      const blocks = new Map<string, MeetingRoomBlockInput>();
      for (const room of rooms) {
        const purposeAttributeId = purposeAttributeIds.get(room.assetId);
        if (purposeAttributeId === undefined) continue;
        for (const week of weeks) {
          for (const reservation of await this.weeklyReservations(page, room, week)) {
            const block = toMeetingRoomBlock(reservation, purposeAttributeId);
            if (block && requestedDates.has(block.date)) {
              blocks.set(block.sourceKey, block);
            }
          }
        }
      }
      return [...blocks.values()].sort((left, right) =>
        `${left.date}${left.startTime}${left.roomName}`.localeCompare(
          `${right.date}${right.startTime}${right.roomName}`,
        ),
      );
    } finally {
      await browser.close();
    }
  }

  async listInterviewCalendarEvents(): Promise<DaouInterviewCalendarEvent[]> {
    const browser = await chromium
      .connectOverCDP(daouOfficeDebugUrl(this.config.remoteDebugPort))
      .catch(() => {
        throw new Error(
          "DaouOffice dedicated browser is not running. Run open_daou_office_login and sign in first.",
        );
      });
    try {
      const page = await this.calendarPage(browser.contexts().flatMap((context) => context.pages()));
      await this.ensureInterviewCalendars(page);
      await page.waitForTimeout(300);
      const apiEvents = await this.calendarInterviewEvents(page);
      if (apiEvents.length > 0) return apiEvents;
      return parseDaouInterviewCalendarText(await page.locator("body").innerText());
    } finally {
      await browser.close();
    }
  }

  private async assetPage(pages: Page[]): Promise<Page> {
    const existing = pages.find((page) => page.url().includes("/app/asset"));
    if (existing) return existing;
    const page = pages[0];
    if (!page) {
      throw new Error("DaouOffice dedicated browser has no open page.");
    }
    await page.goto(this.config.url, { waitUntil: "domcontentloaded", timeout: 10_000 });
    if (!page.url().includes("/app/asset")) {
      throw new Error("DaouOffice login is required before reading reservations.");
    }
    return page;
  }

  private async calendarPage(pages: Page[]): Promise<Page> {
    const calendarUrl = this.config.calendarUrl ?? "https://hug.hunet.co.kr/app/calendar";
    const existing = pages.find((page) => page.url().includes("/app/calendar"));
    if (existing) return existing;
    const page = pages[0];
    if (!page) {
      throw new Error("DaouOffice dedicated browser has no open page.");
    }
    await page.goto(calendarUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    if (!page.url().includes("/app/calendar")) {
      throw new Error("DaouOffice login is required before reading the calendar.");
    }
    return page;
  }

  private async ensureInterviewCalendars(page: Page): Promise<void> {
    await page.evaluate((calendarNames) => {
      const document = (globalThis as unknown as {
        document: {
          querySelectorAll(selector: string): ArrayLike<{
            textContent?: string | null;
            closest(selector: string): { querySelector(selector: string): { checked: boolean; click(): void } | null } | null;
            parentElement: { querySelector(selector: string): { checked: boolean; click(): void } | null } | null;
          }>;
        };
      }).document;
      for (const calendarName of calendarNames) {
        const nodes = Array.from(document.querySelectorAll("label,span,div"));
        const node = nodes.find((candidate) => candidate.textContent?.replace(/\s+/g, " ").trim() === calendarName);
        const root = node?.closest("label") ?? node?.parentElement;
        const checkbox = root?.querySelector('input[type="checkbox"]');
        if (checkbox && !checkbox.checked) checkbox.click();
      }
    }, ["내 일정(기본)", "내 일정(강해빈)", "내 일정(김성은)"]);
  }

  private async calendarInterviewEvents(
    page: Page,
  ): Promise<DaouInterviewCalendarEvent[]> {
    const paths = await page.evaluate(() =>
      [...new Set(
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((url) => url.includes("/api/calendar/event?"))
          .map((url) => {
            const parsed = new URL(url);
            return `${parsed.pathname}${parsed.search}`;
          }),
      )],
    );
    const entries: DaouInterviewCalendarEntry[] = [];
    for (const path of paths) {
      const response = asRecord(await this.fetchJson(page, path), "calendar event list");
      const data = asArray(response.data, "calendar event list");
      for (const value of data) {
        const event = asRecord(value, "calendar event");
        const title = stringValue(event.summary);
        const startDateTime = stringValue(event.startTime);
        const endDateTime = stringValue(event.endTime);
        if (!title || !startDateTime || !endDateTime) continue;
        entries.push({
          title,
          startDateTime,
          endDateTime,
          ...(stringValue(event.location) ? { location: stringValue(event.location) } : {}),
        });
      }
    }
    return parseDaouInterviewCalendarEntries(entries);
  }

  private async fetchJson(page: Page, path: string): Promise<unknown> {
    return page.evaluate(async (requestPath) => {
      const response = await fetch(requestPath, {
        credentials: "same-origin",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`DaouOffice request failed: ${response.status}`);
      }
      return response.json();
    }, path);
  }

  private async findInterviewRooms(page: Page): Promise<DaouRoomItem[]> {
    const assets = asArray(
      asRecord(await this.fetchJson(page, "/api/asset/reservation"), "asset list").data,
      "asset list",
    );
    const rooms: DaouRoomItem[] = [];
    for (const asset of assets) {
      const assetRecord = asRecord(asset, "asset");
      const assetId = numberValue(assetRecord.id);
      if (stringValue(assetRecord.name) !== DAOU_MEETING_ROOM_ASSET_NAME) {
        continue;
      }
      if (!assetId) continue;
      const response = asRecord(
        await this.fetchJson(page, `/api/asset/${assetId}/item?page=0&offset=100`),
        "asset item list",
      );
      const items = asArray(response.data, "asset item list");
      for (const item of items) {
        const room = extractRoomItem(item);
        if (room && isInterviewRoom(room.name)) rooms.push(room);
      }
    }
    if (rooms.length !== DAOU_INTERVIEW_ROOM_NAMES.length) {
      throw new Error(
        `Expected ${DAOU_INTERVIEW_ROOM_NAMES.length} configured interview rooms but found ${rooms.length}.`,
      );
    }
    return rooms;
  }

  private async findPurposeAttributeId(page: Page, assetId: number): Promise<number> {
    const response = asRecord(
      await this.fetchJson(page, `/api/asset/${assetId}/attribute/reservation`),
      "reservation attribute",
    );
    const attributes = asArray(response.data, "reservation attribute");
    const purpose = attributes.find((value) => {
      const attribute = asRecord(value, "reservation attribute");
      return stringValue(attribute.name) === "이용목적";
    });
    const purposeId = purpose
      ? numberValue(asRecord(purpose, "reservation attribute").id)
      : undefined;
    if (!purposeId) {
      throw new Error("DaouOffice reservation purpose attribute was not found.");
    }
    return purposeId;
  }

  private async weeklyReservations(
    page: Page,
    room: DaouRoomItem,
    date: string,
  ): Promise<DaouReservation[]> {
    const fromDate = encodeURIComponent(`${date}T00:00:00.000+09:00`);
    const response = asRecord(
      await this.fetchJson(
        page,
        `/api/asset/${room.assetId}/item/${room.id}/weekly?fromDate=${fromDate}`,
      ),
      "weekly reservation",
    );
    const data = asRecord(response.data, "weekly reservation");
    return asArray(data.daily, "weekly reservation").flatMap((day) => {
      const reservations = asRecord(day, "weekly reservation day").reservations;
      return Array.isArray(reservations)
        ? reservations.flatMap((value) => {
            const reservation = extractReservation(value);
            return reservation ? [reservation] : [];
          })
        : [];
    });
  }
}
