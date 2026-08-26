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

function parseDate(value: string): { year: number; month: number; day: number } {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`후보일 날짜 형식이 올바르지 않습니다: ${value}`);
  return { year, month, day };
}

function timePickerValue(value: string): { period: "AM" | "PM"; label: string } {
  const [hour, minute] = value.split(":").map(Number);
  if (hour === undefined || minute === undefined || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`후보일 시간 형식이 올바르지 않습니다: ${value}`);
  }
  return {
    period: hour < 12 ? "AM" : "PM",
    label: `${hour % 12 || 12}:${String(minute).padStart(2, "0")}`,
  };
}

async function clickFirst(locator: Locator, description: string): Promise<void> {
  const count = await locator.count();
  if (count === 0) throw new Error(`나인하이어 화면에서 ${description}을 찾지 못했습니다.`);
  await locator.first().click({ timeout: PAGE_TIMEOUT_MS });
}

async function clickFirstVisible(locator: Locator, description: string): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    await candidate.click({ timeout: PAGE_TIMEOUT_MS });
    return true;
  }
  return false;
}

async function firstVisibleEnabled(locator: Locator, description: string): Promise<Locator> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      if (await candidate.isEnabled().catch(() => false)) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`나인하이어 화면에서 ${description} 버튼이 활성화되지 않았습니다.`);
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

async function fillScheduleNotice(dialog: Locator, notice: string): Promise<void> {
  const field = dialog
    .getByText("일정 안내 사항", { exact: true })
    .first()
    .locator('xpath=ancestor::div[contains(@class, "SchedulingFormFieldLayout__Container")][1]');
  await fillValue(
    field.locator('textarea[placeholder="내용을 입력해 주세요."]'),
    notice,
    "일정 안내 사항",
  );
}

async function fillScheduleTitle(dialog: Locator, title: string): Promise<void> {
  await fillValue(
    dialog.locator('[contenteditable="true"][placeholder="일정의 제목을 입력해 주세요."]'),
    title,
    "일정 제목",
  );
}

async function verifySelectedInternalAttendees(dialog: Locator, attendeeNames: string[]): Promise<void> {
  for (const attendeeName of attendeeNames) {
    const attendee = dialog.getByText(attendeeName, { exact: true });
    if (await attendee.count() === 0) {
      throw new Error(`나인하이어 기본 일정 정보에서 내부 참석자 ${attendeeName}을 찾지 못했습니다.`);
    }
  }
}

function directLocationInputControls(page: Page, dialog: Locator): Locator[] {
  return [
    page.locator('[class*="SchedulingLocationSelector__List"]').filter({
      hasText: "직접 입력",
    }),
    dialog.getByRole("radio", { name: "직접 입력", exact: true }),
    dialog.getByRole("button", { name: "직접 입력", exact: true }),
    page.getByText("직접 입력", { exact: true }),
  ];
}

async function hasVisibleControl(controls: Locator[]): Promise<boolean> {
  for (const control of controls) {
    const count = await control.count();
    for (let index = 0; index < count; index += 1) {
      if (await control.nth(index).isVisible().catch(() => false)) return true;
    }
  }
  return false;
}

async function openLocationDropdown(page: Page, dialog: Locator): Promise<void> {
  const trigger = page
    .locator('[class*="SchedulingLocationSelector__LocationDropdownButtonLayout"]')
    .filter({ hasText: "선택 안함" });
  if (await clickFirstVisible(trigger, "장소 선택 드롭다운")) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await hasVisibleControl(directLocationInputControls(page, dialog))) return;
      await page.waitForTimeout(100);
    }
  }
  throw new Error("나인하이어 화면에서 장소 선택 드롭다운을 열지 못했습니다.");
}

async function fillDirectLocation(page: Page, dialog: Locator, location: string): Promise<void> {
  await openLocationDropdown(page, dialog);
  const directInputControls = directLocationInputControls(page, dialog);
  for (const control of directInputControls) {
    if (await clickFirstVisible(control, "장소 직접 입력 방식")) {
      const directLocationInput = dialog
        .locator('input[placeholder="주소를 입력해 주세요."]:not([disabled])');
      await fillValue(directLocationInput, location, "장소 직접 입력");
      return;
    }
  }
  throw new Error("나인하이어 화면에서 장소 직접 입력 방식을 찾지 못했습니다.");
}

