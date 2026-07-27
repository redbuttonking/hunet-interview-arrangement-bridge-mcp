import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { BrowserDaouOfficeReservationAdapter } from "../daou-office/adapter.js";
import { DaouOfficeBrowserController } from "../daou-office/browser.js";
import {
  BridgeDatabase,
  type InterviewCaseRow,
} from "../db/database.js";
import type { DaouOfficeReservationAdapter } from "../domain/daou-office.js";
import { suggestCommonSlots } from "../domain/availability.js";
import {
  NinehireRecruitmentWorkflowAdapter,
  type NinehireWorkflowAdapter,
} from "../ninehire/adapter.js";
import { NinehireMcpGateway } from "../ninehire/gateway.js";
import {
  WorkflowService,
  type SlackIdentityResolver,
} from "../services/workflow.js";
import { suggestInterviewSlotsWithRooms } from "../services/room-scheduling.js";
import { SlackReconciler } from "../slack/reconciler.js";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent:
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : { value },
  };
}

class WebClientIdentityResolver implements SlackIdentityResolver {
  constructor(private readonly client: WebClient) {}

  async lookupUserIdByEmail(email: string): Promise<string | undefined> {
    try {
      const response = await this.client.users.lookupByEmail({ email });
      return response.user?.id;
    } catch (error) {
      const slackError =
        typeof error === "object" && error !== null && "data" in error
          ? (error as { data?: { error?: string } }).data?.error
          : undefined;
      if (slackError === "users_not_found") return undefined;
      throw error;
    }
  }
}

function caseSummary(interviewCase: InterviewCaseRow) {
  return {
    id: interviewCase.id,
    candidateName: interviewCase.candidateName,
    recruitmentName: interviewCase.recruitmentName,
    status: interviewCase.status,
    durationMinutes: interviewCase.durationMinutes,
    proposalDates: interviewCase.proposalDates,
    scheduleRound: interviewCase.scheduleRound,
    scheduledDate: interviewCase.scheduledDate,
    scheduledStartTime: interviewCase.scheduledStartTime,
    scheduledEndTime: interviewCase.scheduledEndTime,
    createdAt: interviewCase.createdAt,
  };
}

