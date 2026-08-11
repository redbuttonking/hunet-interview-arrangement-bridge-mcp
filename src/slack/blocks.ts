import type { KnownBlock, ModalView } from "@slack/types";
import { defaultHourlySlots, normalizeSlots } from "../domain/calendar.js";
import type {
  CaseInterviewPlanRow,
  CaseBundle,
  ConfirmedInterviewScheduleRow,
  InterviewCaseRow,
  InterviewerRow,
} from "../db/database.js";
import type { TimeSlot } from "../domain/types.js";

export interface SequentialInterviewScheduleMessageSession {
  stepId: string;
  stepName: string;
  interviewerIds: string[];
  startTime: string;
  endTime: string;
  roomName: string;
}

export const OPEN_AVAILABILITY_ACTION = "open_interview_availability";
export const DECLINE_INTERVIEW_ACTION = "decline_interview_participation";
export const AVAILABILITY_VIEW_CALLBACK = "submit_interview_availability";

function dateLabel(date: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function candidateLabel(interviewCase: InterviewCaseRow): string {
  return interviewCase.candidateName ?? "이름 미확인 지원자";
}

function interviewerMentions(
  bundle: CaseBundle,
  interviewerIds: string[],
): string {
  const selected = new Set(interviewerIds);
  return bundle.interviewers
    .filter((interviewer) => interviewer.active && selected.has(interviewer.id))
    .map((interviewer) =>
      interviewer.slackUserId
        ? `<@${interviewer.slackUserId}>`
        : interviewer.displayName,
    )
    .join(", ");
}

export function buildRequestMessage(
  bundle: CaseBundle,
  options?: {
    title?: string;
    requestText?: string;
    targetInterviewerIds?: string[];
    plan?: CaseInterviewPlanRow;
  },
): {
  text: string;
  blocks: KnownBlock[];
} {
  const { interviewCase } = bundle;
  const isRescheduleRound = interviewCase.scheduleRound > 1;
  const defaultTitle = isRescheduleRound
    ? "인터뷰 가능 일정 재입력"
    : "인터뷰 가능 일정 입력";
  const defaultRequestText = isRescheduleRound
    ? "일정 변경 조율을 위해 가능한 시간을 다시 선택해 주세요. 이번 제출 내용만 새 일정 검토에 반영됩니다."
    : "가능한 시간을 선택해 주세요. 현재 참여가 어려운 경우 별도로 알려주시면 담당자가 면접관 구성을 검토합니다.";
  const requestTitle = options?.title ?? defaultTitle;
  const requestText = options?.requestText ?? defaultRequestText;
  const active = bundle.interviewers.filter(
    (item) =>
      item.active &&
      (!options?.targetInterviewerIds ||
        options.targetInterviewerIds.includes(item.id)),
  );
  const mentions = active
    .map((item) =>
      item.slackUserId ? `<@${item.slackUserId}>` : item.displayName,
    )
    .join(", ");
  const dates = interviewCase.proposalDates.map(dateLabel).join(", ");
  const sequentialStageLines =
    options?.plan?.mode === "SEQUENTIAL"
      ? options.plan.sessions.map((session) =>
          `• *${session.stepName}:* ${interviewerMentions(bundle, session.interviewerIds) || "면접관 매핑 필요"}`,
        )
      : [];
  const text = `${candidateLabel(interviewCase)} 지원자 ${requestTitle}`;
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: requestTitle },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*지원자:* ${candidateLabel(interviewCase)}`,
          `*채용:* ${interviewCase.recruitmentName ?? "채용 정보 미확인"}`,
          `*면접관:* ${mentions || "면접관 매핑 필요"}`,
          `*제안 날짜:* ${dates}`,
          ...(sequentialStageLines.length > 0
            ? ["*단계별 인터뷰 및 면접관:*", ...sequentialStageLines]
            : []),
        ].join("\n"),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: requestText,
      },
    },
    {
      type: "actions",
      block_id: `case_actions_${interviewCase.id}`,
      elements: [
        {
          type: "button",
          action_id: OPEN_AVAILABILITY_ACTION,
          text: { type: "plain_text", text: "가능 일정 입력" },
          style: "primary",
          value: JSON.stringify({
            caseId: interviewCase.id,
            scheduleRound: interviewCase.scheduleRound,
          }),
        },
        {
          type: "button",
          action_id: DECLINE_INTERVIEW_ACTION,
          text: { type: "plain_text", text: "상기 일정 불가" },
          style: "danger",
          value: JSON.stringify({
            caseId: interviewCase.id,
            scheduleRound: interviewCase.scheduleRound,
          }),
          confirm: {
            title: { type: "plain_text", text: "상기 일정 불가 확인" },
            text: {
              type: "mrkdwn",
              text: "상기 일정으로 인터뷰 참여가 어렵습니까?",
            },
            confirm: { type: "plain_text", text: "확인" },
            deny: { type: "plain_text", text: "취소" },
          },
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "기본 시간대 09:00–18:00 · 버튼 응답은 인터뷰 건별로 저장됩니다.",
        },
      ],
    },
  ];
  return { text, blocks };
}

export function buildAvailabilityRecoveryMessage(
  bundle: CaseBundle,
  _downtime: { startedAt: string; detectedAt: string },
  plan?: CaseInterviewPlanRow,
): { text: string; blocks: KnownBlock[] } {
  const pendingInterviewerIds = bundle.interviewers
    .filter(
      (interviewer) =>
        interviewer.active &&
        interviewer.required &&
        interviewer.status === "PENDING",
    )
    .map((interviewer) => interviewer.id);
  return buildRequestMessage(bundle, {
    title: "인터뷰 가능 일정 재입력",
    requestText:
      "내부 시스템 중단으로 일정을 다시 요청드립니다. 아래 버튼으로 가능한 시간을 입력해 주세요.",
    targetInterviewerIds: pendingInterviewerIds,
    plan,
  });
}

export function buildScheduleConfirmationMessage(
  bundle: CaseBundle,
  schedule: ConfirmedInterviewScheduleRow,
  options?: {
    sequentialSessions?: SequentialInterviewScheduleMessageSession[];
    isScheduleChange?: boolean;
  },
): { text: string; blocks: KnownBlock[] } {
  const { interviewCase } = bundle;
  const mentions = bundle.interviewers
    .filter((item) => item.active)
    .map((item) =>
      item.slackUserId ? `<@${item.slackUserId}>` : item.displayName,
    )
    .join(", ");
  const sequentialSessionLines = options?.sequentialSessions?.map((session) =>
    `• *${session.stepName}:* ${session.startTime}~${session.endTime} · ${session.roomName} · 면접관: ${interviewerMentions(bundle, session.interviewerIds) || "면접관 매핑 필요"}`,
  ) ?? [];
  const title = options?.isScheduleChange
    ? "인터뷰 일정 변경 안내"
    : "인터뷰 일정 확정 안내";
  const context = options?.isScheduleChange
    ? "인터뷰 일정이 변경되었습니다. 일정에 참고 바랍니다."
    : "인터뷰가 확정되었습니다. 일정에 참고 바랍니다.";
  const text = `${candidateLabel(interviewCase)} 지원자 ${title}`;
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: title,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*지원자:* ${candidateLabel(interviewCase)}`,
          `*채용:* ${interviewCase.recruitmentName ?? "채용 정보 미확인"}`,
          `*일시:* ${dateLabel(schedule.date)} ${schedule.startTime}~${schedule.endTime}`,
          ...(sequentialSessionLines.length > 0
            ? ["*단계별 인터뷰 일정:*", ...sequentialSessionLines]
            : [
                `*회의실:* ${schedule.roomName}`,
                `*면접관:* ${mentions || "면접관 매핑 필요"}`,
              ]),
        ].join("\n"),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: context,
        },
      ],
    },
  ];
  return { text, blocks };
}