async function selectProposalDate(page: Page, input: Locator, value: string): Promise<void> {
  const target = parseDate(value);
  await clickFirst(input, "후보일 날짜 선택기");
  const picker = page.locator(".ant-picker-dropdown:visible").last();
  await picker.waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const header = (await picker.locator(".ant-picker-header-view").innerText()).match(/(\d{4})년\s*(\d{1,2})월/);
    if (!header) throw new Error("나인하이어 화면에서 후보일 달력의 현재 월을 읽지 못했습니다.");
    const currentYear = Number(header[1]);
    const currentMonth = Number(header[2]);
    if (currentYear === target.year && currentMonth === target.month) break;
    const next = currentYear < target.year || (currentYear === target.year && currentMonth < target.month);
    await clickFirst(
      picker.locator(next ? "button.ant-picker-header-next-btn" : "button.ant-picker-header-prev-btn"),
      next ? "후보일 달력 다음 달 버튼" : "후보일 달력 이전 달 버튼",
    );
    await page.waitForTimeout(100);
  }

  const finalHeader = await picker.locator(".ant-picker-header-view").innerText();
  if (!finalHeader.includes(`${target.year}년`) || !finalHeader.includes(`${target.month}월`)) {
    throw new Error(`나인하이어 화면에서 후보일 ${value}의 달력으로 이동하지 못했습니다.`);
  }
  const day = picker
    .locator("td.ant-picker-cell.ant-picker-cell-in-view:not(.ant-picker-cell-disabled)")
    .filter({ hasText: new RegExp(`^${target.day}$`) });
  await clickFirst(day, `후보일 ${value}`);
  const selectedValue = await input.inputValue();
  if (!selectedValue.includes(`${String(target.month).padStart(2, "0")}. ${String(target.day).padStart(2, "0")}.`)) {
    throw new Error(`나인하이어 화면에 후보일 ${value}이 반영되지 않았습니다.`);
  }
}

async function selectProposalTime(page: Page, input: Locator, value: string, description: string): Promise<void> {
  const target = timePickerValue(value);
  await clickFirst(input, description);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const options = page.locator(
      `[class*="DateOptionTimePicker__List"][class*="timePicker_${target.period}"]`,
    );
    for (let index = 0; index < await options.count(); index += 1) {
      const option = options.nth(index);
      if (!await option.isVisible().catch(() => false)) continue;
      const optionText = (await option.innerText()).replace(/\s+/g, " ").trim();
      if (optionText !== `${target.period} ${target.label}`) continue;
      await option.click({ timeout: PAGE_TIMEOUT_MS });
      const selectedValue = await input.inputValue();
      if (selectedValue.includes(target.label)) return;
      throw new Error(`나인하이어 화면에 ${description} ${value}이 반영되지 않았습니다.`);
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`나인하이어 화면에서 ${description} ${value} 선택 항목을 찾지 못했습니다.`);
}

async function selectMenuItem(page: Page, label: RegExp, description: string): Promise<void> {
  const menuItem = page.getByRole("menuitem", { name: label });
  if (await clickFirstVisible(menuItem, description)) return;
  const textItem = page.getByText(label, { exact: false });
  if (await clickFirstVisible(textItem, description)) return;
  throw new Error(`나인하이어 화면에서 ${description}을 찾지 못했습니다.`);
}

async function findScheduleDialog(page: Page): Promise<Locator | undefined> {
  const dialog = page
    .getByRole("dialog")
    .filter({ hasText: "일정 조율 케이스 보기" })
    .last();
  try {
    await dialog.waitFor({ state: "visible", timeout: 1_500 });
    return dialog;
  } catch {
    // 단일 일정 유형 선택 화면이 따로 있는 경우 아래 선택기로 이어간다.
  }
  return undefined;
}

