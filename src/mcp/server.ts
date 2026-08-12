import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { BrowserDaouOfficeReservationAdapter } from "../daou-office/adapter.js";
import { DaouOfficeBrowserController } from "../daou-office/browser.js";
import {
  BridgeDatabase,
  type InterviewCaseRow,
  type IntegrationRetryJobRow,
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
import { suggestSequentialInterviewSlotsWithRooms } from "../services/sequential-scheduling.js";
import { OperationalReadinessService } from "../services/operational-readiness.js";
import { InterviewArrangementSkills } from "../skills/interview-arrangement.js";
import { SlackReconciler } from "../slack/reconciler.js";
import { withDashboardFreshness } from "../dashboard/service.js";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent:
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : { value },
  };
}

function integrationRetrySummary(job: IntegrationRetryJobRow) {
  return {
    id: job.id,
    jobType: job.jobType,
    status: job.status,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.nextAttemptAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    lastError: job.lastError ? "외부 연동 작업이 실패했습니다. 운영 상태와 권한을 확인하세요." : null,
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
    scheduledRoomName: interviewCase.scheduledRoomName,
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
      ? new WebClient(config.slack.botToken, { timeout: 30_000 })
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
  const readiness = new OperationalReadinessService(
    config,
    db,
    gateway,
    daouOfficeBrowser,
    slackClient,
  );
  const interviewSkills = new InterviewArrangementSkills(db, workflow, readiness);

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
            mode: "DEDICATED_CHROME_PROFILE",
            url: config.daouOffice.url,
          },
        },
      }),
  );

  server.registerTool(
    "get_operational_readiness",
    {
      title: "인터뷰 브릿지 운영 사전점검",
      description:
        "로컬 DB, 워커, Slack 설정, 나인하이어 설정, 다우오피스 전용 브라우저와 마지막 동기화 상태를 점검합니다. checkExternal이 true일 때만 Slack 인증과 나인하이어 도구 목록을 읽기 전용으로 확인합니다.",
      inputSchema: {
        checkExternal: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ checkExternal }) => result(await readiness.inspect({ checkExternal })),
  );

  server.registerTool(
    "daou_office_browser_status",
    {
      title: "다우오피스 브라우저 상태",
      description:
        "전용 Chrome 프로필과 로컬 전용 디버그 연결의 준비 상태를 확인합니다. 다우오피스 예약을 읽거나 변경하지 않습니다.",
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
        "개인 브라우저와 분리된 로컬 Chrome 프로필로 다우오피스를 엽니다. 최초 로그인은 사용자가 직접 수행하며, 예약을 읽거나 변경하지 않습니다.",
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
      title: "다우오피스 인터뷰 회의실 예약 동기화",
      description:
        "해당 인터뷰 건의 제안 날짜에 대해 전용 브라우저로 다우오피스 예약을 읽고, 지정 인터뷰 회의실·예약자·이용 목적이 모두 일치하는 예약 블록만 로컬 DB에 반영합니다. 다우오피스 예약을 변경하지 않습니다.",
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
      title: "동기화된 인터뷰 회의실 예약 블록 조회",
      description:
        "로컬 DB에 동기화된 인터뷰 회의실 예약 블록을 조회합니다. 예약자 이름은 출력하지 않습니다.",
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
      title: "면접관과 회의실을 함께 반영한 일정 추천",
      description:
        "면접관 공통 가능 시간과 동기화된 인터뷰 회의실 예약 블록, 이미 로컬에 배정한 인터뷰 시간을 함께 반영해 추천합니다. 일정이나 예약을 변경하지 않습니다.",
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
    "suggest_sequential_interview_slots_with_rooms",
    {
      title: "연속 인터뷰 시간과 회의실 추천",
      description:
        "단계별 면접관의 가용시간을 각각 계산합니다. 1차→2차 순서를 우선 추천하고, 가능한 조합이 없을 때만 역순을 제안합니다. 같은 회의실 연속 배정을 우선하며 불가하면 단계별 다른 회의실을 제안합니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId }) => result(suggestSequentialInterviewSlotsWithRooms(db, caseId)),
  );

  server.registerTool(
    "allocate_interview_room_slot",
    {
      title: "인터뷰 회의실 내부 시간대 배정",
      description:
        "사용자가 선택한 인터뷰 시간과 회의실 블록을 로컬 DB에 배정해 다른 후보자와 겹치지 않도록 합니다. 다우오피스 예약은 변경하지 않습니다.",
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
    "allocate_sequential_interview_room_slots",
    {
      title: "연속 인터뷰 단계별 회의실 배정",
      description:
        "추천된 연속 인터뷰의 각 60분 단계에 회의실을 로컬로 배정합니다. 같은 회의실 또는 단계별 다른 회의실을 사용할 수 있으며 다우오피스 예약은 변경하지 않습니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        sessions: z.array(z.object({
          stepId: z.string().min(1),
          roomBlockId: z.string().uuid(),
          startTime: z.string().regex(/^\d{2}:\d{2}$/),
          endTime: z.string().regex(/^\d{2}:\d{2}$/),
        })).min(2).max(10),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => result(db.allocateSequentialRoomBlocks(input)),
  );

  server.registerTool(
    "confirm_internal_interview_schedule",
    {
      title: "인터뷰 내부 일정 확정",
      description:
        "활성 인터뷰 회의실 배정을 내부 확정 일정으로 기록하고 후보자 확인 대기 상태로 변경합니다. Slack이나 나인하이어에는 전송하지 않습니다.",
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
    "confirm_sequential_interview_schedule",
    {
      title: "연속 인터뷰 내부 일정 확정",
      description:
        "단계별 회의실 배정을 하나의 연속 인터뷰 일정으로 내부 확정합니다. 후보자·Slack·나인하이어에는 전송하지 않습니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId }) => result(db.confirmSequentialInternalSchedule(caseId)),
  );

  server.registerTool(
    "cancel_interview_room_allocation",
    {
      title: "인터뷰 회의실 내부 배정 취소",
      description:
        "로컬 DB의 인터뷰 회의실 내부 배정만 취소합니다. 다우오피스 예약은 변경하지 않습니다.",
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
        "인터뷰 건을 취소하고 로컬 인터뷰 회의실 배정, 미발송 초안, 미발송 리마인더를 정리합니다. 기존 일정 안내가 발송된 경우 Slack 취소 안내 초안도 생성하지만 자동 발송하지 않습니다. 다우오피스 예약은 변경하지 않습니다.",
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
    "close_interview_arrangement",
    {
      title: "인터뷰 조율 종료",
      description:
        "일정 확정 전, 채용 판단으로 더 이상 진행하지 않을 인터뷰 조율 건을 로컬 운영에서 종료합니다. 미발송 초안, 미발송 리마인드, 수집된 가능 일정과 열린 검토를 정리하며 Slack이나 나인하이어에는 아무 메시지나 변경 요청도 보내지 않습니다.",
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
    async (input) => result(workflow.closeInterviewArrangement(input)),
  );

  server.registerTool(
    "backfill_cancellation_external_follow_ups",
    {
      title: "기존 취소 건 외부 확인 항목 생성",
      description:
        "기존에 취소된 인터뷰 건에 나인하이어 후보자 일정 확인 항목을 추가합니다. 다우오피스 회의실 예약은 취소 후에도 유지하며 외부 시스템을 변경하지 않습니다.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => result(db.backfillCancellationExternalFollowUps()),
  );

  server.registerTool(
    "list_cancellation_external_follow_ups",
    {
      title: "취소 건 외부 확인 목록",
      description:
        "취소된 인터뷰의 나인하이어 후보자 일정 확인 항목을 조회합니다.",
      inputSchema: {
        status: z.enum(["PENDING", "CONFIRMED", "NOT_REQUIRED"]).optional(),
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
        followUps: db
          .listCancellationExternalFollowUps({ status, limit })
          .map((followUp) => {
            const interviewCase = db.getCase(followUp.caseId);
            return {
              ...followUp,
              candidateName: interviewCase?.candidateName ?? null,
              recruitmentName: interviewCase?.recruitmentName ?? null,
            };
          }),
      }),
  );

  server.registerTool(
    "resolve_cancellation_external_follow_up",
    {
      title: "취소 건 외부 확인 완료 기록",
      description:
        "수동으로 확인한 나인하이어 후보자 일정 처리 결과를 기록합니다. 외부 시스템을 변경하지 않습니다.",
      inputSchema: {
        followUpId: z.string().uuid(),
        status: z.enum(["CONFIRMED", "NOT_REQUIRED"]),
        resolutionNote: z.string().trim().min(1).max(500).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => result(db.resolveCancellationExternalFollowUp(input)),
  );

  server.registerTool(
    "list_interview_cases",
    {
      title: "인터뷰 건 목록",
      description:
        "진행 중이거나 예정된 인터뷰 조율 건을 조회합니다. 취소 이력은 status에 CANCELLED를 지정한 경우에만 조회합니다.",
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
        cases: (status
          ? db.listCases(status, limit)
          : db.listOperationalCases(limit)
        ).map(caseSummary),
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
      return result({
        ...bundle,
        interviewPlan: db.getCaseInterviewPlan(caseId) ?? null,
      });
    },
  );

  server.registerTool(
    "get_interview_operations_dashboard",
    {
      title: "인터뷰 운영 현황 조회",
      description:
        "웹 화면 없이도 진행·확정·취소·검토 대기·면접관 미응답·취소 후 외부 확인 대기를 한 번에 조회할 수 있는 대시보드용 데이터를 반환합니다.",
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
    async ({ limit }) => result(withDashboardFreshness(db, db.getOperationsDashboard(limit))),
  );

  server.registerTool(
    "get_interview_skill_operations",
    {
      title: "인터뷰 업무 스킬 운영 현황",
      description:
        "대시보드와 MCP가 함께 쓰는 운영 현황, 준비 상태, 사용자 선택 대기 목록을 읽기 전용으로 조회합니다.",
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
    async ({ limit }) => result(await interviewSkills.getOperationsControl(limit)),
  );

  server.registerTool(
    "create_candidate_triage_decision",
    {
      title: "후보자 인터뷰 조율 시작 선택 만들기",
      description:
        "평가 완료 또는 채용 단계 검토 건을 사용자 선택 가능한 인터뷰 조율 시작 결정으로 만듭니다. 외부 메시지나 일정은 변경하지 않습니다.",
      inputSchema: { reviewId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reviewId }) => result(interviewSkills.createCandidateTriageDecision(reviewId)),
  );

  server.registerTool(
    "create_availability_collection_decision",
    {
      title: "면접관 일정 수집 선택 만들기",
      description:
        "면접관 조회, Slack 연결, 일정 요청 초안, 제출 대기 중 현재 필요한 다음 선택을 만듭니다. 메시지는 발송하지 않습니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId }) => result(interviewSkills.createAvailabilityCollectionDecision(caseId)),
  );

  server.registerTool(
    "create_interview_scheduling_decision",
    {
      title: "인터뷰 일정과 회의실 선택 만들기",
      description:
        "면접관 가능 일정과 동기화된 회의실 블록을 조합해 내부 확정 전 사용자 선택지를 만듭니다. 메시지는 발송하지 않습니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ caseId }) => result(interviewSkills.createInterviewSchedulingDecision(caseId)),
  );

  server.registerTool(
    "create_candidate_schedule_response_decision",
    {
      title: "후보자 불참·일정 변경 선택 만들기",
      description:
        "후보자 불참 또는 일정 변경 가능성 메시지를 재조율, 취소, 보류 중 하나로 처리하기 위한 선택지를 만듭니다.",
      inputSchema: { reviewId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reviewId }) => result(interviewSkills.createCandidateScheduleResponseDecision(reviewId)),
  );

  server.registerTool(
    "list_pending_interview_skill_decisions",
    {
      title: "인터뷰 업무 스킬 선택 대기 목록",
      description:
        "사용자 선택이 필요한 인터뷰 업무 스킬 결정을 조회합니다.",
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
    async ({ limit }) => result({ decisions: interviewSkills.listPendingDecisions(limit) }),
  );

  server.registerTool(
    "resolve_interview_skill_decision",
    {
      title: "인터뷰 업무 스킬 선택 처리",
      description:
        "사용자가 고른 하나의 선택지를 처리합니다. 내부 일정 확정·재조율·취소 등 로컬 상태 변경이 있을 수 있지만 Slack 메시지는 자동 발송하지 않습니다.",
      inputSchema: {
        decisionId: z.string().uuid(),
        optionId: z.string().trim().min(1).max(100),
        note: z.string().trim().min(1).max(500).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => result(await interviewSkills.resolveDecision(input)),
  );

  server.registerTool(
    "list_integration_retry_jobs",
    {
      title: "외부 연동 재시도 현황",
      description:
        "Slack 알림 동기화와 나인하이어 평가 조회의 재시도 대기·실패 현황을 조회합니다. 외부 시스템을 호출하지 않습니다.",
      inputSchema: {
        status: z.enum(["PENDING", "FAILED", "COMPLETED"]).optional(),
        limit: z.number().int().min(1).max(200).default(100),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ status, limit }) => result({
      retries: db.listIntegrationRetryJobs({ status, limit }).map(integrationRetrySummary),
    }),
  );

  server.registerTool(
    "retry_integration_job",
    {
      title: "외부 연동 작업 재시도 승인",
      description:
        "재시도 한도를 초과한 내부 연동 작업을 사용자가 확인한 뒤 다시 대기열에 넣습니다. 외부 시스템을 즉시 호출하거나 메시지를 발송하지 않으며, 다음 워커 주기에 처리됩니다.",
      inputSchema: {
        retryJobId: z.string().uuid(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ retryJobId }) => {
      const requeued = workflow.requeueIntegrationRetryJob(retryJobId);
      return result({
        queued: requeued.queued,
        retryJob: {
          id: requeued.job.id,
          jobType: requeued.job.jobType,
          status: requeued.job.status,
          attemptCount: requeued.job.attemptCount,
          maxAttempts: requeued.job.maxAttempts,
          nextAttemptAt: requeued.job.nextAttemptAt,
        },
        message: requeued.queued
          ? "재시도 작업을 대기열에 넣었습니다. 다음 워커 주기에 처리됩니다."
          : "이미 대기 중인 재시도 작업이 있어 중복 등록하지 않았습니다.",
      });
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
    "set_recruitment_slack_channel",
    {
      title: "채용별 Slack 발송 채널 설정",
      description:
        "특정 채용의 면접관 일정 요청·확정 안내·변경 안내·리마인드를 보낼 Slack 채널을 로컬 설정에 저장합니다. Slack 메시지를 보내지는 않습니다.",
      inputSchema: {
        recruitmentId: z.string().min(1),
        recruitmentName: z.string().trim().min(1).max(200),
        channelId: z.string().trim().regex(/^[CG][A-Z0-9]+$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => result(db.upsertRecruitmentSlackChannel(input)),
  );

  server.registerTool(
    "list_recruitment_slack_channels",
    {
      title: "채용별 Slack 발송 채널 조회",
      description:
        "로컬에 저장된 채용별 Slack 발송 채널 매핑만 조회합니다. Slack이나 나인하이어에는 요청하지 않습니다.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => result({ channels: db.listRecruitmentSlackChannels() }),
  );

  server.registerTool(
    "list_closed_recruitments",
    {
      title: "종료된 나인하이어 채용 목록",
      description:
        "나인하이어에서 상태가 종료인 채용만 읽기 전용으로 조회합니다. 지원자와 참여자 정보는 반환하지 않습니다.",
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
    async (input) => {
      if (!ninehire.listClosedRecruitments) {
        throw new Error("The configured NineHire adapter does not support closed recruitment lookup.");
      }
      return result(await ninehire.listClosedRecruitments(input));
    },
  );

  server.registerTool(
    "preview_recruitment_interview_template",
    {
      title: "채용 인터뷰 단계 템플릿 미리 보기",
      description:
        "나인하이어 칸반 단계와 기존 승인 템플릿을 비교합니다. 단계 선택과 승인 전에는 데이터를 변경하지 않습니다.",
      inputSchema: { recruitmentId: z.string().min(1) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ recruitmentId }) =>
      result(await workflow.previewRecruitmentInterviewTemplate(recruitmentId)),
  );

  server.registerTool(
    "approve_recruitment_interview_template",
    {
      title: "채용 인터뷰 단계 템플릿 승인",
      description:
        "확인한 칸반 단계만 인터뷰 단계로 저장합니다. 기본 시간은 60분이며 단계별 소요시간을 명시적으로 바꿀 수 있습니다. COMBINED는 한 시간에 모든 참석자가 함께 진행하는 인터뷰입니다.",
      inputSchema: {
        recruitmentId: z.string().min(1),
        steps: z.array(z.object({
          stepId: z.string().min(1),
          mode: z.enum(["STANDARD", "COMBINED"]),
          durationMinutes: z.number().int().positive().optional(),
        })).min(1).max(10),
        routes: z.array(z.object({
          triggerStepId: z.string().min(1),
          mode: z.enum(["STANDARD", "COMBINED", "SEQUENTIAL"]),
          stepIds: z.array(z.string().min(1)).min(1).max(10),
        })).max(10).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => result(await workflow.approveRecruitmentInterviewTemplate(input)),
  );

  server.registerTool(
    "get_recruitment_interview_template",
    {
      title: "승인된 채용 인터뷰 템플릿 조회",
      description: "로컬에 승인·저장된 채용별 인터뷰 단계 규칙을 조회합니다.",
      inputSchema: { recruitmentId: z.string().min(1) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ recruitmentId }) =>
      result({ template: db.getRecruitmentInterviewTemplate(recruitmentId) ?? null }),
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
      const reconciliation = await reconciler.reconcile();
      db.setCursor("sync:slack:last_success", new Date().toISOString());
      return result(reconciliation);
    },
  );

  server.registerTool(
    "sync_ninehire_confirmed_interview_schedules",
    {
      title: "나인하이어 직접 확정 인터뷰 동기화",
      description:
        "Slack 알림이 없는 나인하이어 직접 등록 일정을 조회해, 추적 중인 후보자의 확정 인터뷰와 회의실 선택 검토를 로컬 상태에 반영합니다. 나인하이어·Slack·다우오피스에는 변경을 전송하지 않습니다.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const reconciliation = await workflow.reconcileNinehireConfirmedSchedules();
      db.setCursor("sync:ninehire:last_success", new Date().toISOString());
      return result(reconciliation);
    },
  );

  server.registerTool(
    "sync_ninehire_receipt_evaluations",
    {
      title: "나인하이어 서류 평가 완료 즉시 확인",
      description:
        "Slack 알림 누락 여부와 관계없이 현재 관리 중인 채용의 접수 단계 완료 평가를 나인하이어에서 직접 확인합니다. 합격 표가 하나라도 있는 후보자는 조율 시작 검토로만 추가하며, 메시지 발송이나 나인하이어 상태 변경은 하지 않습니다.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => result(await workflow.reconcileReceiptEvaluationCompletions()),
  );

  server.registerTool(
    "reprocess_interview_arrangement_eligibility_reviews",
    {
      title: "기존 인터뷰 조율 대상 재판정",
      description:
        "기존 인터뷰 조율 시작 검토 건을 최종 평가 항목 기준으로 다시 판정합니다. 합격이 하나라도 있으면 유지하고, 합격 없이 불합격·보류만 있으면 제외합니다. 외부 메시지나 나인하이어 데이터는 변경하지 않습니다.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => result(workflow.reprocessInterviewArrangementEligibilityReviews()),
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
      title: "인터뷰 조율 시작 승인",
      description:
        "완료된 나인하이어 평가표 요약과 승인된 인터뷰 유형을 확인한 뒤 이 지원자의 인터뷰 조율 건을 생성합니다. 나인하이어 칸반과 Slack 메시지는 변경하지 않습니다.",
      inputSchema: {
        reviewId: z.string().uuid(),
        routeTriggerStepId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      result(await workflow.approveInterviewArrangement(input)),
  );

  server.registerTool(
    "apply_case_interview_template_route",
    {
      title: "기존 인터뷰 건에 승인 템플릿 경로 적용",
      description:
        "인터뷰 계획 없이 생성된 기존 로컬 조율 건에 승인된 채용 템플릿 경로를 적용합니다. 면접관 요청 초안이 만들어지기 전의 건에만 적용되며 나인하이어와 Slack은 변경하지 않습니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        routeTriggerStepId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => result(await workflow.applyTemplateInterviewRouteToCase(input)),
  );

  server.registerTool(
    "record_manual_confirmed_interview",
    {
      title: "수동 최종 확정 인터뷰 기록",
      description:
        "서버 밖에서 조율되고 후보자 수락까지 끝난 인터뷰를 최종 확정 이력으로 기록합니다. Slack, 나인하이어, 다우오피스에는 변경을 전송하지 않습니다.",
      inputSchema: {
        reviewId: z.string().uuid(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        roomName: z.string().min(1).max(100),
        note: z.string().min(1).max(500).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => result(workflow.recordManualConfirmedInterview(input)),
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
        "나인하이어에서 해당 인터뷰 건의 최신 면접관을 다시 읽고 로컬 스냅샷과 Slack 사용자 매핑을 갱신합니다.",
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
      title: "인터뷰 건에 면접관 추가",
      description:
        "이번 인터뷰 건에만 추가 면접관을 넣습니다. 전역 채용 설정은 변경하지 않습니다.",
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
      title: "인터뷰 건에서 면접관 제외",
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
    "set_case_combined_interview_plan",
    {
      title: "후보자 통합 인터뷰 예외 적용",
      description:
        "선택한 두 개 이상 인터뷰 단계를 한 번의 60분 인터뷰로 묶고, 이번 후보자에게 실제 참석할 면접관만 필수로 설정합니다. 면접관 일정 요청을 발송하기 전 단계에서만 변경할 수 있습니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        stepIds: z.array(z.string().min(1)).min(2).max(10),
        interviewerIds: z.array(z.string().uuid()).min(1).max(30),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => result(workflow.setCaseCombinedInterviewPlan(input)),
  );

  server.registerTool(
    "set_case_sequential_interview_plan",
    {
      title: "연속 인터뷰 단계별 계획 적용",
      description:
        "같은 날 이어서 진행할 인터뷰 단계를 원래 순서대로 설정하고, 단계별 실제 참석 면접관을 지정합니다. 각 단계의 면접관 가용시간은 서로 독립적으로 계산합니다.",
      inputSchema: {
        caseId: z.string().uuid(),
        sessions: z.array(z.object({
          stepId: z.string().min(1),
          interviewerIds: z.array(z.string().uuid()).min(1).max(30),
        })).min(2).max(10),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => result(workflow.setCaseSequentialInterviewPlan(input)),
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
    "create_availability_recovery_draft",
    {
      title: "워커 중단 후 일정 재제출 요청 초안",
      description:
        "Slack 워커 중단으로 가용시간 제출이 누락됐을 수 있는 인터뷰 건의 미제출 면접관에게 재제출을 요청하는 Slack 초안을 만듭니다. 발송하지 않습니다.",
      inputSchema: { reviewId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reviewId }) =>
      result(workflow.createAvailabilityRecoveryDraft(reviewId)),
  );

  server.registerTool(
    "create_interviewer_availability_reminder_draft",
    {
      title: "면접관 일정 입력 재안내 초안 생성",
      description:
        "아직 가능 일정을 제출하지 않은 필수 면접관에게 보낼 재안내 Slack 초안을 생성합니다. 발송하지 않습니다.",
      inputSchema: { caseId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ caseId }) => result(workflow.createAvailabilityReminderDraft(caseId)),
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
        "내부 확정된 인터뷰 시간·회의실·면접관을 기존 테스트 채널에 안내하는 Slack 초안을 생성합니다. 발송하지 않습니다.",
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
    "approve_and_send_availability_recovery",
    {
      title: "일정 재제출 요청 승인·발송",
      description:
        "워커 중단 검토 건의 재제출 요청 초안을 명시적으로 승인하고 Slack에 발송합니다. 발송이 완료되면 해당 중단 검토 건을 해결 처리합니다.",
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
        await workflow.approveAndSendAvailabilityRecovery(draftId, slackClient),
      );
    },
  );

  server.registerTool(
    "approve_and_send_interviewer_availability_reminder",
    {
      title: "면접관 일정 입력 재안내 승인 및 발송",
      description:
        "검토한 일정 입력 재안내 초안을 명시적으로 승인하고 Slack에 발송합니다.",
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
        await workflow.approveAndSendAvailabilityReminder(draftId, slackClient),
      );
    },
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
        "사용자가 검토한 인터뷰 일정 변경 또는 취소 안내 초안을 명시적으로 승인하고 Slack 테스트 채널에 발송합니다.",
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