export function buildScheduleUpdateMessage(
  bundle: CaseBundle,
  schedule: ConfirmedInterviewScheduleRow,
  updateType: "CHANGE" | "CANCELLATION",
): { text: string; blocks: KnownBlock[] } {
  const { interviewCase } = bundle;
  const mentions = bundle.interviewers
    .filter((item) => item.active)
    .map((item) =>
      item.slackUserId ? `<@${item.slackUserId}>` : item.displayName,
    )
    .join(", ");
  const isCancellation = updateType === "CANCELLATION";
  const title = isCancellation ? "인터뷰 일정 취소 안내" : "인터뷰 일정 변경 안내";
  const context = isCancellation
    ? "인터뷰가 취소되었습니다."
    : "인터뷰 일정이 변경되었습니다. 일정에 참고 바랍니다.";
  const text = `${candidateLabel(interviewCase)} 지원자 ${title}`;
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: title },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*지원자:* ${candidateLabel(interviewCase)}`,
          `*채용:* ${interviewCase.recruitmentName ?? "채용 정보 미확인"}`,
          `*일시:* ${dateLabel(schedule.date)} ${schedule.startTime}~${schedule.endTime}`,
          `*회의실:* ${schedule.roomName}`,
          `*면접관:* ${mentions || "면접관 매핑 필요"}`,
        ].join("\n"),
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: context }],
    },
  ];
  return { text, blocks };
}

export function buildAvailabilityModal(
  interviewCase: InterviewCaseRow,
  interviewer: InterviewerRow,
): ModalView {
  const slotOptions = defaultHourlySlots().map((slot) => ({
    text: {
      type: "plain_text" as const,
      text: `${slot.start}–${slot.end}`,
    },
    value: `${slot.start}-${slot.end}`,
  }));
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*지원자:* ${candidateLabel(interviewCase)}`,
          `*면접관:* ${interviewer.displayName}`,
        ].join("\n"),
      },
    },
    {
      type: "input",
      block_id: "global_all",
      optional: true,
      label: { type: "plain_text", text: "전체 선택" },
      element: {
        type: "checkboxes",
        action_id: "all_dates",
        options: [
          {
            text: {
              type: "plain_text",
              text: "모든 제안 날짜의 모든 시간 가능",
            },
            value: "ALL_DATES",
          },
        ],
      },
    },
  ];

  for (const date of interviewCase.proposalDates) {
    blocks.push({
      type: "input",
      block_id: `date_${date}`,
      optional: true,
      label: { type: "plain_text", text: dateLabel(date) },
      element: {
        type: "checkboxes",
        action_id: "time_slots",
        options: [
          {
            text: {
              type: "plain_text",
              text: "이 날짜 전체 시간 가능",
            },
            value: "ALL_DAY",
          },
          ...slotOptions,
        ],
      },
    });
  }

  return {
    type: "modal",
    callback_id: AVAILABILITY_VIEW_CALLBACK,
    private_metadata: JSON.stringify({
      caseId: interviewCase.id,
      slackUserId: interviewer.slackUserId,
      scheduleRound: interviewCase.scheduleRound,
    }),
    title: { type: "plain_text", text: "가능 일정 입력" },
    submit: { type: "plain_text", text: "제출" },
    close: { type: "plain_text", text: "취소" },
    blocks,
  };
}

interface SelectedOption {
  value?: string;
}

function selectedValues(action: unknown): string[] {
  if (!action || typeof action !== "object") return [];
  const options = (action as { selected_options?: SelectedOption[] })
    .selected_options;
  return Array.isArray(options)
    ? options
        .map((option) => option.value)
        .filter((value): value is string => Boolean(value))
    : [];
}

export function availabilityFromViewState(
  interviewCase: InterviewCaseRow,
  values: Record<string, Record<string, unknown>>,
): TimeSlot[] {
  const global = selectedValues(values.global_all?.all_dates);
  const hourly = defaultHourlySlots();
  const slots: TimeSlot[] = [];
  const allDates = global.includes("ALL_DATES");

  for (const date of interviewCase.proposalDates) {
    const selected = selectedValues(values[`date_${date}`]?.time_slots);
    const allDay = allDates || selected.includes("ALL_DAY");
    for (const slot of hourly) {
      if (allDay || selected.includes(`${slot.start}-${slot.end}`)) {
        slots.push({ date, start: slot.start, end: slot.end });
      }
    }
  }
  return normalizeSlots(slots);
}