async function openSingleScheduleDialog(page: Page): Promise<Locator> {
  await selectMenuItem(page, /^일정 조율/, "일정 조율 메뉴");

  // 나인하이어 화면 버전에 따라 일정 조율 메뉴가 바로 입력 창을 열거나,
  // 단일 일정 유형을 한 번 더 선택하도록 표시된다.
  const directlyOpened = await findScheduleDialog(page);
  if (directlyOpened) return directlyOpened;

  await selectMenuItem(
    page,
    /^(단일 일정 조율|단일 일정|개별 일정 조율)/,
    "단일 일정 조율 메뉴",
  );
  const scheduleDialog = page
    .getByRole("dialog")
    .filter({ hasText: "일정 조율 케이스 보기" })
    .last();
  await scheduleDialog.waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });
  return scheduleDialog;
}

async function openEmailDeliveryDialog(page: Page): Promise<void> {
  const emailMethod = page.getByText("메일로 보내기", { exact: true });
  await emailMethod.first().waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS }).catch(() => {
    throw new Error("나인하이어 일정 저장 뒤 전송 방식 선택 화면을 열지 못했습니다.");
  });
  await clickFirstVisible(emailMethod, "메일로 보내기 전송 방식");

  const confirmButton = page.getByText("확인", { exact: true });
  await confirmButton.last().waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS }).catch(() => {
    throw new Error("나인하이어 전송 방식 선택 화면에서 확인 버튼을 찾지 못했습니다.");
  });
  await clickFirstVisible(confirmButton, "전송 방식 확인 버튼");
  await page.getByText("저장된 템플릿 불러오기", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS })
    .catch(() => {
      throw new Error("나인하이어 이메일 작성 화면을 열지 못했습니다.");
    });
}

async function selectEmailTemplate(page: Page, templateName: string): Promise<void> {
  const templateTrigger = page.locator('[class*="MessageTemplateDropdownItem__TemplateContainer"]');
  await clickFirstVisible(templateTrigger, "저장된 이메일 템플릿 불러오기 버튼");

  const template = page.getByText(templateName, { exact: true });
  await template.first().waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS }).catch(() => {
    throw new Error(`나인하이어 저장 템플릿 목록에서 ${templateName}을 찾지 못했습니다.`);
  });
  const templateMenu = page.locator(".ant-dropdown").filter({ hasText: templateName }).last();
  await clickFirstVisible(template, "이메일 템플릿");
  await templateMenu.waitFor({ state: "hidden", timeout: PAGE_TIMEOUT_MS }).catch(() => {
    throw new Error(`나인하이어 이메일 템플릿 ${templateName} 선택을 완료하지 못했습니다.`);
  });

  const messageOnly = page.getByText("메시지만 불러오기", { exact: true });
  await messageOnly.first().waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS }).catch(() => {
    throw new Error("나인하이어 이메일 템플릿 적용 방식을 선택하지 못했습니다.");
  });
  await clickFirstVisible(messageOnly, "메시지만 불러오기");
  const saving = page.getByText("저장 중 ...", { exact: true });
  if (await saving.count() > 0) {
    await saving.first().waitFor({ state: "hidden", timeout: PAGE_TIMEOUT_MS }).catch(() => {
      throw new Error("나인하이어 이메일 템플릿 내용을 저장하지 못했습니다.");
    });
  }
}

async function getContactHistoryEmailCount(candidateDialog: Locator): Promise<number | undefined> {
  try {
    const contactHistory = candidateDialog.getByRole("button", { name: /연락 내역/ });
    if (!await clickFirstVisible(contactHistory, "연락 내역 탭")) return undefined;

    const messages = candidateDialog.locator('[class*="MessageConditioner__Container"]');
    await messages.first().waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS }).catch(() => undefined);

    return await messages.evaluateAll((elements) => elements.filter((element) => {
      const tags = Array.from(element.querySelectorAll('[class*="MessageSender__SendTypeTag"]')) as Array<{
        textContent?: string | null;
      }>;
      return tags.some((tag) => tag.textContent?.trim() === "메일");
    }).length);
  } catch {
    return undefined;
  }
}

