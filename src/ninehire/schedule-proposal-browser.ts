// 전용 Chrome 프로필에서 나인하이어 후보자 일정 제안 화면을 안전하게 조작한다.
import { chromium, type Locator, type Page } from "playwright-core";
import type { AppConfig } from "../config.js";
import type { CandidateScheduleProposalDraft } from "./schedule-proposal.js";
import { ninehireDebugUrl } from "./browser.js";

const PAGE_TIMEOUT_MS = 15_000;

export class NinehireScheduleProposalDispatchUncertainError extends Error {
  constructor() {
    super(
      "나인하이어 메일 발송 버튼을 눌렀지만 완료 화면을 확인하지 못했습니다. 같은 발송 버튼을 다시 누르지 말고 나인하이어 발송 이력을 먼저 확인해 주세요.",
    );
    this.name = "NinehireScheduleProposalDispatchUncertainError";
  }
}

function displayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}. ${month}. ${day}.`;
}

function displayTime(value: string): string {
  const [hour, minute] = value.split(":").map(Number);
  if (hour === undefined || minute === undefined) return value;
  const period = hour < 12 ? "오전" : "오후";
  const twelveHour = hour % 12 || 12;
  return `${period} ${String(twelveHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

async function clickFirst(locator: Locator, description: string): Promise<void> {
  const count = await locator.count();
  if (count === 0) throw new Error(`나인하이어 화면에서 ${description}을 찾지 못했습니다.`);
  await locator.first().click({ timeout: PAGE_TIMEOUT_MS });
}

async function clickOnly(locator: Locator, description: string): Promise<void> {
  const count = await locator.count();
  if (count !== 1) {
    throw new Error(
      `나인하이어 화면에서 ${description}을 하나로 식별하지 못했습니다. 실제 발송을 중단했습니다.`,
    );
  }
  await locator.click({ timeout: PAGE_TIMEOUT_MS });
}

async function fillValue(locator: Locator, value: string, description: string): Promise<void> {
  const count = await locator.count();
  if (count === 0) throw new Error(`나인하이어 화면에서 ${description} 입력란을 찾지 못했습니다.`);
  const target = locator.first();
  await target.click({ timeout: PAGE_TIMEOUT_MS });
  await target.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await target.pressSequentially(value, { delay: 15 });
  await target.blur();
}

async function fillAfterLabel(
  dialog: Locator,
  label: string,
  selector: "input" | "textarea",
  value: string,
): Promise<void> {
  const input = dialog.getByText(label, { exact: true })
    .locator(`xpath=following::${selector}[1]`);
  await fillValue(input, value, label);
}

async function selectMenuItem(page: Page, label: RegExp, description: string): Promise<void> {
  const menuItem = page.getByRole("menuitem", { name: label });
  if (await menuItem.count() > 0) {
    await clickFirst(menuItem, description);
    return;
  }
  const textItem = page.getByText(label, { exact: false });
  await clickFirst(textItem, description);
}

export interface SentNinehireScheduleProposal {
  title: string;
  emailTemplateName: string;
  proposalOptionCount: number;
}

export class NinehireScheduleProposalBrowser {
  constructor(private readonly config: AppConfig["ninehire"]) {}

  async send(input: CandidateScheduleProposalDraft): Promise<SentNinehireScheduleProposal> {
    if (!input.candidateUrl) {
      throw new Error("나인하이어 후보자 화면 주소를 만들 수 없습니다. 후보자와 채용 식별 정보를 확인해 주세요.");
    }
    if (input.requiresEmailTemplateSelection || !input.emailTemplateName) {
      throw new Error("이 인터뷰 차수의 나인하이어 이메일 템플릿을 먼저 지정해 주세요.");
    }
    if (input.internalAttendeeNames.length === 0) {
      throw new Error("현재 인터뷰 평가표에 등록된 내부 참석자가 없습니다.");
    }
    if (input.proposalOptions.length === 0) {
      throw new Error("후보자에게 제안할 일정이 없습니다.");
    }

    const debugUrl = ninehireDebugUrl(this.config.remoteDebugPort ?? 9223);
    const browser = await chromium.connectOverCDP(debugUrl, { timeout: PAGE_TIMEOUT_MS })
      .catch(() => {
        throw new Error("나인하이어 전용 Chrome이 연결되지 않았습니다. 대시보드에서 나인하이어 자동화 로그인을 먼저 완료해 주세요.");
      });
    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error("나인하이어 전용 Chrome 컨텍스트를 찾지 못했습니다.");
      const page = await context.newPage();
      try {
        await page.goto(input.candidateUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
        const candidateDialog = page.getByRole("dialog").filter({ hasText: input.candidateName }).last();
        await candidateDialog.waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });
        const candidateDialogText = await candidateDialog.innerText();
        if (!candidateDialogText.includes(input.candidateName) || !candidateDialogText.includes(input.recruitmentName)) {
          throw new Error("나인하이어 화면의 후보자 또는 채용 정보가 선택한 조율 건과 일치하지 않습니다.");
        }

        await clickFirst(candidateDialog.getByRole("button", { name: "일정 만들기", exact: true }), "일정 만들기 버튼");
        await selectMenuItem(page, /^일정 조율/, "일정 조율 메뉴");
        await selectMenuItem(page, /^단일 일정 조율/, "단일 일정 조율 메뉴");

        const scheduleDialog = page.getByRole("dialog").last();
        await scheduleDialog.waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });
        await fillAfterLabel(scheduleDialog, "일정 제목", "input", input.title);
        await fillAfterLabel(scheduleDialog, "일정 안내 사항", "textarea", input.notice);
        await fillAfterLabel(scheduleDialog, "장소", "input", input.location);
        await clickFirst(scheduleDialog.getByRole("button", { name: "다음", exact: true }), "후보일 설정으로 이동하는 다음 버튼");

        for (const option of input.proposalOptions) {
          await clickFirst(scheduleDialog.getByRole("button", { name: "후보일 추가", exact: true }), "후보일 추가 버튼");
          await fillValue(scheduleDialog.locator('input[placeholder="날짜 선택"]').last(), displayDate(option.date), "후보일 날짜");
          await fillValue(scheduleDialog.locator('input[placeholder="시작 시간"]').last(), displayTime(option.startTime), "후보일 시작 시간");
          await fillValue(scheduleDialog.locator('input[placeholder="종료 시간"]').last(), displayTime(option.endTime), "후보일 종료 시간");
        }
        await clickFirst(scheduleDialog.getByRole("button", { name: "다음", exact: true }), "추가 설정으로 이동하는 다음 버튼");

        await this.configureFinalStep(page, scheduleDialog, input);
        await clickFirst(scheduleDialog.getByRole("button", { name: /완료|저장/ }), "일정 조율 완료 버튼");
        await selectMenuItem(page, /^메일로 보내기$/, "메일로 보내기 방식");
        await clickOnly(page.getByText(input.emailTemplateName, { exact: true }), "이메일 템플릿");

        const sendDialog = page.getByRole("dialog").last();
        const summary = await sendDialog.innerText();
        if (!summary.includes(input.candidateName) || !summary.includes(input.emailTemplateName)) {
          throw new Error("메일 발송 전 확인 화면에서 후보자 또는 이메일 템플릿을 확인하지 못했습니다.");
        }
        await clickFirst(sendDialog.getByRole("button", { name: /메일 보내기|발송/ }), "메일 발송 버튼");
        try {
          await page.getByText(/메일.*발송.*완료|성공적으로.*발송|발송되었습니다/, { exact: false })
            .first()
            .waitFor({ state: "visible", timeout: 5_000 });
        } catch {
          throw new NinehireScheduleProposalDispatchUncertainError();
        }
        return {
          title: input.title,
          emailTemplateName: input.emailTemplateName,
          proposalOptionCount: input.proposalOptions.length,
        };
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await browser.close();
    }
  }

  private async configureFinalStep(
    page: Page,
    dialog: Locator,
    input: CandidateScheduleProposalDraft,
  ): Promise<void> {
    const directConfirmation = page.getByText(/지원자가 직접.*확정/, { exact: false });
    await clickFirst(directConfirmation, "지원자 직접 일정 확정 방식");

    const deadlineInput = dialog.locator('input[placeholder*="회신"], input[placeholder*="기한"]');
    await fillValue(deadlineInput, `${input.replyDeadlineDays}일`, "회신 기한");

    const attendeeButton = page.getByText(/내부 참석자/, { exact: false });
    await clickFirst(attendeeButton, "내부 참석자 설정");
    for (const attendeeName of input.internalAttendeeNames) {
      const attendee = page.getByText(attendeeName, { exact: true });
      if (await attendee.count() === 0) {
        throw new Error(`나인하이어에서 내부 참석자 ${attendeeName}을 찾지 못했습니다.`);
      }
      await clickOnly(attendee, `내부 참석자 ${attendeeName}`);
    }
  }
}