export function createBridgeMcpServer(
  config: AppConfig,
  db: BridgeDatabase,
  dependencies?: {
    gateway?: NinehireMcpGateway;
    ninehire?: NinehireWorkflowAdapter;
    slackClient?: WebClient;
    daouOffice?: DaouOfficeReservationAdapter;
  },
): McpServer {
  const gateway =
    dependencies?.gateway ?? new NinehireMcpGateway(config.ninehire);
  const ninehire =
    dependencies?.ninehire ??
    new NinehireRecruitmentWorkflowAdapter(gateway);
  const slackClient =
    dependencies?.slackClient ??
    (config.slack.botToken
      ? new WebClient(config.slack.botToken)
      : undefined);
  const identityResolver = slackClient
    ? new WebClientIdentityResolver(slackClient)
    : undefined;
  const workflow = new WorkflowService(
    db,
    config,
    ninehire,
    identityResolver,
  );
  const daouOfficeBrowser = new DaouOfficeBrowserController(config.daouOffice);
  const daouOffice =
    dependencies?.daouOffice ??
    new BrowserDaouOfficeReservationAdapter(config.daouOffice);

  const server = new McpServer({
    name: "interview-arrangement-bridge",
    version: "0.1.0",
  });

  server.registerTool(
    "bridge_status",
    {
      title: "인터뷰 브릿지 상태",
      description:
        "로컬 DB의 인터뷰 건, 검토 대기, 메시지 초안 및 면접관 응답 현황을 조회합니다.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      result({
        database: db.getStatus(),
        integrations: {
          slackBotToken: Boolean(config.slack.botToken),
          slackAppToken: Boolean(config.slack.appToken),
          sourceChannel: Boolean(config.slack.sourceChannelId),
          requestChannel: Boolean(config.slack.requestChannelId),
          ninehireKey: gateway.isConfigured(),
          ninehireEvaluationSummary: gateway.isConfigured(),
          ninehireRecruitmentParticipants: gateway.isConfigured(),
          daouOffice: {
            mode: "DEDICATED_EDGE_PROFILE",
            url: config.daouOffice.url,
          },
        },
      }),
  );

  server.registerTool(
    "daou_office_browser_status",
    {
      title: "다우오피스 브라우저 상태",
      description:
        "전용 Edge 프로필과 로컬 전용 디버그 연결의 준비 상태를 확인합니다. 다우오피스 예약을 읽거나 변경하지 않습니다.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => result(await daouOfficeBrowser.status()),
  );

  server.registerTool(
    "open_daou_office_login",
    {
      title: "다우오피스 전용 로그인 브라우저 열기",
      description:
        "개인 브라우저와 분리된 로컬 Edge 프로필로 다우오피스를 엽니다. 최초 로그인은 사용자가 직접 수행하며, 예약을 읽거나 변경하지 않습니다.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => result(await daouOfficeBrowser.openLoginWindow()),
  );

  server.registerTool(
    "sync_daou_meeting_room_blocks",
    {
      title: "다우오피스 면접실 예약 동기화",
      description:
        "해당 면접 건의 제안 날짜에 대해 전용 브라우저로 다우오피스 예약을 읽고, 지정 면접실·예약자·이용 목적이 모두 일치하는 예약 블록만 로컬 DB에 반영합니다. 다우오피스 예약을 변경하지 않습니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ caseId }) => {
      const interviewCase = db.getCase(caseId);
      if (!interviewCase) throw new Error(`Case not found: ${caseId}`);
      const blocks = await daouOffice.listMeetingRoomBlocks(
        interviewCase.proposalDates,
      );
      const synced = db.syncMeetingRoomBlocks(interviewCase.proposalDates, blocks);
      return result({
        caseId,
        dates: interviewCase.proposalDates,
        blockCount: synced.filter((block) => block.active).length,
        blocks: synced
          .filter((block) => block.active)
          .map((block) => ({
            id: block.id,
            roomName: block.roomName,
            date: block.date,
            startTime: block.startTime,
            endTime: block.endTime,
          })),
      });
    },
  );

  server.registerTool(
    "list_daou_meeting_room_blocks",
    {
      title: "동기화된 면접실 예약 블록 조회",
      description:
        "로컬 DB에 동기화된 면접실 예약 블록을 조회합니다. 예약자 이름은 출력하지 않습니다.",
      inputSchema: {
        dates: z
          .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
          .min(1)
          .max(20)
          .optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ dates }) =>
      result({
        blocks: db.listMeetingRoomBlocks(dates).map((block) => ({
          id: block.id,
          roomName: block.roomName,
          date: block.date,
          startTime: block.startTime,
          endTime: block.endTime,
        })),
      }),
  );

  server.registerTool(
    "suggest_interview_slots_with_rooms",
    {
      title: "면접관과 면접실을 함께 반영한 일정 추천",
      description:
        "면접관 공통 가능 시간과 동기화된 면접실 예약 블록, 이미 로컬에 배정한 면접 시간을 함께 반영해 추천합니다. 일정이나 예약을 변경하지 않습니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId }) => result(suggestInterviewSlotsWithRooms(db, caseId)),
  );

  server.registerTool(
    "allocate_interview_room_slot",
    {
      title: "면접실 내부 시간대 배정",
      description:
        "사용자가 선택한 면접 시간과 회의실 블록을 로컬 DB에 배정해 다른 후보자와 겹치지 않도록 합니다. 다우오피스 예약은 변경하지 않습니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        roomBlockId: z.string().uuid(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => result(db.allocateRoomBlock(input)),
  );

  server.registerTool(
    "confirm_internal_interview_schedule",
    {
      title: "인터뷰 내부 일정 확정",
      description:
        "활성 면접실 배정을 내부 확정 일정으로 기록하고 후보자 확인 대기 상태로 변경합니다. Slack이나 나인하이어에는 전송하지 않습니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId }) => result(workflow.confirmInternalSchedule(caseId)),
  );

  server.registerTool(
    "cancel_interview_room_allocation",
    {
      title: "면접실 내부 배정 취소",
      description:
        "로컬 DB의 면접실 내부 배정만 취소합니다. 다우오피스 예약은 변경하지 않습니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        allocationId: z.string().uuid(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId, allocationId }) =>
      result(db.cancelRoomAllocation(caseId, allocationId)),
  );

  server.registerTool(
    "reopen_interview_schedule_for_reschedule",
    {
      title: "인터뷰 일정 재조율 시작",
      description:
        "확정 또는 후보자 확인 대기 중인 기존 일정을 로컬에서 해제하고 재조율 상태로 전환합니다. 기존 안내가 발송된 경우 Slack 변경 안내 초안도 생성하지만 자동 발송하지 않습니다. 다우오피스 예약은 변경하지 않습니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        availabilityPolicy: z.enum(["REUSE", "RECOLLECT"]),
        reason: z.string().min(1).max(500),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => result(workflow.reopenInterviewSchedule(input)),
  );

  server.registerTool(
    "cancel_interview_arrangement",
    {
      title: "인터뷰 조율 취소",
      description:
        "면접 건을 취소하고 로컬 면접실 배정, 미발송 초안, 미발송 리마인더를 정리합니다. 기존 일정 안내가 발송된 경우 Slack 취소 안내 초안도 생성하지만 자동 발송하지 않습니다. 다우오피스 예약은 변경하지 않습니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        reason: z.string().min(1).max(500),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => result(workflow.cancelInterviewArrangement(input)),
  );

  server.registerTool(
    "list_interview_cases",
    {
      title: "인터뷰 건 목록",
      description: "로컬에 생성된 인터뷰 조율 건을 조회합니다.",
      inputSchema: {
        status: z
          .enum([
            "READY_FOR_DRAFT",
            "DRAFT_CREATED",
            "REQUEST_SENT",
            "COLLECTING_AVAILABILITY",
            "READY_TO_SCHEDULE",
            "AWAITING_CANDIDATE_CONFIRMATION",
            "CONFIRMED",
            "CANCELLED",
            "REVIEW_REQUIRED",
            "CLOSED",
          ])
          .optional(),
        limit: z.number().int().min(1).max(200).default(100),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ status, limit }) =>
      result({
        cases: db.listCases(status, limit).map(caseSummary),
      }),
  );

  server.registerTool(
    "get_interview_case",
    {
      title: "인터뷰 건 상세",
      description:
        "면접관, 가용시간, 메시지 초안을 포함한 인터뷰 건 상세를 조회합니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId }) => {
      const bundle = db.getCaseBundle(caseId);
      if (!bundle) throw new Error(`Case not found: ${caseId}`);
      return result(bundle);
    },
  );

  server.registerTool(
    "suggest_common_interview_slots",
    {
      title: "공통 인터뷰 가능시간 계산",
      description:
        "필수 면접관이 제출한 가용시간의 교집합에서 건별 소요시간을 만족하는 후보를 계산합니다. 다우오피스 회의실은 아직 확인하지 않습니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId }) => {
      const bundle = db.getCaseBundle(caseId);
      if (!bundle) throw new Error(`Case not found: ${caseId}`);
      return result(suggestCommonSlots(bundle));
    },
  );

  server.registerTool(
    "list_workflow_reviews",
    {
      title: "검토 대기 목록",
      description:
        "평가 결과 미매핑, 면접관 미응답/불참, 후보자 인터뷰 불참 메시지 등 사람의 판단이 필요한 항목을 조회합니다.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(100),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit }) => result({ reviews: db.listOpenReviews(limit) }),
  );

  server.registerTool(
    "list_in_progress_recruitments",
    {
      title: "진행 중 나인하이어 채용 목록",
      description:
        "나인하이어에서 상태가 진행 중인 채용만 읽기 전용으로 조회합니다. 지원자와 참여자 정보는 반환하지 않습니다.",
      inputSchema: {
        keyword: z.string().trim().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(100).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => result(await ninehire.listInProgressRecruitments(input)),
  );

  server.registerTool(
    "inspect_ninehire_tools",
    {
      title: "나인하이어 도구 검사",
      description:
        "나인하이어 MCP가 제공하는 실제 도구명과 입력/출력 스키마를 읽기 전용으로 조회합니다.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => result({ tools: await gateway.listTools() }),
  );

  server.registerTool(
    "sync_slack_notifications",
    {
      title: "Slack 알림 즉시 동기화",
      description:
        "5분 주기를 기다리지 않고 나인하이어 알림 채널을 지금 읽어 로컬 상태를 갱신합니다.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      if (!slackClient) throw new Error("SLACK_BOT_TOKEN is not configured.");
      const reconciler = new SlackReconciler(
        db,
        config,
        slackClient,
        workflow,
      );
      return result(await reconciler.reconcile());
    },
  );

  server.registerTool(
    "reprocess_schedule_confirmation_notifications",
    {
      title: "기존 일정 확정 알림 재처리",
      description:
        "새 감지 규칙이 적용되기 전에 저장된 나인하이어 일정 확정 Slack 알림을 다시 처리합니다. 외부 메시지나 나인하이어 일정은 변경하지 않습니다.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => result(workflow.reprocessScheduleConfirmationNotifications()),
  );

  server.registerTool(
    "reprocess_candidate_interview_absence_notifications",
    {
      title: "기존 후보자 불참 알림 재처리",
      description:
        "새 감지 규칙이 적용되기 전에 저장된 나인하이어 후보자 메시지 중 ‘일정에 불참합니다’ 알림을 다시 처리합니다. 일정·회의실·Slack 메시지는 변경하지 않고 검토 건만 생성합니다.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => result(workflow.reprocessCandidateInterviewAbsenceNotifications()),
  );

  server.registerTool(
    "approve_interview_arrangement",
    {
      title: "면접 조율 시작 승인",
      description:
        "완료된 나인하이어 평가표 요약을 확인한 뒤 이 지원자의 면접 조율 건을 생성합니다. Slack 메시지는 발송하지 않습니다.",
      inputSchema: {
        reviewId: z.string().uuid(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reviewId }) =>
      result(await workflow.approveInterviewArrangement(reviewId)),
  );

  server.registerTool(
    "resolve_interviewer_review",
    {
      title: "면접관 예외 검토 완료",
      description:
        "면접관 불참·미응답·조회 실패에 대해 교체/제외/선택 참여 등의 조치를 한 뒤 검토 건을 완료 처리합니다. 평가 결과 검토에는 사용할 수 없습니다.",
      inputSchema: {
        reviewId: z.string().uuid(),
        resolution: z.string().min(3).max(500),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reviewId, resolution }) => {
      const review = db.getReview(reviewId);
      if (!review || review.status !== "OPEN") {
        throw new Error(`Open review not found: ${reviewId}`);
      }
      const allowed = new Set([
        "INTERVIEWER_DECLINED",
        "INTERVIEWER_NO_RESPONSE",
        "INTERVIEWER_LOOKUP_REQUIRED",
        "INTERVIEWER_GROUP_MEMBERS_REQUIRED",
      ]);
      if (!allowed.has(review.reviewType)) {
        throw new Error(
          "This review type requires its dedicated resolution tool.",
        );
      }
      db.resolveReview(reviewId, resolution);
      if (review.caseId) db.refreshCaseCollectionStatus(review.caseId);
      return result({
        resolved: true,
        reviewId,
        caseId: review.caseId,
        resolution,
      });
    },
  );

  server.registerTool(
    "resolve_candidate_interview_absence_review",
    {
      title: "후보자 인터뷰 불참 검토 처리",
      description:
        "후보자의 불참 메시지에 대해 기존 가능 시간으로 재조율, 면접관 일정 재수집 후 재조율, 인터뷰 취소, 보류 중 하나를 명시적으로 처리합니다. 재조율·취소 시에도 Slack 안내는 초안만 만들고 자동 발송하지 않습니다.",
      inputSchema: {
        reviewId: z.string().uuid(),
        action: z.enum([
          "RESCHEDULE_USING_EXISTING_AVAILABILITY",
          "RESCHEDULE_WITH_NEW_AVAILABILITY",
          "CANCEL",
          "HOLD",
        ]),
        note: z.string().trim().min(1).max(500).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => result(workflow.resolveCandidateInterviewAbsenceReview(input)),
  );

  server.registerTool(
    "sync_case_interviewers",
    {
      title: "면접관 다시 조회",
      description:
        "나인하이어에서 해당 면접 건의 최신 면접관을 다시 읽고 로컬 스냅샷과 Slack 사용자 매핑을 갱신합니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ caseId }) =>
      result(await workflow.syncCaseInterviewers(caseId)),
  );

  server.registerTool(
    "map_interviewer_to_slack",
    {
      title: "면접관 Slack 사용자 연결",
      description:
        "자동 이메일 매칭이 실패한 나인하이어 사용자를 Slack 사용자 ID에 한 번 연결해 캐시합니다.",
      inputSchema: {
        ninehireUserId: z.string().min(1),
        slackUserId: z.string().min(1),
        displayName: z.string().min(1).optional(),
        email: z.string().email().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      db.upsertIdentityMapping(input);
      return result({ mapped: true, ...input });
    },
  );

  server.registerTool(
    "add_case_interviewer",
    {
      title: "면접 건에 면접관 추가",
      description:
        "이번 면접 건에만 추가 면접관을 넣습니다. 전역 채용 설정은 변경하지 않습니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        displayName: z.string().min(1),
        slackUserId: z.string().min(1).optional(),
        email: z.string().email().optional(),
        required: z.boolean().default(true),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ caseId, ...person }) =>
      result(
        db.addOrUpdateInterviewer({
          caseId,
          ...person,
          source: "MANUAL",
        }),
      ),
  );

  server.registerTool(
    "exclude_case_interviewer",
    {
      title: "면접 건에서 면접관 제외",
      description:
        "면접관을 이번 건의 활성 목록에서 제외하되 감사 이력은 보존합니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        interviewerId: z.string().uuid(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ caseId, interviewerId }) => {
      db.excludeInterviewer(caseId, interviewerId);
      return result({ excluded: true, caseId, interviewerId });
    },
  );

  server.registerTool(
    "set_interviewer_required",
    {
      title: "필수 면접관 여부 변경",
      description:
        "특정 면접관을 이번 건에서 필수 또는 선택 참여자로 변경합니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        interviewerId: z.string().uuid(),
        required: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId, interviewerId, required }) => {
      db.setInterviewerRequired(caseId, interviewerId, required);
      return result({ updated: true, caseId, interviewerId, required });
    },
  );

  server.registerTool(
    "set_case_schedule_rules",
    {
      title: "인터뷰 시간·제안 날짜 변경",
      description:
        "기본 60분 또는 PDF 날짜 규칙에서 벗어나는 건의 소요시간과 제안 날짜를 건별로 변경합니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        durationMinutes: z.number().int().min(15).max(480).optional(),
        proposalDates: z
          .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
          .min(1)
          .max(20)
          .optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId, durationMinutes, proposalDates }) => {
      workflow.getCaseOrThrow(caseId);
      if (durationMinutes !== undefined) {
        db.setCaseDuration(caseId, durationMinutes);
      }
      if (proposalDates) db.setCaseProposalDates(caseId, proposalDates);
      return result(db.getCase(caseId));
    },
  );

  server.registerTool(
    "record_manual_availability",
    {
      title: "가용시간 수동 기록",
      description:
        "체크박스의 1시간 단위로 표현할 수 없는 예외 시간을 면접관별로 직접 기록합니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        interviewerId: z.string().uuid(),
        slots: z
          .array(
            z.object({
              date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              start: z.string().regex(/^\d{2}:\d{2}$/),
              end: z.string().regex(/^\d{2}:\d{2}$/),
            }),
          )
          .min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId, interviewerId, slots }) =>
      result(
        db.replaceAvailabilityForInterviewer(
          caseId,
          interviewerId,
          slots,
        ),
      ),
  );

  server.registerTool(
    "create_interviewer_request_draft",
    {
      title: "면접관 일정 요청 초안 생성",
      description:
        "Slack에 발송하지 않고 대상·날짜·버튼이 포함된 메시지 초안을 로컬에 생성합니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ caseId }) => result(await workflow.createRequestDraft(caseId)),
  );

  server.registerTool(
    "create_interviewer_schedule_confirmation_draft",
    {
      title: "면접관 최종 일정 안내 초안 생성",
      description:
        "내부 확정된 면접 시간·회의실·면접관을 기존 테스트 채널에 안내하는 Slack 초안을 생성합니다. 발송하지 않습니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ caseId }) =>
      result(workflow.createScheduleConfirmationDraft(caseId)),
  );

  server.registerTool(
    "list_pending_message_drafts",
    {
      title: "발송 승인 대기 초안",
      description: "사용자 승인 전인 Slack 메시지 초안을 조회합니다.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => result({ drafts: db.listDrafts("DRAFT") }),
  );

  server.registerTool(
    "replace_pending_message_draft_text",
    {
      title: "발송 대기 Slack 초안 문구 수정",
      description:
        "발송 전 Slack 초안에서 지정한 문구 하나를 정확히 찾아 새 문구로 바꿉니다. 초안은 발송하지 않습니다.",
      inputSchema: {
        draftId: z.string().uuid(),
        textToReplace: z.string().trim().min(1).max(1_000),
        replacementText: z.string().trim().min(1).max(1_000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => result(workflow.replacePendingDraftText(input)),
  );

  server.registerTool(
    "approve_and_send_interviewer_request",
    {
      title: "면접관 일정 요청 승인·발송",
      description:
        "선택한 초안을 명시적으로 승인하고 설정된 테스트 채널에 Slack 메시지를 발송합니다.",
      inputSchema: { draftId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ draftId }) => {
      if (!slackClient) throw new Error("SLACK_BOT_TOKEN is not configured.");
      return result(
        await workflow.approveAndSendInterviewerRequest(draftId, slackClient),
      );
    },
  );

  server.registerTool(
    "approve_and_send_interviewer_schedule_confirmation",
    {
      title: "면접관 최종 일정 안내 승인·발송",
      description:
        "사용자가 검토한 최종 일정 안내 초안을 명시적으로 승인하고 Slack 테스트 채널에 발송합니다.",
      inputSchema: { draftId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ draftId }) => {
      if (!slackClient) throw new Error("SLACK_BOT_TOKEN is not configured.");
      return result(
        await workflow.approveAndSendScheduleConfirmation(draftId, slackClient),
      );
    },
  );

  server.registerTool(
    "approve_and_send_interviewer_schedule_update",
    {
      title: "면접관 일정 변경·취소 안내 승인·발송",
      description:
        "사용자가 검토한 면접 일정 변경 또는 취소 안내 초안을 명시적으로 승인하고 Slack 테스트 채널에 발송합니다.",
      inputSchema: { draftId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ draftId }) => {
      if (!slackClient) throw new Error("SLACK_BOT_TOKEN is not configured.");
      return result(await workflow.approveAndSendScheduleUpdate(draftId, slackClient));
    },
  );

  return server;
}