async function restoreCandidateBasicInfo(candidateDialog: Locator): Promise<void> {
  const basicInfo = candidateDialog.getByRole("button", { name: /접수 정보/ });
  await clickFirstVisible(basicInfo, "접수 정보 탭").catch(() => undefined);
}

async function waitForContactHistoryEmail(
  candidateDialog: Locator,
  previousCount: number | undefined,
): Promise<boolean> {
  if (previousCount === undefined) return false;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const currentCount = await getContactHistoryEmailCount(candidateDialog);
    if (currentCount !== undefined && currentCount > previousCount) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
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

        // 완료 안내 문구가 누락돼도 연락 내역의 새 메일 기록으로 발송 성공을 확인한다.
        const previousContactEmailCount = await getContactHistoryEmailCount(candidateDialog);
        await restoreCandidateBasicInfo(candidateDialog);

        await clickFirst(candidateDialog.getByRole("button", { name: "일정 만들기", exact: true }), "일정 만들기 버튼");
        const scheduleDialog = await openSingleScheduleDialog(page);
        await fillScheduleTitle(scheduleDialog, input.title);
        await fillScheduleNotice(scheduleDialog, input.notice);
        await fillDirectLocation(page, scheduleDialog, input.location);
        await verifySelectedInternalAttendees(scheduleDialog, input.internalAttendeeNames);
        await clickFirst(scheduleDialog.getByRole("button", { name: "다음", exact: true }), "후보일 설정으로 이동하는 다음 버튼");

        for (const option of input.proposalOptions) {
          await clickFirst(scheduleDialog.getByRole("button", { name: "후보일 추가", exact: true }), "후보일 추가 버튼");
          await selectProposalDate(page, scheduleDialog.locator('input[placeholder="날짜 선택"]').last(), option.date);
          await selectProposalTime(page, scheduleDialog.locator('input[placeholder="시작 시간"]').last(), option.startTime, "후보일 시작 시간");
          await selectProposalTime(page, scheduleDialog.locator('input[placeholder="종료 시간"]').last(), option.endTime, "후보일 종료 시간");
        }
        await clickFirst(scheduleDialog.getByRole("button", { name: "다음", exact: true }), "추가 설정으로 이동하는 다음 버튼");

        await this.configureFinalStep(page, scheduleDialog, input);
        await clickFirst(scheduleDialog.getByRole("button", { name: /완료|저장/ }), "일정 조율 완료 버튼");
        await openEmailDeliveryDialog(page);
        await selectEmailTemplate(page, input.emailTemplateName);
        await page.getByText(`${input.candidateName}님에게 메일 보내기`, { exact: true })
          .first()
          .waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS })
          .catch(() => {
            throw new Error("메일 발송 전 확인 화면에서 후보자 정보를 확인하지 못했습니다.");
          });
        const sendButton = await firstVisibleEnabled(
          page.getByRole("button", { name: "바로 전송", exact: true }),
          "메일 발송",
        );
        // 나인하이어 후보자 상세 모달의 배경 오버레이가 이메일 작성 화면보다 위에 남는 경우를 처리한다.
        await sendButton.click({ force: true, timeout: PAGE_TIMEOUT_MS });
        try {
          await page.getByText(/메일.*발송.*완료|성공적으로.*발송|발송되었습니다/, { exact: false })
            .first()
            .waitFor({ state: "visible", timeout: 5_000 });
        } catch {
          if (!await waitForContactHistoryEmail(candidateDialog, previousContactEmailCount)) {
            throw new NinehireScheduleProposalDispatchUncertainError();
          }
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

    const deadlineSelector = dialog.locator(".selector_wrapper").first();
    await clickFirst(deadlineSelector, "회신 기한 선택기");
    if (!await clickFirstVisible(page.getByText(`${input.replyDeadlineDays}일`, { exact: true }), "회신 기한")) {
      throw new Error(`나인하이어 화면에서 회신 기한 ${input.replyDeadlineDays}일을 찾지 못했습니다.`);
    }

  }
}
