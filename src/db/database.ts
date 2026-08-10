import { randomUUID } from "node:crypto";
import { backup as backupDatabase, DatabaseSync } from "node:sqlite";
import {
  INTERVIEW_BRIDGE_WORKER_KEY,
  WORKER_DOWNTIME_THRESHOLD_MS,
} from "../domain/worker-health.js";
import {
  INTEGRATION_RETRY_MAX_ATTEMPTS,
  retryDelayMs,
  type IntegrationRetryJobType,
} from "../domain/integration-retry.js";
import type {
  InterviewCaseStatus,
  InterviewerStatus,
  RescheduleAvailabilityPolicy,
  SlackNotificationInput,
  TimeSlot,
} from "../domain/types.js";
import type {
  InterviewSkillDecisionInput,
  InterviewSkillDecisionOption,
  InterviewSkillDecisionStatus,
  InterviewSkillKey,
  InterviewSkillSelectionMode,
} from "../domain/skills.js";
import type { DaouInterviewCalendarEvent } from "../domain/daou-calendar.js";
import type { MeetingRoomBlockInput } from "../domain/daou-office.js";
import { firstReminderAt, secondReminderAt } from "../domain/calendar.js";

type SqlRow = Record<string, unknown>;

const DRAFT_SEND_LEASE_MS = 2 * 60 * 1000;
const MEETING_ROOM_SYNC_FRESHNESS_MS = 10 * 60 * 1000;

export interface InterviewCaseRow {
  id: string;
  notificationId: string | null;
  candidateRef: string | null;
  candidateName: string | null;
  recruitmentRef: string | null;
  recruitmentName: string | null;
  status: InterviewCaseStatus;
  durationMinutes: number;
  proposalDates: string[];
  scheduleRound: number;
  scheduledRoomAllocationId: string | null;
  scheduledRoomName: string | null;
  scheduledDate: string | null;
  scheduledStartTime: string | null;
  scheduledEndTime: string | null;
  internalScheduleConfirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InterviewerRow {
  id: string;
  caseId: string;
  ninehireUserId: string | null;
  slackUserId: string | null;
  displayName: string;
  email: string | null;
  required: boolean;
  active: boolean;
  source: "NINEHIRE" | "MANUAL";
  status: InterviewerStatus;
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftRow {
  id: string;
  caseId: string;
  channelId: string;
  previewText: string;
  blocksJson: string;
  payloadHash: string;
  messageType:
    | "INTERVIEWER_REQUEST"
    | "AVAILABILITY_RECOVERY"
    | "SCHEDULE_CONFIRMATION"
    | "SCHEDULE_CHANGE"
    | "SCHEDULE_CANCELLATION";
  status: "DRAFT" | "APPROVED" | "SENDING" | "SENT" | "CANCELLED";
  approvedAt: string | null;
  sendingStartedAt: string | null;
  sentAt: string | null;
  slackMessageTs: string | null;
  workflowReviewId: string | null;
  createdAt: string;
}

export interface CaseEventRow {
  id: string;
  caseId: string | null;
  eventType: string;
  actor: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ReviewRow {
  id: string;
  notificationId: string | null;
  caseId: string | null;
  reviewType: string;
  reason: string;
  summary: Record<string, unknown> | null;
  status: "OPEN" | "RESOLVED";
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface InterviewSkillDecisionRow extends InterviewSkillDecisionInput {
  id: string;
  status: InterviewSkillDecisionStatus;
  selectedOptionId: string | null;
  resolution: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface WorkerHealthRow {
  workerKey: string;
  lastStartedAt: string;
  lastHeartbeatAt: string;
  lastSuccessfulCycleAt: string | null;
  lastErrorMessage: string | null;
  lastDowntimeStartedAt: string | null;
  lastDowntimeDetectedAt: string | null;
  leaseExpiresAt: string | null;
}

export interface WorkerLeaseResult {
  acquired: boolean;
  health: WorkerHealthRow;
  downtime?: WorkerDowntime;
}

export interface WorkerDowntime {
  workerKey: string;
  startedAt: string;
  detectedAt: string;
  durationMs: number;
}

export type IntegrationRetryJobStatus = "PENDING" | "COMPLETED" | "FAILED";

export interface IntegrationRetryJobRow {
  id: string;
  jobType: IntegrationRetryJobType;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  status: IntegrationRetryJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface IntegrationRetryRequeueResult {
  job: IntegrationRetryJobRow;
  queued: boolean;
}

export interface OperationalDataResetResult {
  deleted: Record<string, number>;
  retainedSlackCursorCount: number;
}

export interface StoredSlackNotificationRow {
  id: string;
  eventType: string;
  candidateRef: string | null;
  candidateName: string | null;
  recruitmentRef: string | null;
  recruitmentName: string | null;
  payloadJson: string;
  processingStatus: string;
}

export interface MeetingRoomBlockRow extends MeetingRoomBlockInput {
  id: string;
  active: boolean;
  seenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalConfirmedInterviewRow {
  id: string;
  sourceEventId: string;
  candidateName: string;
  recruitmentName: string;
  date: string;
  startTime: string;
  endTime: string;
  roomName: string | null;
  linkedCaseId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecruitmentSlackChannelRow {
  recruitmentId: string;
  recruitmentName: string;
  channelId: string;
  updatedAt: string;
}

export interface RoomAllocationRow {
  id: string;
  caseId: string;
  roomBlockId: string;
  interviewStepId: string | null;
  date: string;
  startTime: string;
  endTime: string;
  sequenceIndex: number;
  status: "ACTIVE" | "CANCELLED";
  createdAt: string;
  updatedAt: string;
}

export interface ConfirmedInterviewScheduleRow {
  caseId: string;
  roomAllocationId: string | null;
  date: string;
  startTime: string;
  endTime: string;
  roomName: string;
  confirmedAt: string;
}

export interface ScheduleTransitionResult {
  interviewCase: InterviewCaseRow;
  previousSchedule: ConfirmedInterviewScheduleRow | undefined;
  hadSentScheduleConfirmation: boolean;
  cancelledDraftIds: string[];
}

export type CancellationExternalFollowUpType =
  | "NINEHIRE_CANDIDATE_SCHEDULE"
  | "DAOU_ROOM_RESERVATION";

export type CancellationExternalFollowUpStatus =
  | "PENDING"
  | "CONFIRMED"
  | "NOT_REQUIRED";

export interface CancellationExternalFollowUpRow {
  id: string;
  caseId: string;
  followUpType: CancellationExternalFollowUpType;
  status: CancellationExternalFollowUpStatus;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CaseBundle {
  interviewCase: InterviewCaseRow;
  interviewers: InterviewerRow[];
  availability: Array<TimeSlot & { interviewerId: string }>;
  drafts: DraftRow[];
}

export type InterviewPlanMode = "STANDARD" | "COMBINED" | "SEQUENTIAL";

export interface SequentialInterviewSession {
  stepId: string;
  stepName: string;
  interviewerIds: string[];
}

export interface RecruitmentInterviewTemplateStep {
  stepId: string;
  title: string;
  name: string;
  order: number;
  mode: InterviewPlanMode;
  durationMinutes: number;
}

export interface RecruitmentInterviewRoute {
  triggerStepId: string;
  mode: InterviewPlanMode;
  stepIds: string[];
}

export interface RecruitmentInterviewTemplateRow {
  recruitmentId: string;
  recruitmentName: string;
  pipelineHash: string;
  steps: RecruitmentInterviewTemplateStep[];
  routes: RecruitmentInterviewRoute[];
  approvedAt: string;
  updatedAt: string;
}

export interface CaseInterviewPlanRow {
  caseId: string;
  source: "TEMPLATE" | "CANDIDATE_OVERRIDE";
  mode: InterviewPlanMode;
  stepIds: string[];
  stepNames: string[];
  interviewerIds: string[];
  sessions: SequentialInterviewSession[];
  durationMinutes: number;
  createdAt: string;
  updatedAt: string;
}

function asString(value: unknown): string {
  return String(value);
}

function safeErrorSummary(value: string): string {
  return value
    .split(/\r?\n/u, 1)[0]!
    .replace(/\b(?:xox[a-z]-|xapp-)[A-Za-z0-9-]+/giu, "[REDACTED_SLACK_TOKEN]")
    .replace(/\b(?:api[-_ ]?key|authorization|token|secret)\s*[:=]\s*\S+/giu, "[REDACTED_SECRET]")
    .replace(/([?&](?:api[-_]?key|access[_-]?token|token|secret|authorization)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
    .replace(/\b(?:\+82[-\s]?)?0?1[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/gu, "[REDACTED_PHONE]")
    .slice(0, 500);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function isInterviewCaseStatus(value: unknown): value is InterviewCaseStatus {
  return [
    "READY_FOR_DRAFT",
    "DRAFT_CREATED",
    "REQUEST_SENT",
    "COLLECTING_AVAILABILITY",
    "READY_TO_SCHEDULE",
    "AWAITING_CANDIDATE_CONFIRMATION",
    "CONFIRMED",
    "CANCELLED",
    "REVIEW_REQUIRED",
    "ON_HOLD",
    "CLOSED",
  ].includes(String(value));
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function timeMinutes(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time: ${value}`);
  return hour * 60 + minute;
}

function validateTimeRange(startTime: string, endTime: string, label: string): void {
  const start = timeMinutes(startTime);
  const end = timeMinutes(endTime);
  if (start >= end) {
    throw new Error(`${label} must have an end time after its start time.`);
  }
}

function validateDateAndTimeRange(
  date: string,
  startTime: string,
  endTime: string,
  label: string,
): void {
  if (!isDate(date)) throw new Error(`${label} must use YYYY-MM-DD.`);
  validateTimeRange(startTime, endTime, label);
}

function validateAvailabilitySlots(slots: TimeSlot[]): void {
  if (slots.length === 0) {
    throw new Error("At least one interviewer availability slot is required.");
  }
  const seen = new Set<string>();
  for (const slot of slots) {
    validateDateAndTimeRange(
      slot.date,
      slot.start,
      slot.end,
      "Interviewer availability",
    );
    const key = `${slot.date}:${slot.start}:${slot.end}`;
    if (seen.has(key)) throw new Error("Duplicate interviewer availability slots are not allowed.");
    seen.add(key);
  }
}

function toCase(row: SqlRow): InterviewCaseRow {
  return {
    id: asString(row.id),
    notificationId: nullableString(row.notification_id),
    candidateRef: nullableString(row.candidate_ref),
    candidateName: nullableString(row.candidate_name),
    recruitmentRef: nullableString(row.recruitment_ref),
    recruitmentName: nullableString(row.recruitment_name),
    status: asString(row.status) as InterviewCaseStatus,
    durationMinutes: Number(row.duration_minutes),
    proposalDates: JSON.parse(asString(row.proposal_dates_json)) as string[],
    scheduleRound: Number(row.schedule_round ?? 1),
    scheduledRoomAllocationId: nullableString(row.scheduled_room_allocation_id),
    scheduledRoomName: nullableString(row.scheduled_room_name),
    scheduledDate: nullableString(row.scheduled_date),
    scheduledStartTime: nullableString(row.scheduled_start_time),
    scheduledEndTime: nullableString(row.scheduled_end_time),
    internalScheduleConfirmedAt: nullableString(
      row.internal_schedule_confirmed_at,
    ),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function toInterviewer(row: SqlRow): InterviewerRow {
  return {
    id: asString(row.id),
    caseId: asString(row.case_id),
    ninehireUserId: nullableString(row.ninehire_user_id),
    slackUserId: nullableString(row.slack_user_id),
    displayName: asString(row.display_name),
    email: nullableString(row.email),
    required: Number(row.required) === 1,
    active: Number(row.active) === 1,
    source: asString(row.source) as "NINEHIRE" | "MANUAL",
    status: asString(row.status) as InterviewerStatus,
    respondedAt: nullableString(row.responded_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function toDraft(row: SqlRow): DraftRow {
  return {
    id: asString(row.id),
    caseId: asString(row.case_id),
    channelId: asString(row.channel_id),
    previewText: asString(row.preview_text),
    blocksJson: asString(row.blocks_json),
    payloadHash: asString(row.payload_hash),
    messageType: asString(row.message_type) as DraftRow["messageType"],
    status: asString(row.status) as DraftRow["status"],
    approvedAt: nullableString(row.approved_at),
    sendingStartedAt: nullableString(row.sending_started_at),
    sentAt: nullableString(row.sent_at),
    slackMessageTs: nullableString(row.slack_message_ts),
    workflowReviewId: nullableString(row.workflow_review_id),
    createdAt: asString(row.created_at),
  };
}

function toWorkerHealth(row: SqlRow): WorkerHealthRow {
  return {
    workerKey: asString(row.worker_key),
    lastStartedAt: asString(row.last_started_at),
    lastHeartbeatAt: asString(row.last_heartbeat_at),
    lastSuccessfulCycleAt: nullableString(row.last_successful_cycle_at),
    lastErrorMessage: nullableString(row.last_error_message),
    lastDowntimeStartedAt: nullableString(row.last_downtime_started_at),
    lastDowntimeDetectedAt: nullableString(row.last_downtime_detected_at),
    leaseExpiresAt: nullableString(row.lease_expires_at),
  };
}

function toIntegrationRetryJob(row: SqlRow): IntegrationRetryJobRow {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(asString(row.payload_json)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }
  return {
    id: asString(row.id),
    jobType: asString(row.job_type) as IntegrationRetryJobType,
    dedupeKey: asString(row.dedupe_key),
    payload,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: asString(row.next_attempt_at),
    lastError: nullableString(row.last_error),
    status: asString(row.status) as IntegrationRetryJobStatus,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    completedAt: nullableString(row.completed_at),
  };
}

function toReview(row: SqlRow): ReviewRow {
  const summaryJson = nullableString(row.summary_json);
  let summary: Record<string, unknown> | null = null;
  if (summaryJson) {
    try {
      const parsed = JSON.parse(summaryJson) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        summary = parsed as Record<string, unknown>;
      }
    } catch {
      summary = null;
    }
  }
  return {
    id: asString(row.id),
    notificationId: nullableString(row.notification_id),
    caseId: nullableString(row.case_id),
    reviewType: asString(row.review_type),
    reason: asString(row.reason),
    summary,
    status: asString(row.status) as ReviewRow["status"],
    resolution: nullableString(row.resolution),
    createdAt: asString(row.created_at),
    resolvedAt: nullableString(row.resolved_at),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function skillDecisionOptions(value: unknown): InterviewSkillDecisionOption[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((option) => {
      if (typeof option !== "object" || option === null || Array.isArray(option)) {
        return [];
      }
      const record = option as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.label !== "string" ||
        typeof record.description !== "string"
      ) {
        return [];
      }
      return [{ id: record.id, label: record.label, description: record.description }];
    });
  } catch {
    return [];
  }
}

function toInterviewSkillDecision(row: SqlRow): InterviewSkillDecisionRow {
  return {
    id: asString(row.id),
    skillKey: asString(row.skill_key) as InterviewSkillKey,
    decisionType: asString(row.decision_type),
    fingerprint: asString(row.fingerprint),
    title: asString(row.title),
    prompt: asString(row.prompt),
    selectionMode: asString(row.selection_mode) as InterviewSkillSelectionMode,
    options: skillDecisionOptions(row.options_json),
    context: jsonRecord(row.context_json) ?? {},
    caseId: nullableString(row.case_id) ?? undefined,
    reviewId: nullableString(row.review_id) ?? undefined,
    status: asString(row.status) as InterviewSkillDecisionStatus,
    selectedOptionId: nullableString(row.selected_option_id),
    resolution: jsonRecord(row.resolution_json),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    resolvedAt: nullableString(row.resolved_at),
  };
}

function toStoredSlackNotification(row: SqlRow): StoredSlackNotificationRow {
  return {
    id: asString(row.id),
    eventType: asString(row.event_type),
    candidateRef: nullableString(row.candidate_ref),
    candidateName: nullableString(row.candidate_name),
    recruitmentRef: nullableString(row.recruitment_ref),
    recruitmentName: nullableString(row.recruitment_name),
    payloadJson: asString(row.payload_json),
    processingStatus: asString(row.processing_status),
  };
}

function toMeetingRoomBlock(row: SqlRow): MeetingRoomBlockRow {
  return {
    id: asString(row.id),
    sourceKey: asString(row.source_key),
    roomId: asString(row.room_id),
    roomName: asString(row.room_name),
    reservedBy: asString(row.reserved_by),
    purpose: asString(row.purpose),
    date: asString(row.date),
    startTime: asString(row.start_time),
    endTime: asString(row.end_time),
    sourcePayloadHash: asString(row.source_payload_hash),
    active: Number(row.active) === 1,
    seenAt: asString(row.seen_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function toExternalConfirmedInterview(row: SqlRow): ExternalConfirmedInterviewRow {
  return {
    id: asString(row.id),
    sourceEventId: asString(row.source_event_id),
    candidateName: asString(row.candidate_name),
    recruitmentName: asString(row.recruitment_name),
    date: asString(row.date),
    startTime: asString(row.start_time),
    endTime: asString(row.end_time),
    roomName: nullableString(row.room_name),
    linkedCaseId: nullableString(row.linked_case_id),
    firstSeenAt: asString(row.first_seen_at),
    lastSeenAt: asString(row.last_seen_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function toRoomAllocation(row: SqlRow): RoomAllocationRow {
  return {
    id: asString(row.id),
    caseId: asString(row.case_id),
    roomBlockId: asString(row.room_block_id),
    interviewStepId: nullableString(row.interview_step_id),
    date: asString(row.date),
    startTime: asString(row.start_time),
    endTime: asString(row.end_time),
    sequenceIndex: Number(row.sequence_index ?? 0),
    status: asString(row.status) as RoomAllocationRow["status"],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function toCancellationExternalFollowUp(
  row: SqlRow,
): CancellationExternalFollowUpRow {
  return {
    id: asString(row.id),
    caseId: asString(row.case_id),
    followUpType: asString(
      row.follow_up_type,
    ) as CancellationExternalFollowUpType,
    status: asString(row.status) as CancellationExternalFollowUpStatus,
    resolutionNote: nullableString(row.resolution_note),
    createdAt: asString(row.created_at),
    resolvedAt: nullableString(row.resolved_at),
  };
}

export class BridgeDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    this.connection = new DatabaseSync(path, { timeout: 5_000 });
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  close(): void {
    this.connection.close();
  }

  backupTo(path: string): Promise<number> {
    return backupDatabase(this.connection, path);
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS slack_notifications (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        source_bot_id TEXT,
        event_type TEXT NOT NULL,
        title TEXT NOT NULL,
        candidate_ref TEXT,
        candidate_name TEXT,
        recruitment_ref TEXT,
        recruitment_name TEXT,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        processing_status TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT,
        UNIQUE(channel_id, message_ts)
      );

      CREATE TABLE IF NOT EXISTS interview_cases (
        id TEXT PRIMARY KEY,
        notification_id TEXT UNIQUE REFERENCES slack_notifications(id),
        candidate_ref TEXT,
        candidate_name TEXT,
        recruitment_ref TEXT,
        recruitment_name TEXT,
        status TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 60,
        proposal_dates_json TEXT NOT NULL,
        schedule_round INTEGER NOT NULL DEFAULT 1,
        last_scheduled_room_allocation_id TEXT,
        last_scheduled_date TEXT,
        last_scheduled_start_time TEXT,
        last_scheduled_end_time TEXT,
        last_internal_schedule_confirmed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS identity_mappings (
        id TEXT PRIMARY KEY,
        ninehire_user_id TEXT UNIQUE,
        slack_user_id TEXT NOT NULL,
        display_name TEXT,
        email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS case_interviewers (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES interview_cases(id),
        ninehire_user_id TEXT,
        slack_user_id TEXT,
        display_name TEXT NOT NULL,
        email TEXT,
        required INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        responded_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS case_interviewers_ninehire_unique
        ON case_interviewers(case_id, ninehire_user_id)
        WHERE ninehire_user_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS availability_slots (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES interview_cases(id),
        interviewer_id TEXT NOT NULL REFERENCES case_interviewers(id),
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        UNIQUE(case_id, interviewer_id, date, start_time, end_time)
      );

      CREATE TABLE IF NOT EXISTS message_drafts (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES interview_cases(id),
        workflow_review_id TEXT,
        channel_id TEXT NOT NULL,
        preview_text TEXT NOT NULL,
        blocks_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_at TEXT,
        sending_started_at TEXT,
        sent_at TEXT,
        slack_message_ts TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES interview_cases(id),
        interviewer_id TEXT NOT NULL REFERENCES case_interviewers(id),
        reminder_number INTEGER NOT NULL,
        due_at TEXT NOT NULL,
        sent_at TEXT,
        sending_started_at TEXT,
        UNIQUE(case_id, interviewer_id, reminder_number)
      );

      CREATE TABLE IF NOT EXISTS workflow_reviews (
        id TEXT PRIMARY KEY,
        notification_id TEXT REFERENCES slack_notifications(id),
        case_id TEXT REFERENCES interview_cases(id),
        review_type TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        resolution TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS open_notification_review_unique
        ON workflow_reviews(notification_id, review_type)
        WHERE notification_id IS NOT NULL AND status = 'OPEN';

      CREATE TABLE IF NOT EXISTS case_events (
        id TEXT PRIMARY KEY,
        case_id TEXT REFERENCES interview_cases(id),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cancellation_external_follow_ups (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES interview_cases(id),
        follow_up_type TEXT NOT NULL,
        status TEXT NOT NULL,
        resolution_note TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(case_id, follow_up_type)
      );

      CREATE INDEX IF NOT EXISTS cancellation_external_follow_ups_pending
        ON cancellation_external_follow_ups(status, created_at);

      CREATE TABLE IF NOT EXISTS sync_cursors (
        cursor_key TEXT PRIMARY KEY,
        cursor_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_runtime_health (
        worker_key TEXT PRIMARY KEY,
        last_started_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        last_successful_cycle_at TEXT,
        last_error_message TEXT,
        last_downtime_started_at TEXT,
        last_downtime_detected_at TEXT,
        worker_owner_token TEXT,
        lease_expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS integration_retry_jobs (
        id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS integration_retry_jobs_pending_unique
        ON integration_retry_jobs(job_type, dedupe_key)
        WHERE status = 'PENDING';

      CREATE INDEX IF NOT EXISTS integration_retry_jobs_due
        ON integration_retry_jobs(status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS meeting_room_blocks (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL,
        room_name TEXT NOT NULL,
        reserved_by TEXT NOT NULL,
        purpose TEXT NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        source_payload_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS meeting_room_blocks_active_date
        ON meeting_room_blocks(active, date, start_time, end_time);

      CREATE TABLE IF NOT EXISTS meeting_room_sync_dates (
        date TEXT PRIMARY KEY,
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS external_confirmed_interviews (
        id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL UNIQUE,
        candidate_name TEXT NOT NULL,
        recruitment_name TEXT NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        room_name TEXT,
        linked_case_id TEXT REFERENCES interview_cases(id),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS external_confirmed_interviews_schedule
        ON external_confirmed_interviews(date, start_time, end_time);

      CREATE TABLE IF NOT EXISTS room_allocations (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES interview_cases(id),
        room_block_id TEXT NOT NULL REFERENCES meeting_room_blocks(id),
        interview_step_id TEXT,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        sequence_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS room_allocations_active_block
        ON room_allocations(room_block_id, status, date, start_time, end_time);

      CREATE TABLE IF NOT EXISTS recruitment_interview_templates (
        recruitment_id TEXT PRIMARY KEY,
        recruitment_name TEXT NOT NULL,
        pipeline_hash TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        routes_json TEXT NOT NULL DEFAULT '[]',
        approved_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recruitment_slack_channels (
        recruitment_id TEXT PRIMARY KEY,
        recruitment_name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS case_interview_plans (
        case_id TEXT PRIMARY KEY REFERENCES interview_cases(id),
        source TEXT NOT NULL,
        mode TEXT NOT NULL,
        step_ids_json TEXT NOT NULL,
        step_names_json TEXT NOT NULL,
        interviewer_ids_json TEXT NOT NULL,
        sessions_json TEXT NOT NULL DEFAULT '[]',
        duration_minutes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (1, datetime('now'));
    `);

    const versionTwo = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 2")
      .get() as SqlRow | undefined;
    if (!versionTwo) {
      this.connection.exec(
        "ALTER TABLE workflow_reviews ADD COLUMN summary_json TEXT",
      );
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'))",
        )
        .run();
    }

    const versionThree = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 3")
      .get() as SqlRow | undefined;
    if (!versionThree) {
      this.connection.exec(`
        ALTER TABLE interview_cases
          ADD COLUMN scheduled_room_allocation_id TEXT;
        ALTER TABLE interview_cases ADD COLUMN scheduled_date TEXT;
        ALTER TABLE interview_cases ADD COLUMN scheduled_start_time TEXT;
        ALTER TABLE interview_cases ADD COLUMN scheduled_end_time TEXT;
        ALTER TABLE interview_cases
          ADD COLUMN internal_schedule_confirmed_at TEXT;
        ALTER TABLE message_drafts
          ADD COLUMN message_type TEXT NOT NULL DEFAULT 'INTERVIEWER_REQUEST';
      `);
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'))",
        )
        .run();
    }

    const versionFour = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 4")
      .get() as SqlRow | undefined;
    if (!versionFour) {
      const columns = this.connection
        .prepare("PRAGMA table_info(interview_cases)")
        .all() as SqlRow[];
      const hasScheduleRound = columns.some(
        (column) => asString(column.name) === "schedule_round",
      );
      if (!hasScheduleRound) {
        this.connection.exec(
          "ALTER TABLE interview_cases ADD COLUMN schedule_round INTEGER NOT NULL DEFAULT 1",
        );
      }
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (4, datetime('now'))",
        )
        .run();
    }

    const versionFive = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 5")
      .get() as SqlRow | undefined;
    if (!versionFive) {
      const columns = this.connection
        .prepare("PRAGMA table_info(interview_cases)")
        .all() as SqlRow[];
      const existingColumns = new Set(columns.map((column) => asString(column.name)));
      const additions = [
        ["last_scheduled_room_allocation_id", "TEXT"],
        ["last_scheduled_date", "TEXT"],
        ["last_scheduled_start_time", "TEXT"],
        ["last_scheduled_end_time", "TEXT"],
        ["last_internal_schedule_confirmed_at", "TEXT"],
      ] as const;
      for (const [name, definition] of additions) {
        if (!existingColumns.has(name)) {
          this.connection.exec(`ALTER TABLE interview_cases ADD COLUMN ${name} ${definition}`);
        }
      }
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (5, datetime('now'))",
        )
        .run();
    }

    const versionSix = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 6")
      .get() as SqlRow | undefined;
    if (!versionSix) {
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS cancellation_external_follow_ups (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL REFERENCES interview_cases(id),
          follow_up_type TEXT NOT NULL,
          status TEXT NOT NULL,
          resolution_note TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          UNIQUE(case_id, follow_up_type)
        );
        CREATE INDEX IF NOT EXISTS cancellation_external_follow_ups_pending
          ON cancellation_external_follow_ups(status, created_at);
      `);
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (6, datetime('now'))",
        )
        .run();
    }

    const versionSeven = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 7")
      .get() as SqlRow | undefined;
    if (!versionSeven) {
      this.connection
        .prepare(`
          UPDATE cancellation_external_follow_ups
          SET status = 'NOT_REQUIRED',
              resolution_note = COALESCE(
                resolution_note,
                '다우오피스 회의실 예약은 인터뷰 취소 후에도 유지합니다.'
              ),
              resolved_at = COALESCE(resolved_at, datetime('now'))
          WHERE follow_up_type = 'DAOU_ROOM_RESERVATION' AND status = 'PENDING'
        `)
        .run();
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (7, datetime('now'))",
        )
        .run();
    }

    const versionEight = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 8")
      .get() as SqlRow | undefined;
    if (!versionEight) {
      const draftColumns = this.connection
        .prepare("PRAGMA table_info(message_drafts)")
        .all() as SqlRow[];
      const hasWorkflowReviewId = draftColumns.some(
        (column) => asString(column.name) === "workflow_review_id",
      );
      if (!hasWorkflowReviewId) {
        this.connection.exec(
          "ALTER TABLE message_drafts ADD COLUMN workflow_review_id TEXT",
        );
      }
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS worker_runtime_health (
          worker_key TEXT PRIMARY KEY,
          last_started_at TEXT NOT NULL,
          last_heartbeat_at TEXT NOT NULL,
          last_successful_cycle_at TEXT,
          last_error_message TEXT,
          last_downtime_started_at TEXT,
          last_downtime_detected_at TEXT
        );
      `);
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (8, datetime('now'))",
        )
        .run();
    }

    const versionNine = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 9")
      .get() as SqlRow | undefined;
    if (!versionNine) {
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS integration_retry_jobs (
          id TEXT PRIMARY KEY,
          job_type TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL,
          next_attempt_at TEXT NOT NULL,
          last_error TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS integration_retry_jobs_pending_unique
          ON integration_retry_jobs(job_type, dedupe_key)
          WHERE status = 'PENDING';
        CREATE INDEX IF NOT EXISTS integration_retry_jobs_due
          ON integration_retry_jobs(status, next_attempt_at);
      `);
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (9, datetime('now'))",
        )
        .run();
    }

    const versionTen = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 10")
      .get() as SqlRow | undefined;
    if (!versionTen) {
      const columns = this.connection
        .prepare("PRAGMA table_info(interview_cases)")
        .all() as SqlRow[];
      const existingColumns = new Set(columns.map((column) => asString(column.name)));
      const additions = [
        ["scheduled_room_name", "TEXT"],
        ["last_scheduled_room_name", "TEXT"],
      ] as const;
      for (const [name, definition] of additions) {
        if (!existingColumns.has(name)) {
          this.connection.exec(`ALTER TABLE interview_cases ADD COLUMN ${name} ${definition}`);
        }
      }
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (10, datetime('now'))",
        )
        .run();
    }

    const versionEleven = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 11")
      .get() as SqlRow | undefined;
    if (!versionEleven) {
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS recruitment_interview_templates (
          recruitment_id TEXT PRIMARY KEY,
          recruitment_name TEXT NOT NULL,
          pipeline_hash TEXT NOT NULL,
          steps_json TEXT NOT NULL,
          approved_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS case_interview_plans (
          case_id TEXT PRIMARY KEY REFERENCES interview_cases(id),
          source TEXT NOT NULL,
          mode TEXT NOT NULL,
          step_ids_json TEXT NOT NULL,
          step_names_json TEXT NOT NULL,
          interviewer_ids_json TEXT NOT NULL,
          duration_minutes INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (11, datetime('now'))",
        )
        .run();
    }

    const versionTwelve = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 12")
      .get() as SqlRow | undefined;
    if (!versionTwelve) {
      const allocationColumns = this.connection
        .prepare("PRAGMA table_info(room_allocations)")
        .all() as SqlRow[];
      if (!allocationColumns.some((column) => asString(column.name) === "sequence_index")) {
        this.connection.exec(
          "ALTER TABLE room_allocations ADD COLUMN sequence_index INTEGER NOT NULL DEFAULT 0",
        );
      }
      const planColumns = this.connection
        .prepare("PRAGMA table_info(case_interview_plans)")
        .all() as SqlRow[];
      if (!planColumns.some((column) => asString(column.name) === "sessions_json")) {
        this.connection.exec(
          "ALTER TABLE case_interview_plans ADD COLUMN sessions_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (12, datetime('now'))",
        )
        .run();
    }

    const versionThirteen = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 13")
      .get() as SqlRow | undefined;
    if (!versionThirteen) {
      const allocationColumns = this.connection
        .prepare("PRAGMA table_info(room_allocations)")
        .all() as SqlRow[];
      if (!allocationColumns.some((column) => asString(column.name) === "interview_step_id")) {
        this.connection.exec(
          "ALTER TABLE room_allocations ADD COLUMN interview_step_id TEXT",
        );
      }
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (13, datetime('now'))",
        )
        .run();
    }

    const versionFourteen = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 14")
      .get() as SqlRow | undefined;
    if (!versionFourteen) {
      const templateColumns = this.connection
        .prepare("PRAGMA table_info(recruitment_interview_templates)")
        .all() as SqlRow[];
      if (!templateColumns.some((column) => asString(column.name) === "routes_json")) {
        this.connection.exec(
          "ALTER TABLE recruitment_interview_templates ADD COLUMN routes_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (14, datetime('now'))",
        )
        .run();
    }

    const versionFifteen = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 15")
      .get() as SqlRow | undefined;
    if (!versionFifteen) {
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS interview_skill_decisions (
          id TEXT PRIMARY KEY,
          skill_key TEXT NOT NULL,
          decision_type TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          case_id TEXT REFERENCES interview_cases(id),
          review_id TEXT REFERENCES workflow_reviews(id),
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          selection_mode TEXT NOT NULL,
          options_json TEXT NOT NULL,
          context_json TEXT NOT NULL,
          status TEXT NOT NULL,
          selected_option_id TEXT,
          resolution_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS interview_skill_decisions_pending_unique
          ON interview_skill_decisions(skill_key, fingerprint)
          WHERE status = 'PENDING';
        CREATE INDEX IF NOT EXISTS interview_skill_decisions_status
          ON interview_skill_decisions(status, created_at);
      `);
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (15, datetime('now'))",
        )
        .run();
    }

    const versionSixteen = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 16")
      .get() as SqlRow | undefined;
    if (!versionSixteen) {
      const draftColumns = this.connection
        .prepare("PRAGMA table_info(message_drafts)")
        .all() as SqlRow[];
      if (!draftColumns.some((column) => asString(column.name) === "sending_started_at")) {
        this.connection.exec(
          "ALTER TABLE message_drafts ADD COLUMN sending_started_at TEXT",
        );
      }
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (16, datetime('now'))",
        )
        .run();
    }

    const versionSeventeen = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 17")
      .get() as SqlRow | undefined;
    if (!versionSeventeen) {
      const workerColumns = this.connection
        .prepare("PRAGMA table_info(worker_runtime_health)")
        .all() as SqlRow[];
      const existingColumns = new Set(workerColumns.map((column) => asString(column.name)));
      if (!existingColumns.has("worker_owner_token")) {
        this.connection.exec(
          "ALTER TABLE worker_runtime_health ADD COLUMN worker_owner_token TEXT",
        );
      }
      if (!existingColumns.has("lease_expires_at")) {
        this.connection.exec(
          "ALTER TABLE worker_runtime_health ADD COLUMN lease_expires_at TEXT",
        );
      }
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (17, datetime('now'))",
        )
        .run();
    }

    const versionEighteen = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 18")
      .get() as SqlRow | undefined;
    if (!versionEighteen) {
      const reminderColumns = this.connection
        .prepare("PRAGMA table_info(reminders)")
        .all() as SqlRow[];
      if (!reminderColumns.some((column) => asString(column.name) === "sending_started_at")) {
        this.connection.exec("ALTER TABLE reminders ADD COLUMN sending_started_at TEXT");
      }
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (18, datetime('now'))",
        )
        .run();
    }

    const versionNineteen = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 19")
      .get() as SqlRow | undefined;
    if (!versionNineteen) {
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS external_confirmed_interviews (
          id TEXT PRIMARY KEY,
          source_event_id TEXT NOT NULL UNIQUE,
          candidate_name TEXT NOT NULL,
          recruitment_name TEXT NOT NULL,
          date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          room_name TEXT,
          linked_case_id TEXT REFERENCES interview_cases(id),
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS external_confirmed_interviews_schedule
          ON external_confirmed_interviews(date, start_time, end_time);
      `);
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (19, datetime('now'))",
        )
        .run();
    }

    const versionTwenty = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 20")
      .get() as SqlRow | undefined;
    if (!versionTwenty) {
      const columns = this.connection
        .prepare("PRAGMA table_info(external_confirmed_interviews)")
        .all() as SqlRow[];
      if (!columns.some((column) => asString(column.name) === "room_name")) {
        this.connection.exec("ALTER TABLE external_confirmed_interviews ADD COLUMN room_name TEXT");
      }
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (20, datetime('now'))",
        )
        .run();
    }

    const versionTwentyOne = this.connection
      .prepare("SELECT version FROM schema_migrations WHERE version = 21")
      .get() as SqlRow | undefined;
    if (!versionTwentyOne) {
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS recruitment_slack_channels (
          recruitment_id TEXT PRIMARY KEY,
          recruitment_name TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this.connection
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (21, datetime('now'))",
        )
        .run();
    }
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  getStatus(): Record<string, unknown> {
    const scalar = (sql: string): number =>
      Number((this.connection.prepare(sql).get() as SqlRow)["count"]);
    return {
      notifications: scalar("SELECT COUNT(*) AS count FROM slack_notifications"),
      openReviews: scalar(
        "SELECT COUNT(*) AS count FROM workflow_reviews WHERE status = 'OPEN'",
      ),
      activeCases: scalar(
        "SELECT COUNT(*) AS count FROM interview_cases WHERE status NOT IN ('CLOSED', 'CANCELLED')",
      ),
      pendingDrafts: scalar(
        "SELECT COUNT(*) AS count FROM message_drafts WHERE status = 'DRAFT'",
      ),
      pendingInterviewers: scalar(
        "SELECT COUNT(*) AS count FROM case_interviewers WHERE active = 1 AND status = 'PENDING'",
      ),
      activeMeetingRoomBlocks: scalar(
        "SELECT COUNT(*) AS count FROM meeting_room_blocks WHERE active = 1",
      ),
      activeRoomAllocations: scalar(
        "SELECT COUNT(*) AS count FROM room_allocations WHERE status = 'ACTIVE'",
      ),
      pendingCancellationExternalFollowUps: scalar(
        "SELECT COUNT(*) AS count FROM cancellation_external_follow_ups WHERE status = 'PENDING'",
      ),
      pendingIntegrationRetries: scalar(
        "SELECT COUNT(*) AS count FROM integration_retry_jobs WHERE status = 'PENDING'",
      ),
      pendingSkillDecisions: scalar(
        "SELECT COUNT(*) AS count FROM interview_skill_decisions WHERE status = 'PENDING'",
      ),
      failedIntegrationRetries: scalar(
        "SELECT COUNT(*) AS count FROM integration_retry_jobs WHERE status = 'FAILED'",
      ),
      externalConfirmedInterviews: scalar(
        "SELECT COUNT(*) AS count FROM external_confirmed_interviews",
      ),
    };
  }

  clearOperationalData(): OperationalDataResetResult {
    return this.transaction(() => {
      const tables = [
        ["외부 확정 인터뷰", "external_confirmed_interviews"],
        ["인터뷰 결정", "interview_skill_decisions"],
        ["회의실 배정", "room_allocations"],
        ["면접관 가능 일정", "availability_slots"],
        ["면접관 리마인드", "reminders"],
        ["Slack 메시지 초안", "message_drafts"],
        ["취소 후속 작업", "cancellation_external_follow_ups"],
        ["후보자별 인터뷰 계획", "case_interview_plans"],
        ["후보자 업무 이력", "case_events"],
        ["검토 대기", "workflow_reviews"],
        ["후보자별 면접관", "case_interviewers"],
        ["인터뷰 조율 건", "interview_cases"],
        ["Slack 원본 알림", "slack_notifications"],
        ["연동 재시도 작업", "integration_retry_jobs"],
        ["회의실 예약 블록", "meeting_room_blocks"],
        ["회의실 동기화 일자", "meeting_room_sync_dates"],
      ] as const;
      const deleted: Record<string, number> = {};
      for (const [label, table] of tables) {
        const result = this.connection.prepare(`DELETE FROM ${table}`).run();
        deleted[label] = Number(result.changes);
      }
      const cursorResult = this.connection
        .prepare("DELETE FROM sync_cursors WHERE cursor_key NOT LIKE 'slack:%:latest_ts'")
        .run();
      deleted["동기화 성공 시각"] = Number(cursorResult.changes);
      const retainedSlackCursorCount = Number(
        (this.connection
          .prepare("SELECT COUNT(*) AS count FROM sync_cursors WHERE cursor_key LIKE 'slack:%:latest_ts'")
          .get() as SqlRow).count,
      );
      return { deleted, retainedSlackCursorCount };
    });
  }

  getWorkerHealth(workerKey: string): WorkerHealthRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM worker_runtime_health WHERE worker_key = ?")
      .get(workerKey) as SqlRow | undefined;
    return row ? toWorkerHealth(row) : undefined;
  }

  registerWorkerStart(input: {
    workerKey: string;
    now?: Date;
    downtimeThresholdMs?: number;
  }): { health: WorkerHealthRow; downtime?: WorkerDowntime } {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const previous = this.getWorkerHealth(input.workerKey);
    const previousHeartbeatMs = previous
      ? Date.parse(previous.lastHeartbeatAt)
      : Number.NaN;
    const durationMs = Number.isNaN(previousHeartbeatMs)
      ? 0
      : now.getTime() - previousHeartbeatMs;
    const threshold =
      input.downtimeThresholdMs ?? WORKER_DOWNTIME_THRESHOLD_MS;
    const downtime =
      previous && durationMs >= threshold
        ? {
            workerKey: input.workerKey,
            startedAt: previous.lastHeartbeatAt,
            detectedAt: nowIso,
            durationMs,
          }
        : undefined;

    this.connection
      .prepare(`
        INSERT INTO worker_runtime_health(
          worker_key, last_started_at, last_heartbeat_at,
          last_successful_cycle_at, last_error_message,
          last_downtime_started_at, last_downtime_detected_at
        ) VALUES (?, ?, ?, NULL, NULL, ?, ?)
        ON CONFLICT(worker_key) DO UPDATE SET
          last_started_at = excluded.last_started_at,
          last_heartbeat_at = excluded.last_heartbeat_at,
          last_error_message = NULL,
          last_downtime_started_at = COALESCE(excluded.last_downtime_started_at, worker_runtime_health.last_downtime_started_at),
          last_downtime_detected_at = COALESCE(excluded.last_downtime_detected_at, worker_runtime_health.last_downtime_detected_at)
      `)
      .run(
        input.workerKey,
        nowIso,
        nowIso,
        downtime?.startedAt ?? null,
        downtime?.detectedAt ?? null,
      );
    return { health: this.getWorkerHealth(input.workerKey)!, downtime };
  }

  acquireWorkerLease(input: {
    workerKey: string;
    ownerToken: string;
    leaseDurationMs: number;
    now?: Date;
    downtimeThresholdMs?: number;
  }): WorkerLeaseResult {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs).toISOString();
    return this.transaction(() => {
      const previous = this.getWorkerHealth(input.workerKey);
      const previousLeaseExpiresAt = previous?.leaseExpiresAt
        ? Date.parse(previous.leaseExpiresAt)
        : Number.NaN;
      if (
        previous &&
        !Number.isNaN(previousLeaseExpiresAt) &&
        previousLeaseExpiresAt > now.getTime()
      ) {
        return { acquired: false, health: previous };
      }

      const previousHeartbeatMs = previous
        ? Date.parse(previous.lastHeartbeatAt)
        : Number.NaN;
      const downtimeThreshold =
        input.downtimeThresholdMs ?? WORKER_DOWNTIME_THRESHOLD_MS;
      const downtime =
        previous &&
        !Number.isNaN(previousHeartbeatMs) &&
        now.getTime() - previousHeartbeatMs >= downtimeThreshold
          ? {
              workerKey: input.workerKey,
              startedAt: previous.lastHeartbeatAt,
              detectedAt: nowIso,
              durationMs: now.getTime() - previousHeartbeatMs,
            }
          : undefined;

      const write = this.connection
        .prepare(`
          INSERT INTO worker_runtime_health(
            worker_key, last_started_at, last_heartbeat_at,
            last_successful_cycle_at, last_error_message,
            last_downtime_started_at, last_downtime_detected_at,
            worker_owner_token, lease_expires_at
          ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)
          ON CONFLICT(worker_key) DO UPDATE SET
            last_started_at = excluded.last_started_at,
            last_heartbeat_at = excluded.last_heartbeat_at,
            last_successful_cycle_at = COALESCE(excluded.last_successful_cycle_at, worker_runtime_health.last_successful_cycle_at),
            last_error_message = NULL,
            last_downtime_started_at = COALESCE(excluded.last_downtime_started_at, worker_runtime_health.last_downtime_started_at),
            last_downtime_detected_at = COALESCE(excluded.last_downtime_detected_at, worker_runtime_health.last_downtime_detected_at),
            worker_owner_token = excluded.worker_owner_token,
            lease_expires_at = excluded.lease_expires_at
          WHERE worker_runtime_health.lease_expires_at IS NULL
             OR worker_runtime_health.lease_expires_at <= ?
        `)
        .run(
          input.workerKey,
          nowIso,
          nowIso,
          downtime?.startedAt ?? null,
          downtime?.detectedAt ?? null,
          input.ownerToken,
          leaseExpiresAt,
          nowIso,
        );
      const health = this.getWorkerHealth(input.workerKey)!;
      return {
        acquired: write.changes === 1,
        health,
        ...(write.changes === 1 && downtime ? { downtime } : {}),
      };
    });
  }

  renewWorkerLease(input: {
    workerKey: string;
    ownerToken: string;
    leaseDurationMs: number;
    now?: Date;
  }): boolean {
    const now = input.now ?? new Date();
    const result = this.connection
      .prepare(`
        UPDATE worker_runtime_health
        SET last_heartbeat_at = ?, lease_expires_at = ?
        WHERE worker_key = ?
          AND worker_owner_token = ?
          AND lease_expires_at > ?
      `)
      .run(
        now.toISOString(),
        new Date(now.getTime() + input.leaseDurationMs).toISOString(),
        input.workerKey,
        input.ownerToken,
        now.toISOString(),
      );
    return result.changes === 1;
  }

  releaseWorkerLease(workerKey: string, ownerToken: string): void {
    const releasedAt = new Date().toISOString();
    this.connection
      .prepare(`
        UPDATE worker_runtime_health
        SET worker_owner_token = NULL, lease_expires_at = ?
        WHERE worker_key = ? AND worker_owner_token = ?
      `)
      .run(releasedAt, workerKey, ownerToken);
  }

  recordWorkerHeartbeat(
    workerKey: string,
    now = new Date(),
    ownerToken?: string,
  ): boolean {
    const result = this.connection
      .prepare(`
        UPDATE worker_runtime_health
        SET last_heartbeat_at = ?
        WHERE worker_key = ?
          AND (? IS NULL OR worker_owner_token = ?)
      `)
      .run(now.toISOString(), workerKey, ownerToken ?? null, ownerToken ?? null);
    return result.changes === 1;
  }

  recordWorkerCycleSuccess(
    workerKey: string,
    now = new Date(),
    ownerToken?: string,
  ): boolean {
    const result = this.connection
      .prepare(`
        UPDATE worker_runtime_health
        SET last_heartbeat_at = ?, last_successful_cycle_at = ?, last_error_message = NULL
        WHERE worker_key = ?
          AND (? IS NULL OR worker_owner_token = ?)
      `)
      .run(
        now.toISOString(),
        now.toISOString(),
        workerKey,
        ownerToken ?? null,
        ownerToken ?? null,
      );
    return result.changes === 1;
  }

  recordWorkerCycleFailure(
    workerKey: string,
    errorMessage: string,
    now = new Date(),
    ownerToken?: string,
  ): boolean {
    const result = this.connection
      .prepare(`
        UPDATE worker_runtime_health
        SET last_heartbeat_at = ?, last_error_message = ?
        WHERE worker_key = ?
          AND (? IS NULL OR worker_owner_token = ?)
      `)
      .run(
        now.toISOString(),
        safeErrorSummary(errorMessage),
        workerKey,
        ownerToken ?? null,
        ownerToken ?? null,
      );
    return result.changes === 1;
  }

  enqueueIntegrationRetry(input: {
    jobType: IntegrationRetryJobType;
    dedupeKey: string;
    payload: Record<string, unknown>;
    maxAttempts?: number;
    now?: Date;
  }): IntegrationRetryJobRow {
    const existing = this.connection
      .prepare(`
        SELECT * FROM integration_retry_jobs
        WHERE job_type = ? AND dedupe_key = ? AND status = 'PENDING'
        LIMIT 1
      `)
      .get(input.jobType, input.dedupeKey) as SqlRow | undefined;
    if (existing) return toIntegrationRetryJob(existing);

    const now = input.now ?? new Date();
    const maxAttempts = input.maxAttempts ?? INTEGRATION_RETRY_MAX_ATTEMPTS;
    const id = randomUUID();
    this.connection
      .prepare(`
        INSERT INTO integration_retry_jobs(
          id, job_type, dedupe_key, payload_json, attempt_count, max_attempts,
          next_attempt_at, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?, 'PENDING', ?, ?)
      `)
      .run(
        id,
        input.jobType,
        input.dedupeKey,
        JSON.stringify(input.payload),
        maxAttempts,
        new Date(now.getTime() + retryDelayMs(1)).toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
    return this.getIntegrationRetryJob(id)!;
  }

  getIntegrationRetryJob(id: string): IntegrationRetryJobRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM integration_retry_jobs WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? toIntegrationRetryJob(row) : undefined;
  }

  listIntegrationRetryJobs(input?: {
    status?: IntegrationRetryJobStatus;
    dueBefore?: Date;
    limit?: number;
  }): IntegrationRetryJobRow[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (input?.status) {
      conditions.push("status = ?");
      values.push(input.status);
    }
    if (input?.dueBefore) {
      conditions.push("next_attempt_at <= ?");
      values.push(input.dueBefore.toISOString());
    }
    values.push(input?.limit ?? 100);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.connection
      .prepare(`
        SELECT * FROM integration_retry_jobs
        ${where}
        ORDER BY
          CASE status WHEN 'FAILED' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,
          next_attempt_at ASC
        LIMIT ?
      `)
      .all(...values) as SqlRow[];
    return rows.map(toIntegrationRetryJob);
  }

  completeIntegrationRetryJob(id: string, now = new Date()): IntegrationRetryJobRow {
    this.connection
      .prepare(`
        UPDATE integration_retry_jobs
        SET status = 'COMPLETED', completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING'
      `)
      .run(now.toISOString(), now.toISOString(), id);
    const job = this.getIntegrationRetryJob(id);
    if (!job) throw new Error(`Integration retry job not found: ${id}`);
    return job;
  }

  completePendingIntegrationRetryByDedupeKey(
    jobType: IntegrationRetryJobType,
    dedupeKey: string,
    now = new Date(),
  ): void {
    this.connection
      .prepare(`
        UPDATE integration_retry_jobs
        SET status = 'COMPLETED', completed_at = ?, updated_at = ?
        WHERE job_type = ? AND dedupe_key = ? AND status = 'PENDING'
      `)
      .run(now.toISOString(), now.toISOString(), jobType, dedupeKey);
  }

  failIntegrationRetryJob(
    id: string,
    errorMessage: string,
    now = new Date(),
  ): IntegrationRetryJobRow {
    const job = this.getIntegrationRetryJob(id);
    if (!job || job.status !== "PENDING") {
      throw new Error(`Pending integration retry job not found: ${id}`);
    }
    const attemptCount = job.attemptCount + 1;
    const safeMessage = safeErrorSummary(errorMessage);
    const exhausted = attemptCount >= job.maxAttempts;
    const nextAttemptAt = new Date(
      now.getTime() + retryDelayMs(attemptCount + 1),
    ).toISOString();
    this.connection
      .prepare(`
        UPDATE integration_retry_jobs
        SET attempt_count = ?, next_attempt_at = ?, last_error = ?, status = ?,
            completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING'
      `)
      .run(
        attemptCount,
        nextAttemptAt,
        safeMessage,
        exhausted ? "FAILED" : "PENDING",
        exhausted ? now.toISOString() : null,
        now.toISOString(),
        id,
      );
    return this.getIntegrationRetryJob(id)!;
  }

  requeueIntegrationRetryJob(
    id: string,
    now = new Date(),
  ): IntegrationRetryRequeueResult {
    return this.transaction(() => {
      const job = this.getIntegrationRetryJob(id);
      if (!job) throw new Error(`Integration retry job not found: ${id}`);
      if (job.status === "COMPLETED") {
        throw new Error(`Completed integration retry job cannot be requeued: ${id}`);
      }
      if (job.status === "PENDING") return { job, queued: false };

      const existingPending = this.connection
        .prepare(`
          SELECT * FROM integration_retry_jobs
          WHERE job_type = ? AND dedupe_key = ? AND status = 'PENDING'
          LIMIT 1
        `)
        .get(job.jobType, job.dedupeKey) as SqlRow | undefined;
      if (existingPending) {
        return { job: toIntegrationRetryJob(existingPending), queued: false };
      }

      const updatedAt = now.toISOString();
      this.connection
        .prepare(`
          UPDATE integration_retry_jobs
          SET attempt_count = 0, next_attempt_at = ?, last_error = NULL,
              status = 'PENDING', updated_at = ?, completed_at = NULL
          WHERE id = ? AND status = 'FAILED'
        `)
        .run(updatedAt, updatedAt, id);
      const requeued = this.getIntegrationRetryJob(id);
      if (!requeued || requeued.status !== "PENDING") {
        throw new Error(`Integration retry job could not be requeued: ${id}`);
      }
      return { job: requeued, queued: true };
    });
  }

  insertNotification(
    input: SlackNotificationInput,
    processingStatus: string,
  ): { id: string; inserted: boolean } {
    const id = randomUUID();
    const insert = this.connection
      .prepare(`
        INSERT OR IGNORE INTO slack_notifications(
          id, channel_id, message_ts, source_bot_id, event_type, title,
          candidate_ref, candidate_name, recruitment_ref, recruitment_name,
          payload_hash, payload_json, processing_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.channelId,
        input.messageTs,
        input.sourceBotId ?? null,
        input.eventType,
        input.title,
        input.candidateRef ?? null,
        input.candidateName ?? null,
        input.recruitmentRef ?? null,
        input.recruitmentName ?? null,
        input.payloadHash,
        input.payloadJson,
        processingStatus,
        new Date().toISOString(),
      );
    if (Number(insert.changes) === 1) return { id, inserted: true };
    const existing = this.connection
      .prepare(
        "SELECT id FROM slack_notifications WHERE channel_id = ? AND message_ts = ?",
      )
      .get(input.channelId, input.messageTs) as SqlRow | undefined;
    if (!existing) {
      throw new Error("Slack notification was ignored but cannot be found.");
    }
    return { id: asString(existing.id), inserted: false };
  }

  getNotification(id: string): SqlRow | undefined {
    return this.connection
      .prepare("SELECT * FROM slack_notifications WHERE id = ?")
      .get(id) as SqlRow | undefined;
  }

  updateNotificationStatus(
    id: string,
    status: string,
    errorMessage?: string,
  ): void {
    this.connection
      .prepare(`
        UPDATE slack_notifications
        SET processing_status = ?, error_message = ?, processed_at = ?
        WHERE id = ?
      `)
      .run(status, errorMessage ?? null, new Date().toISOString(), id);
  }

  updateNotificationEventType(id: string, eventType: string): void {
    this.connection
      .prepare("UPDATE slack_notifications SET event_type = ? WHERE id = ?")
      .run(eventType, id);
  }

  listIgnoredScheduleConfirmationNotifications(): StoredSlackNotificationRow[] {
    const rows = this.connection
      .prepare(`
        SELECT * FROM slack_notifications
        WHERE event_type = 'OTHER'
          AND processing_status = 'IGNORED'
          AND payload_json LIKE '%일정이 확정되었습니다%'
        ORDER BY created_at ASC
      `)
      .all() as SqlRow[];
    return rows.map(toStoredSlackNotification);
  }

  listIgnoredCandidateInterviewAbsenceNotifications(): StoredSlackNotificationRow[] {
    const rows = this.connection
      .prepare(`
        SELECT * FROM slack_notifications
        WHERE event_type = 'CANDIDATE_MESSAGE'
          AND processing_status = 'IGNORED'
          AND payload_json LIKE '%일정에 불참합니다%'
        ORDER BY created_at ASC
      `)
      .all() as SqlRow[];
    return rows.map(toStoredSlackNotification);
  }

  createReview(input: {
    notificationId?: string;
    caseId?: string;
    reviewType: string;
    reason: string;
    summary?: Record<string, unknown>;
  }): string {
    if (input.caseId && !input.notificationId) {
      const existing = this.getOpenCaseReviewId(input.caseId, input.reviewType);
      if (existing) return existing;
    }
    const id = randomUUID();
    const insert = this.connection
      .prepare(`
        INSERT OR IGNORE INTO workflow_reviews(
          id, notification_id, case_id, review_type, reason, summary_json,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)
      `)
      .run(
        id,
        input.notificationId ?? null,
        input.caseId ?? null,
        input.reviewType,
        input.reason,
        input.summary ? JSON.stringify(input.summary) : null,
        new Date().toISOString(),
      );
    if (Number(insert.changes) === 0) {
      if (input.notificationId) {
        const existing = this.connection
          .prepare(`
            SELECT id FROM workflow_reviews
            WHERE notification_id = ? AND review_type = ? AND status = 'OPEN'
          `)
          .get(input.notificationId, input.reviewType) as SqlRow | undefined;
        if (existing) return asString(existing.id);
      }
      throw new Error("Workflow review could not be inserted.");
    }
    return id;
  }

  listOpenReviews(limit = 100): ReviewRow[] {
    return (
      this.connection
        .prepare(`
          SELECT * FROM workflow_reviews
          WHERE status = 'OPEN'
          ORDER BY created_at ASC
          LIMIT ?
        `)
        .all(limit) as SqlRow[]
    ).map(toReview);
  }

  listHeldReviews(limit = 100): ReviewRow[] {
    return (
      this.connection
        .prepare(`
          SELECT * FROM workflow_reviews
          WHERE status = 'RESOLVED' AND resolution = 'HOLD'
          ORDER BY resolved_at DESC, created_at DESC
          LIMIT ?
        `)
        .all(limit) as SqlRow[]
    ).map(toReview);
  }

  getReview(id: string): ReviewRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM workflow_reviews WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? toReview(row) : undefined;
  }

  hasCaseReview(caseId: string, reviewType: string): boolean {
    const row = this.connection
      .prepare(
        "SELECT id FROM workflow_reviews WHERE case_id = ? AND review_type = ? AND status = 'OPEN' LIMIT 1",
      )
      .get(caseId, reviewType) as SqlRow | undefined;
    return Boolean(row);
  }

  getOpenCaseReviewId(caseId: string, reviewType: string): string | undefined {
    const row = this.connection
      .prepare(
        "SELECT id FROM workflow_reviews WHERE case_id = ? AND review_type = ? AND status = 'OPEN' ORDER BY created_at ASC LIMIT 1",
      )
      .get(caseId, reviewType) as SqlRow | undefined;
    return row ? asString(row.id) : undefined;
  }

  hasOpenReviewForSourceEvent(reviewType: string, eventId: string): boolean {
    const row = this.connection
      .prepare(`
        SELECT id FROM workflow_reviews
        WHERE review_type = ? AND status = 'OPEN'
          AND summary_json LIKE ?
        LIMIT 1
      `)
      .get(reviewType, `%\"eventId\":\"${eventId}\"%`) as SqlRow | undefined;
    return Boolean(row);
  }

  resolveReview(id: string, resolution: string): void {
    const result = this.connection
      .prepare(`
        UPDATE workflow_reviews
        SET status = 'RESOLVED', resolution = ?, resolved_at = ?
        WHERE id = ? AND status = 'OPEN'
      `)
      .run(resolution, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) {
      throw new Error(`Open review not found: ${id}`);
    }
  }

  reopenHeldReview(id: string): ReviewRow {
    const result = this.connection
      .prepare(`
        UPDATE workflow_reviews
        SET status = 'OPEN', resolution = NULL, resolved_at = NULL
        WHERE id = ? AND status = 'RESOLVED' AND resolution = 'HOLD'
      `)
      .run(id);
    if (Number(result.changes) !== 1) {
      throw new Error(`Held review not found: ${id}`);
    }
    return this.getReview(id)!;
  }

  createOrGetPendingInterviewSkillDecision(
    input: InterviewSkillDecisionInput,
  ): InterviewSkillDecisionRow {
    if (input.options.length === 0) {
      throw new Error("An interview skill decision needs at least one option.");
    }
    if (new Set(input.options.map((option) => option.id)).size !== input.options.length) {
      throw new Error("Interview skill decision option IDs must be unique.");
    }
    const existing = this.connection
      .prepare(`
        SELECT * FROM interview_skill_decisions
        WHERE skill_key = ? AND fingerprint = ? AND status = 'PENDING'
      `)
      .get(input.skillKey, input.fingerprint) as SqlRow | undefined;
    if (existing) return toInterviewSkillDecision(existing);

    const id = randomUUID();
    const now = new Date().toISOString();
    this.connection
      .prepare(`
        INSERT INTO interview_skill_decisions(
          id, skill_key, decision_type, fingerprint, case_id, review_id,
          title, prompt, selection_mode, options_json, context_json,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
      `)
      .run(
        id,
        input.skillKey,
        input.decisionType,
        input.fingerprint,
        input.caseId ?? null,
        input.reviewId ?? null,
        input.title,
        input.prompt,
        input.selectionMode,
        JSON.stringify(input.options),
        JSON.stringify(input.context),
        now,
        now,
      );
    return this.getInterviewSkillDecision(id)!;
  }

  getInterviewSkillDecision(id: string): InterviewSkillDecisionRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM interview_skill_decisions WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? toInterviewSkillDecision(row) : undefined;
  }

  discardPendingInterviewSkillDecision(id: string): boolean {
    const result = this.connection
      .prepare("DELETE FROM interview_skill_decisions WHERE id = ? AND status = 'PENDING'")
      .run(id);
    return Number(result.changes) === 1;
  }

  listInterviewSkillDecisions(input: {
    status?: InterviewSkillDecisionStatus;
    limit?: number;
  } = {}): InterviewSkillDecisionRow[] {
    const limit = input.limit ?? 100;
    const rows = input.status
      ? (this.connection
          .prepare(`
            SELECT * FROM interview_skill_decisions
            WHERE status = ?
            ORDER BY created_at ASC
            LIMIT ?
          `)
          .all(input.status, limit) as SqlRow[])
      : (this.connection
          .prepare(`
            SELECT * FROM interview_skill_decisions
            ORDER BY created_at ASC
            LIMIT ?
          `)
          .all(limit) as SqlRow[]);
    return rows.map(toInterviewSkillDecision);
  }

  resolveInterviewSkillDecision(input: {
    decisionId: string;
    optionId: string;
    resolution?: Record<string, unknown>;
  }): InterviewSkillDecisionRow {
    const decision = this.getInterviewSkillDecision(input.decisionId);
    if (!decision || decision.status !== "PENDING") {
      throw new Error(`Pending interview skill decision not found: ${input.decisionId}`);
    }
    if (!decision.options.some((option) => option.id === input.optionId)) {
      throw new Error(`Invalid interview skill decision option: ${input.optionId}`);
    }
    const now = new Date().toISOString();
    this.connection
      .prepare(`
        UPDATE interview_skill_decisions
        SET status = 'RESOLVED', selected_option_id = ?, resolution_json = ?,
            updated_at = ?, resolved_at = ?
        WHERE id = ? AND status = 'PENDING'
      `)
      .run(
        input.optionId,
        input.resolution ? JSON.stringify(input.resolution) : null,
        now,
        now,
        input.decisionId,
      );
    return this.getInterviewSkillDecision(input.decisionId)!;
  }

  reopenResolvedInterviewSkillDecision(id: string, reason: string): InterviewSkillDecisionRow {
    const decision = this.getInterviewSkillDecision(id);
    if (!decision) throw new Error(`Interview skill decision not found: ${id}`);
    if (decision.status === "PENDING") return decision;
    const now = new Date().toISOString();
    this.connection
      .prepare(`
        UPDATE interview_skill_decisions
        SET status = 'PENDING', selected_option_id = NULL, resolution_json = NULL,
            updated_at = ?, resolved_at = NULL
        WHERE id = ? AND status = 'RESOLVED'
      `)
      .run(now, id);
    if (decision.caseId) {
      this.addEvent(decision.caseId, "INTERVIEW_SKILL_DECISION_REOPENED", "SYSTEM", {
        decisionId: id,
        reason: safeErrorSummary(reason),
      });
    }
    return this.getInterviewSkillDecision(id)!;
  }

  createInterviewCase(input: {
    notificationId?: string;
    candidateRef?: string;
    candidateName?: string;
    recruitmentRef?: string;
    recruitmentName?: string;
    durationMinutes?: number;
    proposalDates: string[];
  }): InterviewCaseRow {
    if (input.proposalDates.length === 0 || input.proposalDates.some((date) => !isDate(date))) {
      throw new Error("At least one YYYY-MM-DD proposal date is required.");
    }
    if (
      input.durationMinutes !== undefined &&
      (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0)
    ) {
      throw new Error("durationMinutes must be a positive integer.");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const insert = this.connection
      .prepare(`
        INSERT OR IGNORE INTO interview_cases(
          id, notification_id, candidate_ref, candidate_name,
          recruitment_ref, recruitment_name, status, duration_minutes,
          proposal_dates_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'READY_FOR_DRAFT', ?, ?, ?, ?)
      `)
      .run(
        id,
        input.notificationId ?? null,
        input.candidateRef ?? null,
        input.candidateName ?? null,
        input.recruitmentRef ?? null,
        input.recruitmentName ?? null,
        input.durationMinutes ?? 60,
        JSON.stringify([...new Set(input.proposalDates)].sort()),
        now,
        now,
      );
    if (Number(insert.changes) === 0 && input.notificationId) {
      const existing = this.connection
        .prepare("SELECT * FROM interview_cases WHERE notification_id = ?")
        .get(input.notificationId) as SqlRow | undefined;
      if (existing) return toCase(existing);
      throw new Error("Interview case was ignored but cannot be found.");
    }
    this.addEvent(id, "CASE_CREATED", "SYSTEM", {
      notificationId: input.notificationId,
    });
    return this.getCase(id)!;
  }

  listCases(status?: InterviewCaseStatus, limit = 100): InterviewCaseRow[] {
    const rows = status
      ? (this.connection
          .prepare(`
            SELECT * FROM interview_cases WHERE status = ?
            ORDER BY created_at DESC LIMIT ?
          `)
          .all(status, limit) as SqlRow[])
      : (this.connection
          .prepare(`
            SELECT * FROM interview_cases
            ORDER BY created_at DESC LIMIT ?
          `)
          .all(limit) as SqlRow[]);
    return rows.map(toCase);
  }

  listOperationalCases(limit = 100): InterviewCaseRow[] {
    const rows = this.connection
      .prepare(`
        SELECT * FROM interview_cases AS interview_case
        WHERE ${this.operationalCasePredicate("interview_case")}
        ORDER BY created_at DESC LIMIT ?
      `)
      .all(limit) as SqlRow[];
    return rows.map(toCase);
  }

  private operationalCasePredicate(tableAlias: string): string {
    return `
      ${tableAlias}.status != 'CLOSED'
      AND ${tableAlias}.status != 'ON_HOLD'
      AND (
        ${tableAlias}.status != 'CANCELLED'
        OR EXISTS (
          SELECT 1 FROM cancellation_external_follow_ups AS follow_up
          WHERE follow_up.case_id = ${tableAlias}.id
            AND follow_up.follow_up_type = 'NINEHIRE_CANDIDATE_SCHEDULE'
            AND follow_up.status = 'PENDING'
        )
      )
    `;
  }

  listCasesWithPendingRequiredInterviewers(): InterviewCaseRow[] {
    const rows = this.connection
      .prepare(`
        SELECT DISTINCT interview_case.*
        FROM interview_cases AS interview_case
        JOIN case_interviewers AS interviewer ON interviewer.case_id = interview_case.id
        WHERE interview_case.status = 'COLLECTING_AVAILABILITY'
          AND interviewer.active = 1
          AND interviewer.required = 1
          AND interviewer.status = 'PENDING'
        ORDER BY interview_case.updated_at ASC
      `)
      .all() as SqlRow[];
    return rows.map(toCase);
  }

  listCancellationExternalFollowUps(input?: {
    caseId?: string;
    status?: CancellationExternalFollowUpStatus;
    limit?: number;
    includeDaouOffice?: boolean;
  }): CancellationExternalFollowUpRow[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (input?.caseId) {
      conditions.push("case_id = ?");
      values.push(input.caseId);
    }
    if (input?.status) {
      conditions.push("status = ?");
      values.push(input.status);
    }
    if (!input?.includeDaouOffice) {
      conditions.push("follow_up_type = 'NINEHIRE_CANDIDATE_SCHEDULE'");
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(input?.limit ?? 100);
    const rows = this.connection
      .prepare(`
        SELECT * FROM cancellation_external_follow_ups
        ${where}
        ORDER BY
          CASE status WHEN 'PENDING' THEN 0 ELSE 1 END,
          CASE follow_up_type
            WHEN 'NINEHIRE_CANDIDATE_SCHEDULE' THEN 0
            ELSE 1
          END,
          created_at ASC
        LIMIT ?
      `)
      .all(...values) as SqlRow[];
    return rows.map(toCancellationExternalFollowUp);
  }

  createCancellationExternalFollowUps(
    caseId: string,
  ): CancellationExternalFollowUpRow[] {
    const interviewCase = this.getCase(caseId);
    if (!interviewCase || interviewCase.status !== "CANCELLED") {
      throw new Error(`Cancelled interview case not found: ${caseId}`);
    }
    const types: CancellationExternalFollowUpType[] = [
      "NINEHIRE_CANDIDATE_SCHEDULE",
    ];
    let created = 0;
    this.transaction(() => {
      const insert = this.connection.prepare(`
        INSERT OR IGNORE INTO cancellation_external_follow_ups(
          id, case_id, follow_up_type, status, created_at
        ) VALUES (?, ?, ?, 'PENDING', ?)
      `);
      const createdAt = new Date().toISOString();
      for (const followUpType of types) {
        const result = insert.run(randomUUID(), caseId, followUpType, createdAt);
        created += Number(result.changes);
      }
      if (created > 0) {
        this.addEvent(caseId, "CANCELLATION_EXTERNAL_FOLLOW_UPS_CREATED", "SYSTEM", {
          created,
        });
      }
    });
    return this.listCancellationExternalFollowUps({ caseId });
  }

  backfillCancellationExternalFollowUps(): {
    cancelledCases: number;
    followUpsCreated: number;
  } {
    const rows = this.connection
      .prepare("SELECT id FROM interview_cases WHERE status = 'CANCELLED'")
      .all() as SqlRow[];
    let followUpsCreated = 0;
    for (const row of rows) {
      const caseId = asString(row.id);
      const before = this.listCancellationExternalFollowUps({ caseId }).length;
      this.createCancellationExternalFollowUps(caseId);
      followUpsCreated +=
        this.listCancellationExternalFollowUps({ caseId }).length - before;
    }
    return { cancelledCases: rows.length, followUpsCreated };
  }

  resolveCancellationExternalFollowUp(input: {
    followUpId: string;
    status: Exclude<CancellationExternalFollowUpStatus, "PENDING">;
    resolutionNote?: string;
  }): CancellationExternalFollowUpRow {
    const current = this.connection
      .prepare("SELECT * FROM cancellation_external_follow_ups WHERE id = ?")
      .get(input.followUpId) as SqlRow | undefined;
    if (!current) {
      throw new Error(`Cancellation external follow-up not found: ${input.followUpId}`);
    }
    const followUp = toCancellationExternalFollowUp(current);
    if (followUp.status === input.status) return followUp;
    if (followUp.status !== "PENDING") {
      throw new Error(`Cancellation external follow-up is already resolved: ${input.followUpId}`);
    }
    this.transaction(() => {
      this.connection
        .prepare(`
          UPDATE cancellation_external_follow_ups
          SET status = ?, resolution_note = ?, resolved_at = ?
          WHERE id = ? AND status = 'PENDING'
        `)
        .run(
          input.status,
          input.resolutionNote?.trim() || null,
          new Date().toISOString(),
          input.followUpId,
        );
      this.addEvent(
        followUp.caseId,
        "CANCELLATION_EXTERNAL_FOLLOW_UP_RESOLVED",
        "USER",
        {
          followUpId: followUp.id,
          followUpType: followUp.followUpType,
          status: input.status,
        },
      );
    });
    return this.listCancellationExternalFollowUps({
      caseId: followUp.caseId,
      includeDaouOffice: true,
    }).find((item) => item.id === input.followUpId)!;
  }

  getOperationsDashboard(limit = 100): Record<string, unknown> {
    const statusCounts: Record<InterviewCaseStatus, number> = {
      READY_FOR_DRAFT: 0,
      DRAFT_CREATED: 0,
      REQUEST_SENT: 0,
      COLLECTING_AVAILABILITY: 0,
      READY_TO_SCHEDULE: 0,
      AWAITING_CANDIDATE_CONFIRMATION: 0,
      CONFIRMED: 0,
      CANCELLED: 0,
      REVIEW_REQUIRED: 0,
      ON_HOLD: 0,
      CLOSED: 0,
    };
    const countRows = this.connection
      .prepare(`
        SELECT status, COUNT(*) AS count
        FROM interview_cases AS interview_case
        WHERE ${this.operationalCasePredicate("interview_case")}
        GROUP BY status
      `)
      .all() as SqlRow[];
    for (const row of countRows) {
      const status = asString(row.status) as InterviewCaseStatus;
      statusCounts[status] = Number(row.count);
    }
    const scalar = (sql: string): number =>
      Number((this.connection.prepare(sql).get() as SqlRow).count);
    statusCounts.ON_HOLD = scalar(
      "SELECT COUNT(*) AS count FROM interview_cases WHERE status = 'ON_HOLD'",
    );
    const cases = this.listOperationalCases(limit);
    const reviews = this.listOpenReviews(limit);
    const reviewCountByCase = new Map<string, number>();
    for (const review of reviews) {
      if (!review.caseId) continue;
      reviewCountByCase.set(
        review.caseId,
        (reviewCountByCase.get(review.caseId) ?? 0) + 1,
      );
    }
    const followUps = this.listCancellationExternalFollowUps({ limit });
    const integrationRetries = this.listIntegrationRetryJobs({ limit });
    const workerHealth = this.getWorkerHealth(INTERVIEW_BRIDGE_WORKER_KEY);
    const heartbeatTimestamp = workerHealth
      ? Date.parse(workerHealth.lastHeartbeatAt)
      : Number.NaN;
    const leaseTimestamp = workerHealth?.leaseExpiresAt
      ? Date.parse(workerHealth.leaseExpiresAt)
      : Number.NaN;
    const heartbeatAgeMs = workerHealth && !Number.isNaN(heartbeatTimestamp)
      ? Math.max(0, Date.now() - heartbeatTimestamp)
      : null;
    let workerStatus: "UNKNOWN" | "STALE" | "DEGRADED" | "RUNNING";
    if (!workerHealth || heartbeatAgeMs === null) {
      workerStatus = "UNKNOWN";
    } else if (
      (!Number.isNaN(leaseTimestamp) && leaseTimestamp <= Date.now()) ||
      heartbeatAgeMs > WORKER_DOWNTIME_THRESHOLD_MS
    ) {
      workerStatus = "STALE";
    } else if (workerHealth.lastErrorMessage) {
      workerStatus = "DEGRADED";
    } else {
      workerStatus = "RUNNING";
    }
    const followUpsByCase = new Map<string, CancellationExternalFollowUpRow[]>();
    for (const followUp of followUps) {
      const items = followUpsByCase.get(followUp.caseId) ?? [];
      items.push(followUp);
      followUpsByCase.set(followUp.caseId, items);
    }
    const planCounts: Record<InterviewPlanMode | "UNCONFIGURED", number> = {
      STANDARD: 0,
      COMBINED: 0,
      SEQUENTIAL: 0,
      UNCONFIGURED: 0,
    };
    const recruitmentMetrics = new Map<
      string,
      {
        recruitmentRef: string | null;
        recruitmentName: string | null;
        caseCount: number;
        planCounts: Record<InterviewPlanMode | "UNCONFIGURED", number>;
        statusCounts: Partial<Record<InterviewCaseStatus, number>>;
        pendingRequiredInterviewerResponses: number;
      }
    >();
    let sequentialPlansNeedingInterviewerAssignment = 0;
    for (const interviewCase of cases) {
      const plan = this.getCaseInterviewPlan(interviewCase.id);
      const mode = plan?.mode ?? "UNCONFIGURED";
      planCounts[mode] += 1;
      if (
        plan?.mode === "SEQUENTIAL" &&
        plan.sessions.some((session) => session.interviewerIds.length === 0)
      ) {
        sequentialPlansNeedingInterviewerAssignment += 1;
      }
      const key = interviewCase.recruitmentRef ?? interviewCase.recruitmentName ?? "UNASSIGNED";
      const current = recruitmentMetrics.get(key) ?? {
        recruitmentRef: interviewCase.recruitmentRef,
        recruitmentName: interviewCase.recruitmentName,
        caseCount: 0,
        planCounts: { STANDARD: 0, COMBINED: 0, SEQUENTIAL: 0, UNCONFIGURED: 0 },
        statusCounts: {},
        pendingRequiredInterviewerResponses: 0,
      };
      current.caseCount += 1;
      current.planCounts[mode] += 1;
      current.statusCounts[interviewCase.status] =
        (current.statusCounts[interviewCase.status] ?? 0) + 1;
      current.pendingRequiredInterviewerResponses += this.listInterviewers(interviewCase.id)
        .filter((interviewer) => interviewer.required && interviewer.status === "PENDING")
        .length;
      recruitmentMetrics.set(key, current);
    }
    const blockById = new Map(
      this.listMeetingRoomBlocks(undefined, false).map((block) => [block.id, block]),
    );
    const activeAllocationsByCase = new Map<string, RoomAllocationRow[]>();
    const activeAllocations = this.listRoomAllocations().filter(
      (allocation) => allocation.status === "ACTIVE",
    );
    for (const allocation of activeAllocations) {
      const allocations = activeAllocationsByCase.get(allocation.caseId) ?? [];
      allocations.push(allocation);
      activeAllocationsByCase.set(allocation.caseId, allocations);
    }
    const roomMetrics = new Map<
      string,
      {
        roomId: string;
        roomName: string;
        activeAllocationCount: number;
        allocatedMinutes: number;
      }
    >();
    for (const allocation of activeAllocations) {
      const block = blockById.get(allocation.roomBlockId);
      if (!block) continue;
      const key = `${block.roomId}:${block.roomName}`;
      const current = roomMetrics.get(key) ?? {
        roomId: block.roomId,
        roomName: block.roomName,
        activeAllocationCount: 0,
        allocatedMinutes: 0,
      };
      current.activeAllocationCount += 1;
      current.allocatedMinutes +=
        timeMinutes(allocation.endTime) - timeMinutes(allocation.startTime);
      roomMetrics.set(key, current);
    }

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        caseCountsByStatus: statusCounts,
        openReviews: scalar(
          "SELECT COUNT(*) AS count FROM workflow_reviews WHERE status = 'OPEN'",
        ),
        pendingCancellationExternalFollowUps: scalar(
          `
            SELECT COUNT(*) AS count FROM cancellation_external_follow_ups
            WHERE status = 'PENDING'
              AND follow_up_type = 'NINEHIRE_CANDIDATE_SCHEDULE'
          `,
        ),
        pendingRequiredInterviewerResponses: scalar(`
          SELECT COUNT(*) AS count
          FROM case_interviewers AS interviewer
          JOIN interview_cases AS interview_case ON interview_case.id = interviewer.case_id
          WHERE interviewer.active = 1
            AND interviewer.required = 1
            AND interviewer.status = 'PENDING'
            AND interview_case.status NOT IN ('CANCELLED', 'CLOSED', 'ON_HOLD')
        `),
        pendingIntegrationRetries: scalar(
          "SELECT COUNT(*) AS count FROM integration_retry_jobs WHERE status = 'PENDING'",
        ),
        failedIntegrationRetries: scalar(
          "SELECT COUNT(*) AS count FROM integration_retry_jobs WHERE status = 'FAILED'",
        ),
        worker: workerHealth
          ? {
              status: workerStatus,
              lastStartedAt: workerHealth.lastStartedAt,
              lastHeartbeatAt: workerHealth.lastHeartbeatAt,
              leaseExpiresAt: workerHealth.leaseExpiresAt,
              lastSuccessfulCycleAt: workerHealth.lastSuccessfulCycleAt,
              lastErrorMessage: workerHealth.lastErrorMessage,
              lastDowntimeStartedAt: workerHealth.lastDowntimeStartedAt,
              lastDowntimeDetectedAt: workerHealth.lastDowntimeDetectedAt,
            }
          : { status: workerStatus },
      },
      attention: {
        reviews: reviews.map((review) => ({
          id: review.id,
          caseId: review.caseId,
          reviewType: review.reviewType,
          reason: review.reason,
          createdAt: review.createdAt,
        })),
        cancellationExternalFollowUps: followUps
          .filter((followUp) => followUp.status === "PENDING")
          .map((followUp) => {
            const interviewCase = this.getCase(followUp.caseId);
            return {
              ...followUp,
              candidateName: interviewCase?.candidateName ?? null,
              recruitmentName: interviewCase?.recruitmentName ?? null,
            };
          }),
        integrationRetries: integrationRetries
          .filter((job) => job.status !== "COMPLETED")
          .map((job) => ({
            id: job.id,
            jobType: job.jobType,
            attemptCount: job.attemptCount,
            maxAttempts: job.maxAttempts,
            nextAttemptAt: job.nextAttemptAt,
            lastError: job.lastError
              ? "연동 작업이 실패했습니다. 상세 오류는 로컬 로그를 확인하세요."
              : null,
            status: job.status,
            createdAt: job.createdAt,
        })),
      },
      metrics: {
        interviewPlans: {
          caseCountsByMode: planCounts,
          sequentialPlansNeedingInterviewerAssignment,
        },
        recruitments: [...recruitmentMetrics.values()].sort(
          (left, right) => right.caseCount - left.caseCount,
        ),
        meetingRooms: {
          activeBlocks: this.listMeetingRoomBlocks().length,
          activeAllocations: [...roomMetrics.values()].sort(
            (left, right) => right.allocatedMinutes - left.allocatedMinutes,
          ),
        },
      },
      cases: cases.map((interviewCase) => {
        const plan = this.getCaseInterviewPlan(interviewCase.id);
        const requiredInterviewers = this.listInterviewers(interviewCase.id).filter(
          (interviewer) => interviewer.required,
        );
        const caseFollowUps = followUpsByCase.get(interviewCase.id) ?? [];
        const pendingInterviewerResponses = requiredInterviewers.filter(
          (interviewer) => interviewer.status === "PENDING",
        ).length;
        const pendingCancellationExternalFollowUps = caseFollowUps.filter(
          (followUp) => followUp.status === "PENDING",
        ).length;
        const scheduledSegments = (activeAllocationsByCase.get(interviewCase.id) ?? [])
          .map((allocation) => {
            const block = blockById.get(allocation.roomBlockId);
            return block
              ? {
                  stepId: allocation.interviewStepId,
                  roomName: block.roomName,
                  date: allocation.date,
                  startTime: allocation.startTime,
                  endTime: allocation.endTime,
                }
              : null;
          })
          .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment))
          .sort((left, right) =>
            `${left.date}T${left.startTime}`.localeCompare(`${right.date}T${right.startTime}`),
          );
        if (
          scheduledSegments.length === 0 &&
          interviewCase.scheduledDate &&
          interviewCase.scheduledRoomName &&
          interviewCase.scheduledStartTime &&
          interviewCase.scheduledEndTime
        ) {
          scheduledSegments.push({
            stepId: null,
            roomName: interviewCase.scheduledRoomName,
            date: interviewCase.scheduledDate,
            startTime: interviewCase.scheduledStartTime,
            endTime: interviewCase.scheduledEndTime,
          });
        }
        return {
          id: interviewCase.id,
          candidateName: interviewCase.candidateName,
          recruitmentName: interviewCase.recruitmentName,
          status: interviewCase.status,
          isReschedule: interviewCase.scheduleRound > 1,
          scheduledRoomName: interviewCase.scheduledRoomName,
          scheduledDate: interviewCase.scheduledDate,
          scheduledStartTime: interviewCase.scheduledStartTime,
          scheduledEndTime: interviewCase.scheduledEndTime,
          scheduledSegments,
          candidateScheduleProposalSent: this.hasCandidateScheduleProposalSent(
            interviewCase.id,
          ),
          interviewPlan: plan
            ? {
                mode: plan.mode,
                stepNames: plan.stepNames,
                durationMinutes: plan.durationMinutes,
              }
            : null,
          interviewerResponses: {
            required: requiredInterviewers.length,
            submitted: requiredInterviewers.filter(
              (interviewer) => interviewer.status === "SUBMITTED",
            ).length,
            pending: pendingInterviewerResponses,
            declinedPendingReview: requiredInterviewers.filter(
              (interviewer) =>
                interviewer.status === "DECLINED_PENDING_REVIEW",
            ).length,
          },
          cancellationExternalFollowUps: caseFollowUps,
          needsAttention:
            pendingInterviewerResponses > 0 ||
            pendingCancellationExternalFollowUps > 0 ||
            (reviewCountByCase.get(interviewCase.id) ?? 0) > 0,
        };
      }),
    };
  }

  getCase(id: string): InterviewCaseRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM interview_cases WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? toCase(row) : undefined;
  }

  upsertRecruitmentSlackChannel(input: {
    recruitmentId: string;
    recruitmentName: string;
    channelId: string;
  }): RecruitmentSlackChannelRow {
    const updatedAt = new Date().toISOString();
    this.connection
      .prepare(`
        INSERT INTO recruitment_slack_channels(
          recruitment_id, recruitment_name, channel_id, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(recruitment_id) DO UPDATE SET
          recruitment_name = excluded.recruitment_name,
          channel_id = excluded.channel_id,
          updated_at = excluded.updated_at
      `)
      .run(input.recruitmentId, input.recruitmentName, input.channelId, updatedAt);
    return this.getRecruitmentSlackChannel(input.recruitmentId)!;
  }

  getRecruitmentSlackChannel(
    recruitmentId: string | null | undefined,
  ): RecruitmentSlackChannelRow | undefined {
    if (!recruitmentId) return undefined;
    const row = this.connection
      .prepare("SELECT * FROM recruitment_slack_channels WHERE recruitment_id = ?")
      .get(recruitmentId) as SqlRow | undefined;
    return row
      ? {
          recruitmentId: asString(row.recruitment_id),
          recruitmentName: asString(row.recruitment_name),
          channelId: asString(row.channel_id),
          updatedAt: asString(row.updated_at),
        }
      : undefined;
  }

  getRecruitmentSlackChannelByName(
    recruitmentName: string | null | undefined,
  ): RecruitmentSlackChannelRow | undefined {
    if (!recruitmentName) return undefined;
    const row = this.connection
      .prepare("SELECT * FROM recruitment_slack_channels WHERE recruitment_name = ?")
      .get(recruitmentName) as SqlRow | undefined;
    return row
      ? {
          recruitmentId: asString(row.recruitment_id),
          recruitmentName: asString(row.recruitment_name),
          channelId: asString(row.channel_id),
          updatedAt: asString(row.updated_at),
        }
      : undefined;
  }

  listRecruitmentSlackChannels(): RecruitmentSlackChannelRow[] {
    const rows = this.connection
      .prepare(`
        SELECT * FROM recruitment_slack_channels
        ORDER BY recruitment_name COLLATE NOCASE ASC
      `)
      .all() as SqlRow[];
    return rows.map((row) => ({
      recruitmentId: asString(row.recruitment_id),
      recruitmentName: asString(row.recruitment_name),
      channelId: asString(row.channel_id),
      updatedAt: asString(row.updated_at),
    }));
  }

  getRequestChannelForCase(caseId: string): string | undefined {
    const interviewCase = this.getCase(caseId);
    return this.getRecruitmentSlackChannel(interviewCase?.recruitmentRef)?.channelId;
  }

  upsertRecruitmentInterviewTemplate(input: {
    recruitmentId: string;
    recruitmentName: string;
    pipelineHash: string;
    steps: RecruitmentInterviewTemplateStep[];
    routes?: RecruitmentInterviewRoute[];
  }): RecruitmentInterviewTemplateRow {
    const now = new Date().toISOString();
    this.connection
      .prepare(`
        INSERT INTO recruitment_interview_templates(
          recruitment_id, recruitment_name, pipeline_hash, steps_json, routes_json, approved_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(recruitment_id) DO UPDATE SET
          recruitment_name = excluded.recruitment_name,
          pipeline_hash = excluded.pipeline_hash,
          steps_json = excluded.steps_json,
          routes_json = excluded.routes_json,
          approved_at = excluded.approved_at,
          updated_at = excluded.updated_at
      `)
      .run(
        input.recruitmentId,
        input.recruitmentName,
        input.pipelineHash,
        JSON.stringify(input.steps),
        JSON.stringify(input.routes ?? []),
        now,
        now,
      );
    return this.getRecruitmentInterviewTemplate(input.recruitmentId)!;
  }

  getRecruitmentInterviewTemplate(
    recruitmentId: string,
  ): RecruitmentInterviewTemplateRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM recruitment_interview_templates WHERE recruitment_id = ?")
      .get(recruitmentId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      recruitmentId: asString(row.recruitment_id),
      recruitmentName: asString(row.recruitment_name),
      pipelineHash: asString(row.pipeline_hash),
      steps: JSON.parse(asString(row.steps_json)) as RecruitmentInterviewTemplateStep[],
      routes: JSON.parse(asString(row.routes_json ?? "[]")) as RecruitmentInterviewRoute[],
      approvedAt: asString(row.approved_at),
      updatedAt: asString(row.updated_at),
    };
  }

  getCaseInterviewPlan(caseId: string): CaseInterviewPlanRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM case_interview_plans WHERE case_id = ?")
      .get(caseId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      caseId: asString(row.case_id),
      source: asString(row.source) as CaseInterviewPlanRow["source"],
      mode: asString(row.mode) as InterviewPlanMode,
      stepIds: JSON.parse(asString(row.step_ids_json)) as string[],
      stepNames: JSON.parse(asString(row.step_names_json)) as string[],
      interviewerIds: JSON.parse(asString(row.interviewer_ids_json)) as string[],
      sessions: JSON.parse(asString(row.sessions_json ?? "[]")) as SequentialInterviewSession[],
      durationMinutes: Number(row.duration_minutes),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  upsertCaseInterviewPlan(input: {
    caseId: string;
    source: CaseInterviewPlanRow["source"];
    mode: InterviewPlanMode;
    stepIds: string[];
    stepNames: string[];
    interviewerIds?: string[];
    sessions?: SequentialInterviewSession[];
    durationMinutes: number;
  }): CaseInterviewPlanRow {
    if (input.stepIds.length === 0 || input.stepIds.length !== input.stepNames.length) {
      throw new Error("Interview plan steps are invalid.");
    }
    const now = new Date().toISOString();
    this.connection
      .prepare(`
        INSERT INTO case_interview_plans(
          case_id, source, mode, step_ids_json, step_names_json, interviewer_ids_json, sessions_json,
          duration_minutes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(case_id) DO UPDATE SET
          source = excluded.source,
          mode = excluded.mode,
          step_ids_json = excluded.step_ids_json,
          step_names_json = excluded.step_names_json,
          interviewer_ids_json = excluded.interviewer_ids_json,
          sessions_json = excluded.sessions_json,
          duration_minutes = excluded.duration_minutes,
          updated_at = excluded.updated_at
      `)
      .run(
        input.caseId,
        input.source,
        input.mode,
        JSON.stringify(input.stepIds),
        JSON.stringify(input.stepNames),
        JSON.stringify(input.interviewerIds ?? []),
        JSON.stringify(input.sessions ?? []),
        input.durationMinutes,
        now,
        now,
      );
    this.setCaseDuration(input.caseId, input.durationMinutes);
    return this.getCaseInterviewPlan(input.caseId)!;
  }

  setRequiredInterviewers(caseId: string, interviewerIds: string[]): void {
    const active = this.listInterviewers(caseId).filter((item) => item.active);
    const availableIds = new Set(active.map((item) => item.id));
    if (
      interviewerIds.length === 0 ||
      interviewerIds.some((interviewerId) => !availableIds.has(interviewerId))
    ) {
      throw new Error("Select at least one active interviewer in this case.");
    }
    const selected = new Set(interviewerIds);
    const now = new Date().toISOString();
    this.transaction(() => {
      for (const interviewer of active) {
        this.connection
          .prepare(`
            UPDATE case_interviewers
            SET required = ?, updated_at = ?
            WHERE id = ? AND case_id = ?
          `)
          .run(selected.has(interviewer.id) ? 1 : 0, now, interviewer.id, caseId);
      }
    });
    this.refreshCaseCollectionStatus(caseId);
  }

  findAwaitingCandidateConfirmationCases(
    candidateName: string,
    recruitmentName: string,
  ): InterviewCaseRow[] {
    const rows = this.connection
      .prepare(`
        SELECT * FROM interview_cases
        WHERE status = 'AWAITING_CANDIDATE_CONFIRMATION'
          AND candidate_name = ?
          AND recruitment_name = ?
        ORDER BY created_at ASC
      `)
      .all(candidateName, recruitmentName) as SqlRow[];
    return rows.map(toCase);
  }

  findReadyToScheduleCandidateCases(
    candidateName: string,
    recruitmentName: string,
  ): InterviewCaseRow[] {
    const rows = this.connection
      .prepare(`
        SELECT * FROM interview_cases
        WHERE status = 'READY_TO_SCHEDULE'
          AND candidate_name = ?
          AND recruitment_name = ?
        ORDER BY created_at ASC
      `)
      .all(candidateName, recruitmentName) as SqlRow[];
    return rows.map(toCase);
  }

  findScheduledCandidateCases(
    candidateName: string,
    recruitmentName: string,
  ): InterviewCaseRow[] {
    const rows = this.connection
      .prepare(`
        SELECT * FROM interview_cases
        WHERE status IN ('AWAITING_CANDIDATE_CONFIRMATION', 'CONFIRMED')
          AND candidate_name = ?
          AND recruitment_name = ?
        ORDER BY created_at ASC
      `)
      .all(candidateName, recruitmentName) as SqlRow[];
    return rows.map(toCase);
  }

  findCaseByScheduleConfirmationNotification(
    notificationId: string,
  ): InterviewCaseRow | undefined {
    const row = this.connection
      .prepare(`
        SELECT interview_cases.*
        FROM interview_cases
        JOIN case_events
          ON case_events.case_id = interview_cases.id
        WHERE case_events.event_type = 'CANDIDATE_SCHEDULE_CONFIRMED'
          AND case_events.detail_json LIKE ?
        ORDER BY case_events.created_at DESC
        LIMIT 1
      `)
      .get(`%\"notificationId\":\"${notificationId}\"%`) as SqlRow | undefined;
    return row ? toCase(row) : undefined;
  }

  hasCandidateScheduleProposalSent(caseId: string): boolean {
    const row = this.connection
      .prepare(`
        SELECT 1
        FROM case_events
        WHERE case_id = ? AND event_type = 'CANDIDATE_SCHEDULE_PROPOSAL_SENT'
        LIMIT 1
      `)
      .get(caseId) as SqlRow | undefined;
    return Boolean(row);
  }

  recordCandidateScheduleProposalSent(caseId: string): InterviewCaseRow {
    const interviewCase = this.getCase(caseId);
    if (!interviewCase) throw new Error(`Case not found: ${caseId}`);
    if (interviewCase.status === "CONFIRMED") return interviewCase;
    if (interviewCase.status !== "AWAITING_CANDIDATE_CONFIRMATION") {
      throw new Error("Only an internally confirmed interview can be marked as proposed to the candidate.");
    }
    if (this.hasCandidateScheduleProposalSent(caseId)) return interviewCase;
    this.addEvent(caseId, "CANDIDATE_SCHEDULE_PROPOSAL_SENT", "USER", {
      date: interviewCase.scheduledDate,
      startTime: interviewCase.scheduledStartTime,
      endTime: interviewCase.scheduledEndTime,
      roomName: interviewCase.scheduledRoomName,
    });
    return this.getCase(caseId)!;
  }

  recordExternallyConfirmedCandidateSchedule(input: {
    caseId: string;
    sourceEventId: string;
    source?: "NINEHIRE_MCP" | "DAOU_OFFICE_CALENDAR";
    date: string;
    startTime: string;
    endTime: string;
    sourceLocation?: string;
  }): InterviewCaseRow {
    const interviewCase = this.getCase(input.caseId);
    if (!interviewCase) throw new Error(`Case not found: ${input.caseId}`);
    if (
      interviewCase.status === "CONFIRMED" &&
      interviewCase.scheduledDate === input.date &&
      interviewCase.scheduledStartTime === input.startTime &&
      interviewCase.scheduledEndTime === input.endTime
    ) {
      return interviewCase;
    }
    if (interviewCase.status !== "AWAITING_CANDIDATE_CONFIRMATION") {
      throw new Error("Only an interview awaiting candidate confirmation can be recorded from an external confirmation.");
    }
    if (
      !this.hasCandidateScheduleProposalSent(input.caseId)
      && input.source !== "DAOU_OFFICE_CALENDAR"
    ) {
      throw new Error("The candidate schedule proposal has not been recorded as sent.");
    }
    if (!input.sourceEventId.trim()) {
      throw new Error("An external confirmation source event is required.");
    }
    if (
      interviewCase.scheduledDate !== input.date ||
      interviewCase.scheduledStartTime !== input.startTime ||
      interviewCase.scheduledEndTime !== input.endTime
    ) {
      throw new Error("The externally confirmed schedule does not match the proposed candidate schedule.");
    }

    this.transaction(() => {
      this.setCaseStatus(input.caseId, "CONFIRMED");
      this.addEvent(input.caseId, "CANDIDATE_SCHEDULE_CONFIRMED", input.source ?? "NINEHIRE_MCP", {
        sourceEventId: input.sourceEventId,
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        sourceLocation: input.sourceLocation ?? null,
        externalSchedule: true,
      });
    });
    return this.getCase(input.caseId)!;
  }

  confirmCandidateSchedule(input: {
    caseId: string;
    notificationId: string;
    sourceLocation?: string;
  }): InterviewCaseRow {
    const interviewCase = this.getCase(input.caseId);
    if (!interviewCase) throw new Error(`Case not found: ${input.caseId}`);
    if (interviewCase.status === "CONFIRMED") return interviewCase;
    if (interviewCase.status !== "AWAITING_CANDIDATE_CONFIRMATION") {
      throw new Error("The case is not waiting for candidate confirmation.");
    }
    this.transaction(() => {
      this.setCaseStatus(input.caseId, "CONFIRMED");
      this.addEvent(input.caseId, "CANDIDATE_SCHEDULE_CONFIRMED", "NINEHIRE_SLACK", {
        notificationId: input.notificationId,
        date: interviewCase.scheduledDate,
        startTime: interviewCase.scheduledStartTime,
        endTime: interviewCase.scheduledEndTime,
        sourceLocation: input.sourceLocation ?? null,
      });
    });
    return this.getCase(input.caseId)!;
  }

  recordExternallyConfirmedSchedule(input: {
    caseId: string;
    notificationId?: string;
    sourceEventId?: string;
    source?: "NINEHIRE_SLACK" | "NINEHIRE_MCP";
    date: string;
    startTime: string;
    endTime: string;
    sourceLocation?: string;
  }): InterviewCaseRow {
    const interviewCase = this.getCase(input.caseId);
    if (!interviewCase) throw new Error(`Case not found: ${input.caseId}`);
    if (
      interviewCase.status === "CONFIRMED" &&
      interviewCase.scheduledDate === input.date &&
      interviewCase.scheduledStartTime === input.startTime &&
      interviewCase.scheduledEndTime === input.endTime
    ) {
      return interviewCase;
    }
    if (interviewCase.status !== "READY_TO_SCHEDULE") {
      throw new Error("Only a ready interview can be recorded from an external confirmation.");
    }
    if (!input.notificationId && !input.sourceEventId) {
      throw new Error("An external confirmation source is required.");
    }
    if (
      !isDate(input.date) ||
      timeMinutes(input.startTime) >= timeMinutes(input.endTime) ||
      timeMinutes(input.endTime) - timeMinutes(input.startTime) !== interviewCase.durationMinutes
    ) {
      throw new Error("The externally confirmed schedule does not match the interview duration.");
    }

    const now = new Date().toISOString();
    this.transaction(() => {
      this.connection
        .prepare(`
          UPDATE interview_cases
          SET status = 'CONFIRMED', scheduled_room_allocation_id = NULL,
              scheduled_room_name = NULL, scheduled_date = ?, scheduled_start_time = ?,
              scheduled_end_time = ?, internal_schedule_confirmed_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.date,
          input.startTime,
          input.endTime,
          now,
          now,
          input.caseId,
        );
      this.addEvent(input.caseId, "CANDIDATE_SCHEDULE_CONFIRMED", input.source ?? "NINEHIRE_SLACK", {
        notificationId: input.notificationId ?? null,
        sourceEventId: input.sourceEventId ?? null,
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        sourceLocation: input.sourceLocation ?? null,
        externalSchedule: true,
      });
    });
    return this.getCase(input.caseId)!;
  }

  setConfirmedScheduleRoomAllocation(input: {
    caseId: string;
    roomAllocationId: string;
    actor: "SYSTEM" | "USER";
  }): ConfirmedInterviewScheduleRow {
    const interviewCase = this.getCase(input.caseId);
    if (!interviewCase || interviewCase.status !== "CONFIRMED") {
      throw new Error("Only a confirmed interview can receive a meeting room.");
    }
    const allocationRow = this.connection
      .prepare(`
        SELECT allocation.*, block.room_name
        FROM room_allocations allocation
        JOIN meeting_room_blocks block ON block.id = allocation.room_block_id
        WHERE allocation.id = ?
          AND allocation.case_id = ?
          AND allocation.status = 'ACTIVE'
      `)
      .get(input.roomAllocationId, input.caseId) as SqlRow | undefined;
    if (!allocationRow) {
      throw new Error("An active meeting room allocation is required.");
    }
    const allocation = toRoomAllocation(allocationRow);
    const roomName = asString(allocationRow.room_name);
    if (
      allocation.date !== interviewCase.scheduledDate ||
      allocation.startTime !== interviewCase.scheduledStartTime ||
      allocation.endTime !== interviewCase.scheduledEndTime
    ) {
      throw new Error("The meeting room allocation does not match the confirmed schedule.");
    }

    this.transaction(() => {
      this.connection
        .prepare(`
          UPDATE interview_cases
          SET scheduled_room_allocation_id = ?, scheduled_room_name = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(allocation.id, roomName, new Date().toISOString(), input.caseId);
      this.addEvent(input.caseId, "CONFIRMED_SCHEDULE_ROOM_RECORDED", input.actor, {
        allocationId: allocation.id,
        roomName,
      });
    });
    return this.getConfirmedInterviewSchedule(input.caseId)!;
  }

  recordManualConfirmedSchedule(input: {
    caseId: string;
    date: string;
    startTime: string;
    endTime: string;
    roomName: string;
    note?: string;
  }): ConfirmedInterviewScheduleRow {
    const interviewCase = this.getCase(input.caseId);
    if (!interviewCase) throw new Error(`Case not found: ${input.caseId}`);
    if (
      !isDate(input.date) ||
      timeMinutes(input.startTime) >= timeMinutes(input.endTime) ||
      !input.roomName.trim()
    ) {
      throw new Error("A valid manual interview schedule is required.");
    }
    if (interviewCase.status === "CONFIRMED") {
      const confirmed = this.getConfirmedInterviewSchedule(input.caseId);
      if (
        confirmed &&
        confirmed.date === input.date &&
        confirmed.startTime === input.startTime &&
        confirmed.endTime === input.endTime &&
        confirmed.roomName === input.roomName
      ) {
        return confirmed;
      }
      throw new Error("A different confirmed schedule already exists for this case.");
    }
    if (interviewCase.status !== "READY_FOR_DRAFT") {
      throw new Error("Only a new interview case can be manually confirmed.");
    }

    const now = new Date().toISOString();
    this.transaction(() => {
      this.assertNoScheduledRoomConflict({
        caseId: input.caseId,
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        roomName: input.roomName,
      });
      this.connection
        .prepare(`
          UPDATE interview_cases
          SET status = 'CONFIRMED', scheduled_room_allocation_id = NULL,
              scheduled_room_name = ?, scheduled_date = ?,
              scheduled_start_time = ?, scheduled_end_time = ?,
              internal_schedule_confirmed_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.roomName,
          input.date,
          input.startTime,
          input.endTime,
          now,
          now,
          input.caseId,
        );
      this.addEvent(input.caseId, "MANUAL_INTERVIEW_CONFIRMED", "USER", {
        source: "MANUAL",
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        roomName: input.roomName,
        note: input.note ?? null,
      });
    });
    return this.getConfirmedInterviewSchedule(input.caseId)!;
  }

  assertNoScheduledRoomConflict(input: {
    caseId?: string;
    date: string;
    startTime: string;
    endTime: string;
    roomName: string;
  }): void {
    const conflict = this.connection
      .prepare(`
        SELECT interview_cases.id
        FROM interview_cases
        LEFT JOIN room_allocations
          ON room_allocations.id = interview_cases.scheduled_room_allocation_id
        LEFT JOIN meeting_room_blocks
          ON meeting_room_blocks.id = room_allocations.room_block_id
        WHERE (? IS NULL OR interview_cases.id != ?)
          AND interview_cases.status IN ('AWAITING_CANDIDATE_CONFIRMATION', 'CONFIRMED')
          AND interview_cases.scheduled_date = ?
          AND COALESCE(interview_cases.scheduled_room_name, meeting_room_blocks.room_name) = ?
          AND interview_cases.scheduled_start_time < ?
          AND interview_cases.scheduled_end_time > ?
        LIMIT 1
      `)
      .get(
        input.caseId ?? null,
        input.caseId ?? null,
        input.date,
        input.roomName,
        input.endTime,
        input.startTime,
      ) as SqlRow | undefined;
    if (conflict) {
      throw new Error("Another scheduled interview already uses this room and time.");
    }
  }

  getCaseBundle(id: string): CaseBundle | undefined {
    const interviewCase = this.getCase(id);
    if (!interviewCase) return undefined;
    const availability = this.connection
      .prepare(`
        SELECT interviewer_id, date, start_time, end_time
        FROM availability_slots WHERE case_id = ?
        ORDER BY interviewer_id, date, start_time
      `)
      .all(id) as SqlRow[];
    const drafts = (
      this.connection
        .prepare(`
          SELECT * FROM message_drafts
          WHERE case_id = ? ORDER BY created_at DESC
        `)
        .all(id) as SqlRow[]
    ).map(toDraft);
    return {
      interviewCase,
      interviewers: this.listInterviewers(id, false),
      availability: availability.map((row) => ({
        interviewerId: asString(row.interviewer_id),
        date: asString(row.date),
        start: asString(row.start_time),
        end: asString(row.end_time),
      })),
      drafts,
    };
  }

  listCaseEvents(caseId: string, limit = 100): CaseEventRow[] {
    const rows = this.connection
      .prepare(`
        SELECT id, case_id, event_type, actor, detail_json, created_at
        FROM case_events
        WHERE case_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(caseId, limit) as SqlRow[];
    return rows.map((row) => ({
      id: asString(row.id),
      caseId: nullableString(row.case_id),
      eventType: asString(row.event_type),
      actor: asString(row.actor),
      detail: JSON.parse(asString(row.detail_json)) as Record<string, unknown>,
      createdAt: asString(row.created_at),
    }));
  }

  syncMeetingRoomBlocks(
    dates: string[],
    blocks: MeetingRoomBlockInput[],
  ): MeetingRoomBlockRow[] {
    const syncedDates = [...new Set(dates)].sort();
    if (syncedDates.length === 0 || syncedDates.some((date) => !isDate(date))) {
      throw new Error("At least one YYYY-MM-DD room sync date is required.");
    }
    if (blocks.some((block) => !syncedDates.includes(block.date))) {
      throw new Error("A synced meeting room block is outside the requested dates.");
    }
    for (const block of blocks) {
      validateDateAndTimeRange(
        block.date,
        block.startTime,
        block.endTime,
        "Meeting room block",
      );
      if (!block.sourceKey.trim() || !block.roomId.trim() || !block.roomName.trim()) {
        throw new Error("Meeting room block identifiers and room name are required.");
      }
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      const deactivate = this.connection.prepare(`
        UPDATE meeting_room_blocks
        SET active = 0, updated_at = ?
        WHERE date = ?
      `);
      for (const date of syncedDates) deactivate.run(now, date);

      const existing = this.connection.prepare(
        "SELECT id FROM meeting_room_blocks WHERE source_key = ?",
      );
      const insert = this.connection.prepare(`
        INSERT INTO meeting_room_blocks(
          id, source_key, room_id, room_name, reserved_by, purpose,
          date, start_time, end_time, source_payload_hash, active,
          seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `);
      const update = this.connection.prepare(`
        UPDATE meeting_room_blocks
        SET room_id = ?, room_name = ?, reserved_by = ?, purpose = ?,
          date = ?, start_time = ?, end_time = ?, source_payload_hash = ?,
          active = 1, seen_at = ?, updated_at = ?
        WHERE source_key = ?
      `);
      for (const block of blocks) {
        const current = existing.get(block.sourceKey) as SqlRow | undefined;
        if (current) {
          update.run(
            block.roomId,
            block.roomName,
            block.reservedBy,
            block.purpose,
            block.date,
            block.startTime,
            block.endTime,
            block.sourcePayloadHash,
            now,
            now,
            block.sourceKey,
          );
        } else {
          insert.run(
            randomUUID(),
            block.sourceKey,
            block.roomId,
            block.roomName,
            block.reservedBy,
            block.purpose,
            block.date,
            block.startTime,
            block.endTime,
            block.sourcePayloadHash,
            now,
            now,
            now,
          );
        }
      }

      const markDate = this.connection.prepare(`
        INSERT INTO meeting_room_sync_dates(date, synced_at)
        VALUES (?, ?)
        ON CONFLICT(date) DO UPDATE SET synced_at = excluded.synced_at
      `);
      for (const date of syncedDates) markDate.run(date, now);
    });
    return this.listMeetingRoomBlocks(syncedDates, false);
  }

  syncExternalConfirmedInterviews(
    events: DaouInterviewCalendarEvent[],
  ): ExternalConfirmedInterviewRow[] {
    const seenAt = new Date().toISOString();
    for (const event of events) {
      validateDateAndTimeRange(
        event.date,
        event.startTime,
        event.endTime,
        "External confirmed interview",
      );
      if (!event.sourceEventId.trim() || !event.candidateName.trim() || !event.recruitmentName.trim()) {
        throw new Error("External confirmed interview identifiers, candidate, and recruitment are required.");
      }
    }
    this.transaction(() => {
      const existing = this.connection.prepare(
        "SELECT id FROM external_confirmed_interviews WHERE source_event_id = ?",
      );
      const sameSchedule = this.connection.prepare(`
        SELECT id FROM external_confirmed_interviews
        WHERE candidate_name = ? AND recruitment_name = ?
          AND date = ? AND start_time = ? AND end_time = ?
        LIMIT 1
      `);
      const insert = this.connection.prepare(`
        INSERT INTO external_confirmed_interviews(
          id, source_event_id, candidate_name, recruitment_name,
          date, start_time, end_time, room_name, linked_case_id,
          first_seen_at, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `);
      const update = this.connection.prepare(`
        UPDATE external_confirmed_interviews
        SET candidate_name = ?, recruitment_name = ?, date = ?, start_time = ?, end_time = ?, room_name = ?,
            last_seen_at = ?, updated_at = ?
        WHERE source_event_id = ?
      `);
      const adoptSourceEvent = this.connection.prepare(`
        UPDATE external_confirmed_interviews
        SET source_event_id = ?, candidate_name = ?, recruitment_name = ?,
            date = ?, start_time = ?, end_time = ?, room_name = ?,
            last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `);
      for (const event of events) {
        const current = existing.get(event.sourceEventId) as SqlRow | undefined;
        if (current) {
          update.run(
            event.candidateName,
            event.recruitmentName,
            event.date,
            event.startTime,
            event.endTime,
            event.roomName ?? null,
            seenAt,
            seenAt,
            event.sourceEventId,
          );
        } else {
          const matchingSchedule = sameSchedule.get(
            event.candidateName,
            event.recruitmentName,
            event.date,
            event.startTime,
            event.endTime,
          ) as SqlRow | undefined;
          if (matchingSchedule) {
            adoptSourceEvent.run(
              event.sourceEventId,
              event.candidateName,
              event.recruitmentName,
              event.date,
              event.startTime,
              event.endTime,
              event.roomName ?? null,
              seenAt,
              seenAt,
              asString(matchingSchedule.id),
            );
            continue;
          }
          insert.run(
            randomUUID(),
            event.sourceEventId,
            event.candidateName,
            event.recruitmentName,
            event.date,
            event.startTime,
            event.endTime,
            event.roomName ?? null,
            seenAt,
            seenAt,
            seenAt,
            seenAt,
          );
        }
      }
    });
    return this.listExternalConfirmedInterviews();
  }

  linkExternalConfirmedInterviewToCase(sourceEventId: string, caseId: string): void {
    this.connection
      .prepare(`
        UPDATE external_confirmed_interviews
        SET linked_case_id = ?, updated_at = ?
        WHERE source_event_id = ?
      `)
      .run(caseId, new Date().toISOString(), sourceEventId);
  }

  deleteExternalConfirmedInterviewsBefore(date: string): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("A valid cutoff date is required.");
    }
    return Number(
      this.connection
        .prepare("DELETE FROM external_confirmed_interviews WHERE date < ?")
        .run(date).changes,
    );
  }

  listExternalConfirmedInterviews(limit = 200): ExternalConfirmedInterviewRow[] {
    return (this.connection
      .prepare(`
        SELECT * FROM external_confirmed_interviews
        ORDER BY date ASC, start_time ASC, candidate_name ASC
        LIMIT ?
      `)
      .all(limit) as SqlRow[]).map(toExternalConfirmedInterview);
  }

  listMeetingRoomBlocks(
    dates?: string[],
    activeOnly = true,
  ): MeetingRoomBlockRow[] {
    const normalizedDates = dates ? [...new Set(dates)].sort() : undefined;
    const conditions = activeOnly ? ["active = 1"] : [];
    const params: string[] = [];
    if (normalizedDates && normalizedDates.length > 0) {
      conditions.push(`date IN (${normalizedDates.map(() => "?").join(", ")})`);
      params.push(...normalizedDates);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return (
      this.connection
        .prepare(`
          SELECT * FROM meeting_room_blocks
          ${where}
          ORDER BY date ASC, start_time ASC, room_name ASC
        `)
        .all(...params) as SqlRow[]
    ).map(toMeetingRoomBlock);
  }

  areMeetingRoomDatesSynced(
    dates: string[],
    maxAgeMs = MEETING_ROOM_SYNC_FRESHNESS_MS,
  ): boolean {
    const normalizedDates = [...new Set(dates)].sort();
    if (normalizedDates.length === 0) return false;
    const row = this.connection
      .prepare(
        `SELECT COUNT(*) AS count, MIN(synced_at) AS oldest_synced_at
         FROM meeting_room_sync_dates
         WHERE date IN (${normalizedDates.map(() => "?").join(", ")})`,
      )
      .get(...normalizedDates) as SqlRow;
    if (Number(row.count) !== normalizedDates.length) return false;
    const oldestSyncedAt = Date.parse(asString(row.oldest_synced_at));
    return Number.isFinite(oldestSyncedAt) && Date.now() - oldestSyncedAt <= maxAgeMs;
  }

  listRoomAllocations(caseId?: string): RoomAllocationRow[] {
    const rows = caseId
      ? (this.connection
          .prepare(`
            SELECT * FROM room_allocations
            WHERE case_id = ? ORDER BY date ASC, start_time ASC
          `)
          .all(caseId) as SqlRow[])
      : (this.connection
          .prepare(`
            SELECT * FROM room_allocations
            ORDER BY date ASC, start_time ASC
          `)
          .all() as SqlRow[]);
    return rows.map(toRoomAllocation);
  }

  findAvailableRoomBlocks(
    date: string,
    startTime: string,
    endTime: string,
  ): MeetingRoomBlockRow[] {
    if (!isDate(date) || timeMinutes(startTime) >= timeMinutes(endTime)) {
      throw new Error("A valid room slot is required.");
    }
    const rows = this.connection
      .prepare(`
        SELECT block.* FROM meeting_room_blocks block
        WHERE block.active = 1
          AND block.date = ?
          AND block.start_time <= ?
          AND block.end_time >= ?
          AND NOT EXISTS (
            SELECT 1 FROM room_allocations allocation
            WHERE allocation.room_block_id = block.id
              AND allocation.status = 'ACTIVE'
              AND allocation.start_time < ?
              AND allocation.end_time > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM interview_cases confirmed_case
            LEFT JOIN room_allocations confirmed_allocation
              ON confirmed_allocation.id = confirmed_case.scheduled_room_allocation_id
            LEFT JOIN meeting_room_blocks confirmed_block
              ON confirmed_block.id = confirmed_allocation.room_block_id
            WHERE confirmed_case.status IN ('AWAITING_CANDIDATE_CONFIRMATION', 'CONFIRMED')
              AND confirmed_case.scheduled_date = block.date
              AND COALESCE(confirmed_case.scheduled_room_name, confirmed_block.room_name) = block.room_name
              AND confirmed_case.scheduled_start_time < ?
              AND confirmed_case.scheduled_end_time > ?
          )
        ORDER BY block.room_name ASC
      `)
      .all(date, startTime, endTime, endTime, startTime, endTime, startTime) as SqlRow[];
    return rows.map(toMeetingRoomBlock);
  }

  allocateRoomBlock(input: {
    caseId: string;
    roomBlockId: string;
    startTime: string;
    endTime: string;
  }): RoomAllocationRow {
    const interviewCase = this.getCase(input.caseId);
    if (!interviewCase) throw new Error(`Case not found: ${input.caseId}`);
    const blockRow = this.connection
      .prepare("SELECT * FROM meeting_room_blocks WHERE id = ? AND active = 1")
      .get(input.roomBlockId) as SqlRow | undefined;
    if (!blockRow) throw new Error("Active meeting room block not found.");
    const block = toMeetingRoomBlock(blockRow);
    validateTimeRange(input.startTime, input.endTime, "Room allocation");
    const duration = timeMinutes(input.endTime) - timeMinutes(input.startTime);
    if (
      duration !== interviewCase.durationMinutes ||
      timeMinutes(input.startTime) < timeMinutes(block.startTime) ||
      timeMinutes(input.endTime) > timeMinutes(block.endTime)
    ) {
      throw new Error("Room allocation must fit the room block and case duration.");
    }

    return this.transaction(() => {
      const existingForCase = this.connection
        .prepare(`
          SELECT * FROM room_allocations
          WHERE case_id = ? AND status = 'ACTIVE'
        `)
        .get(input.caseId) as SqlRow | undefined;
      if (existingForCase) {
        const existing = toRoomAllocation(existingForCase);
        if (
          existing.roomBlockId === input.roomBlockId &&
          existing.startTime === input.startTime &&
          existing.endTime === input.endTime
        ) {
          return existing;
        }
        throw new Error("This case already has an active room allocation.");
      }

      this.assertNoScheduledRoomConflict({
        caseId: input.caseId,
        date: block.date,
        startTime: input.startTime,
        endTime: input.endTime,
        roomName: block.roomName,
      });

      const conflict = this.connection
        .prepare(`
          SELECT id FROM room_allocations
          WHERE room_block_id = ?
            AND status = 'ACTIVE'
            AND start_time < ?
            AND end_time > ?
          LIMIT 1
        `)
        .get(input.roomBlockId, input.endTime, input.startTime) as SqlRow | undefined;
      if (conflict) throw new Error("The selected room slot is already allocated.");

      const id = randomUUID();
      const now = new Date().toISOString();
      this.connection
        .prepare(`
          INSERT INTO room_allocations(
            id, case_id, room_block_id, date, start_time, end_time,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
        `)
        .run(
          id,
          input.caseId,
          input.roomBlockId,
          block.date,
          input.startTime,
          input.endTime,
          now,
          now,
        );
      this.addEvent(input.caseId, "ROOM_ALLOCATED", "USER", {
        allocationId: id,
        roomBlockId: input.roomBlockId,
        date: block.date,
        startTime: input.startTime,
        endTime: input.endTime,
      });
      return this.listRoomAllocations(input.caseId).find((row) => row.id === id)!;
    });
  }

  allocateSequentialRoomBlocks(input: {
    caseId: string;
    sessions: Array<{ stepId: string; roomBlockId: string; startTime: string; endTime: string }>;
  }): RoomAllocationRow[] {
    const interviewCase = this.getCase(input.caseId);
    const plan = this.getCaseInterviewPlan(input.caseId);
    if (!interviewCase || !plan || plan.mode !== "SEQUENTIAL") {
      throw new Error("A sequential interview plan is required before allocating rooms.");
    }
    if (interviewCase.status !== "READY_TO_SCHEDULE") {
      throw new Error("Wait for every required interviewer response before allocating a sequential schedule.");
    }
    if (input.sessions.length !== plan.sessions.length) {
      throw new Error("Allocate one room slot for every sequential interview stage.");
    }
    const configured = new Set(plan.sessions.map((session) => session.stepId));
    if (
      new Set(input.sessions.map((session) => session.stepId)).size !== input.sessions.length ||
      input.sessions.some((session) => !configured.has(session.stepId))
    ) {
      throw new Error("Allocated stages do not match the sequential interview plan.");
    }
    if (this.listRoomAllocations(input.caseId).some((allocation) => allocation.status === "ACTIVE")) {
      throw new Error("This case already has active room allocations.");
    }
    const allocations: RoomAllocationRow[] = [];
    this.transaction(() => {
      let previousEnd: string | undefined;
      let expectedDate: string | undefined;
      for (const [sequenceIndex, session] of input.sessions.entries()) {
        validateTimeRange(session.startTime, session.endTime, "Sequential room allocation");
        if (timeMinutes(session.endTime) - timeMinutes(session.startTime) !== 60) {
          throw new Error("Each sequential interview stage must be exactly 60 minutes.");
        }
        if (previousEnd && session.startTime !== previousEnd) {
          throw new Error("Sequential interview stages must be contiguous.");
        }
        const blockRow = this.connection
          .prepare("SELECT * FROM meeting_room_blocks WHERE id = ? AND active = 1")
          .get(session.roomBlockId) as SqlRow | undefined;
        if (!blockRow) throw new Error("Active meeting room block not found.");
        const block = toMeetingRoomBlock(blockRow);
        if (
          (expectedDate && block.date !== expectedDate) ||
          timeMinutes(session.startTime) < timeMinutes(block.startTime) ||
          timeMinutes(session.endTime) > timeMinutes(block.endTime)
        ) {
          throw new Error("Each room slot must fit its meeting room block on the same date.");
        }
        this.assertNoScheduledRoomConflict({
          caseId: input.caseId,
          date: block.date,
          startTime: session.startTime,
          endTime: session.endTime,
          roomName: block.roomName,
        });
        const conflict = this.connection
          .prepare("SELECT id FROM room_allocations WHERE room_block_id = ? AND status = 'ACTIVE' AND start_time < ? AND end_time > ? LIMIT 1")
          .get(session.roomBlockId, session.endTime, session.startTime) as SqlRow | undefined;
        if (conflict) throw new Error("A selected meeting room slot is already allocated.");
        const id = randomUUID();
        const now = new Date().toISOString();
        this.connection
          .prepare(`INSERT INTO room_allocations(
            id, case_id, room_block_id, interview_step_id, date, start_time, end_time, sequence_index,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`)
          .run(id, input.caseId, block.id, session.stepId, block.date, session.startTime, session.endTime, sequenceIndex, now, now);
        allocations.push({
          id, caseId: input.caseId, roomBlockId: block.id, interviewStepId: session.stepId, date: block.date,
          startTime: session.startTime, endTime: session.endTime, sequenceIndex,
          status: "ACTIVE", createdAt: now, updatedAt: now,
        });
        previousEnd = session.endTime;
        expectedDate = block.date;
      }
      this.addEvent(input.caseId, "SEQUENTIAL_ROOMS_ALLOCATED", "USER", { sessions: input.sessions });
    });
    return allocations;
  }

  confirmSequentialInternalSchedule(caseId: string): ConfirmedInterviewScheduleRow {
    const interviewCase = this.getCase(caseId);
    const plan = this.getCaseInterviewPlan(caseId);
    if (!interviewCase || !plan || plan.mode !== "SEQUENTIAL") {
      throw new Error("A sequential interview plan is required before confirming the schedule.");
    }
    if (interviewCase.status !== "READY_TO_SCHEDULE") {
      throw new Error("Only a ready sequential interview can be internally confirmed.");
    }
    const allocations = this.listRoomAllocations(caseId)
      .filter((allocation) => allocation.status === "ACTIVE")
      .sort((left, right) => left.sequenceIndex - right.sequenceIndex);
    if (allocations.length !== plan.sessions.length) {
      throw new Error("Allocate every sequential interview room slot before confirming.");
    }
    const first = allocations[0]!;
    const last = allocations.at(-1)!;
    if (allocations.some((item) => item.date !== first.date) || allocations.some((item, index) => index > 0 && item.startTime !== allocations[index - 1]!.endTime)) {
      throw new Error("Sequential room allocations must be on one date and contiguous.");
    }
    const roomNames = allocations.map((allocation) => {
      const row = this.connection.prepare("SELECT room_name FROM meeting_room_blocks WHERE id = ?")
        .get(allocation.roomBlockId) as SqlRow;
      return asString(row.room_name);
    });
    const now = new Date().toISOString();
    this.connection.prepare(`
      UPDATE interview_cases
      SET status = 'AWAITING_CANDIDATE_CONFIRMATION', scheduled_room_allocation_id = ?,
          scheduled_room_name = ?, scheduled_date = ?, scheduled_start_time = ?,
          scheduled_end_time = ?, internal_schedule_confirmed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(first.id, roomNames.join(" → "), first.date, first.startTime, last.endTime, now, now, caseId);
    this.addEvent(caseId, "SEQUENTIAL_INTERNAL_SCHEDULE_CONFIRMED", "USER", {
      sessions: allocations.map((allocation, index) => ({
        stepId: allocation.interviewStepId,
        roomName: roomNames[index],
        startTime: allocation.startTime,
        endTime: allocation.endTime,
      })),
    });
    return this.getConfirmedInterviewSchedule(caseId)!;
  }

  confirmInternalSchedule(caseId: string): ConfirmedInterviewScheduleRow {
    const interviewCase = this.getCase(caseId);
    if (!interviewCase) throw new Error(`Case not found: ${caseId}`);
    if (interviewCase.status === "AWAITING_CANDIDATE_CONFIRMATION") {
      const confirmed = this.getConfirmedInterviewSchedule(caseId);
      if (confirmed) return confirmed;
      throw new Error("The confirmed schedule record is missing.");
    }
    if (interviewCase.status !== "READY_TO_SCHEDULE") {
      throw new Error(
        "Only a case with all required interviewer responses can be internally scheduled.",
      );
    }

    const allocationRow = this.connection
      .prepare(`
        SELECT * FROM room_allocations
        WHERE case_id = ? AND status = 'ACTIVE'
        ORDER BY created_at ASC LIMIT 1
      `)
      .get(caseId) as SqlRow | undefined;
    if (!allocationRow) {
      throw new Error("An active room allocation is required before confirming a schedule.");
    }
    const allocation = toRoomAllocation(allocationRow);
    const now = new Date().toISOString();
    this.transaction(() => {
      this.connection
        .prepare(`
          UPDATE interview_cases
          SET status = ?, scheduled_room_allocation_id = ?, scheduled_date = ?,
              scheduled_room_name = NULL, scheduled_start_time = ?, scheduled_end_time = ?,
              internal_schedule_confirmed_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          "AWAITING_CANDIDATE_CONFIRMATION",
          allocation.id,
          allocation.date,
          allocation.startTime,
          allocation.endTime,
          now,
          now,
          caseId,
        );
      this.addEvent(caseId, "INTERNAL_SCHEDULE_CONFIRMED", "USER", {
        allocationId: allocation.id,
        date: allocation.date,
        startTime: allocation.startTime,
        endTime: allocation.endTime,
      });
    });
    return this.getConfirmedInterviewSchedule(caseId)!;
  }

  getConfirmedInterviewSchedule(
    caseId: string,
  ): ConfirmedInterviewScheduleRow | undefined {
    const row = this.connection
      .prepare(`
      SELECT
          interview_cases.id AS case_id,
          interview_cases.scheduled_room_allocation_id,
          interview_cases.scheduled_date,
          interview_cases.scheduled_start_time,
          interview_cases.scheduled_end_time,
          interview_cases.internal_schedule_confirmed_at,
          COALESCE(interview_cases.scheduled_room_name, meeting_room_blocks.room_name) AS room_name
        FROM interview_cases
        LEFT JOIN room_allocations
          ON room_allocations.id = interview_cases.scheduled_room_allocation_id
        LEFT JOIN meeting_room_blocks
          ON meeting_room_blocks.id = room_allocations.room_block_id
        WHERE interview_cases.id = ?
          AND (
            interview_cases.scheduled_room_allocation_id IS NOT NULL
            OR interview_cases.scheduled_room_name IS NOT NULL
          )
      `)
      .get(caseId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      caseId: asString(row.case_id),
      roomAllocationId: nullableString(row.scheduled_room_allocation_id),
      date: asString(row.scheduled_date),
      startTime: asString(row.scheduled_start_time),
      endTime: asString(row.scheduled_end_time),
      roomName: asString(row.room_name),
      confirmedAt: asString(row.internal_schedule_confirmed_at),
    };
  }

  getLastScheduledInterviewSchedule(
    caseId: string,
  ): ConfirmedInterviewScheduleRow | undefined {
    const row = this.connection
      .prepare(
        `
          SELECT
            interview_cases.id AS case_id,
            interview_cases.last_scheduled_room_allocation_id,
            interview_cases.last_scheduled_date,
          interview_cases.last_scheduled_start_time,
          interview_cases.last_scheduled_end_time,
          interview_cases.last_internal_schedule_confirmed_at,
          COALESCE(interview_cases.last_scheduled_room_name, meeting_room_blocks.room_name) AS room_name
        FROM interview_cases
        LEFT JOIN room_allocations
          ON room_allocations.id = interview_cases.last_scheduled_room_allocation_id
        LEFT JOIN meeting_room_blocks
          ON meeting_room_blocks.id = room_allocations.room_block_id
        WHERE interview_cases.id = ?
          AND (
            interview_cases.last_scheduled_room_allocation_id IS NOT NULL
            OR interview_cases.last_scheduled_room_name IS NOT NULL
          )
        `,
      )
      .get(caseId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      caseId: asString(row.case_id),
      roomAllocationId: nullableString(row.last_scheduled_room_allocation_id),
      date: asString(row.last_scheduled_date),
      startTime: asString(row.last_scheduled_start_time),
      endTime: asString(row.last_scheduled_end_time),
      roomName: asString(row.room_name),
      confirmedAt: asString(row.last_internal_schedule_confirmed_at),
    };
  }

  reopenScheduleForReschedule(input: {
    caseId: string;
    availabilityPolicy: RescheduleAvailabilityPolicy;
    reason: string;
  }): ScheduleTransitionResult {
    const interviewCase = this.getCase(input.caseId);
    if (!interviewCase) throw new Error(`Case not found: ${input.caseId}`);
    if (
      ![
        "AWAITING_CANDIDATE_CONFIRMATION",
        "CONFIRMED",
        "REVIEW_REQUIRED",
      ].includes(interviewCase.status)
    ) {
      throw new Error(
        "Only an internally scheduled or review-required case can be reopened for rescheduling.",
      );
    }
    const previousSchedule = this.getConfirmedInterviewSchedule(input.caseId);
    if (!previousSchedule) {
      throw new Error("The previous confirmed schedule record is missing.");
    }
    const hadSentScheduleConfirmation = this.hasSentScheduleConfirmation(
      input.caseId,
    );
    let cancelledDraftIds: string[] = [];

    this.transaction(() => {
      const now = new Date().toISOString();
      const activeAllocations = this.connection
        .prepare(
          "SELECT id FROM room_allocations WHERE case_id = ? AND status = 'ACTIVE'",
        )
        .all(input.caseId) as SqlRow[];
      for (const allocation of activeAllocations) {
        const allocationId = asString(allocation.id);
        this.connection
          .prepare(
            "UPDATE room_allocations SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
          )
          .run(now, allocationId);
        this.addEvent(input.caseId, "ROOM_ALLOCATION_CANCELLED", "USER", {
          allocationId,
          reason: "SCHEDULE_REOPENED",
        });
      }

      cancelledDraftIds = this.cancelUnsentDrafts(
        input.caseId,
        "The interview schedule was reopened for rescheduling.",
      );

      let clearedAvailabilityCount = 0;
      if (input.availabilityPolicy === "RECOLLECT") {
        clearedAvailabilityCount = Number(
          (
            this.connection
              .prepare(
                "SELECT COUNT(*) AS count FROM availability_slots WHERE case_id = ?",
              )
              .get(input.caseId) as SqlRow
          ).count,
        );
        this.connection
          .prepare("DELETE FROM availability_slots WHERE case_id = ?")
          .run(input.caseId);
        this.connection
          .prepare(
            `
              UPDATE case_interviewers
              SET status = 'PENDING', responded_at = NULL, updated_at = ?
              WHERE case_id = ? AND active = 1
            `,
          )
          .run(now, input.caseId);
        this.connection
          .prepare("DELETE FROM reminders WHERE case_id = ?")
          .run(input.caseId);
      } else {
        this.connection
          .prepare("DELETE FROM reminders WHERE case_id = ? AND sent_at IS NULL")
          .run(input.caseId);
      }

      this.connection
        .prepare(
          `
            UPDATE interview_cases
            SET status = ?, schedule_round = schedule_round + 1,
                last_scheduled_room_allocation_id = scheduled_room_allocation_id,
                last_scheduled_room_name = scheduled_room_name,
                last_scheduled_date = scheduled_date,
                last_scheduled_start_time = scheduled_start_time,
                last_scheduled_end_time = scheduled_end_time,
                last_internal_schedule_confirmed_at = internal_schedule_confirmed_at,
                scheduled_room_allocation_id = NULL, scheduled_date = NULL,
                scheduled_room_name = NULL,
                scheduled_start_time = NULL, scheduled_end_time = NULL,
                internal_schedule_confirmed_at = NULL, updated_at = ?
            WHERE id = ?
          `,
        )
        .run(
          input.availabilityPolicy === "RECOLLECT"
            ? "READY_FOR_DRAFT"
            : "READY_TO_SCHEDULE",
          now,
          input.caseId,
        );
      this.addEvent(input.caseId, "SCHEDULE_REOPENED", "USER", {
        reason: input.reason,
        availabilityPolicy: input.availabilityPolicy,
        previousSchedule: {
          date: previousSchedule.date,
          startTime: previousSchedule.startTime,
          endTime: previousSchedule.endTime,
          roomName: previousSchedule.roomName,
        },
        clearedAvailabilityCount,
        cancelledDraftIds,
      });
    });

    return {
      interviewCase: this.getCase(input.caseId)!,
      previousSchedule,
      hadSentScheduleConfirmation,
      cancelledDraftIds,
    };
  }

  cancelInterviewArrangement(input: {
    caseId: string;
    reason: string;
  }): ScheduleTransitionResult {
    const interviewCase = this.getCase(input.caseId);
    if (!interviewCase) throw new Error(`Case not found: ${input.caseId}`);
    if (interviewCase.status === "CLOSED") {
      throw new Error("A closed interview case cannot be cancelled.");
    }
    const previousSchedule =
      this.getConfirmedInterviewSchedule(input.caseId) ??
      this.getLastScheduledInterviewSchedule(input.caseId);
    const hadSentScheduleConfirmation = this.hasSentScheduleConfirmation(
      input.caseId,
    );
    if (interviewCase.status === "CANCELLED") {
      return {
        interviewCase,
        previousSchedule,
        hadSentScheduleConfirmation,
        cancelledDraftIds: [],
      };
    }
    let cancelledDraftIds: string[] = [];

    this.transaction(() => {
      const now = new Date().toISOString();
      const activeAllocations = this.connection
        .prepare(
          "SELECT id FROM room_allocations WHERE case_id = ? AND status = 'ACTIVE'",
        )
        .all(input.caseId) as SqlRow[];
      for (const allocation of activeAllocations) {
        const allocationId = asString(allocation.id);
        this.connection
          .prepare(
            "UPDATE room_allocations SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
          )
          .run(now, allocationId);
        this.addEvent(input.caseId, "ROOM_ALLOCATION_CANCELLED", "USER", {
          allocationId,
          reason: "INTERVIEW_CANCELLED",
        });
      }
      cancelledDraftIds = this.cancelUnsentDrafts(
        input.caseId,
        "The interview arrangement was cancelled.",
      );
      this.connection
        .prepare("DELETE FROM reminders WHERE case_id = ? AND sent_at IS NULL")
        .run(input.caseId);
      this.setCaseStatus(input.caseId, "CANCELLED");
      this.addEvent(input.caseId, "INTERVIEW_CANCELLED", "USER", {
        reason: input.reason,
        previousSchedule: previousSchedule
          ? {
              date: previousSchedule.date,
              startTime: previousSchedule.startTime,
              endTime: previousSchedule.endTime,
              roomName: previousSchedule.roomName,
            }
          : null,
        cancelledDraftIds,
      });
    });

    return {
      interviewCase: this.getCase(input.caseId)!,
      previousSchedule,
      hadSentScheduleConfirmation,
      cancelledDraftIds,
    };
  }

  private hasSentScheduleConfirmation(caseId: string): boolean {
    const row = this.connection
      .prepare(
        `
          SELECT 1 AS found FROM message_drafts
          WHERE case_id = ? AND message_type = 'SCHEDULE_CONFIRMATION'
            AND status = 'SENT'
          LIMIT 1
        `,
      )
      .get(caseId) as SqlRow | undefined;
    return Boolean(row);
  }

  private cancelUnsentDrafts(caseId: string, reason: string): string[] {
    const drafts = this.connection
      .prepare(
        `
          SELECT id FROM message_drafts
          WHERE case_id = ? AND status IN ('DRAFT', 'APPROVED')
          ORDER BY created_at ASC
        `,
      )
      .all(caseId) as SqlRow[];
    for (const draft of drafts) {
      const draftId = asString(draft.id);
      this.connection
        .prepare("UPDATE message_drafts SET status = 'CANCELLED' WHERE id = ?")
        .run(draftId);
      this.addEvent(caseId, "DRAFT_CANCELLED", "SYSTEM", {
        draftId,
        reason,
      });
    }
    return drafts.map((draft) => asString(draft.id));
  }

  cancelRoomAllocation(caseId: string, allocationId: string): RoomAllocationRow {
    const row = this.connection
      .prepare("SELECT * FROM room_allocations WHERE id = ? AND case_id = ?")
      .get(allocationId, caseId) as SqlRow | undefined;
    if (!row) throw new Error("Room allocation not found for this case.");
    const allocation = toRoomAllocation(row);
    if (allocation.status === "CANCELLED") return allocation;
    const interviewCase = this.getCase(caseId);
    if (interviewCase?.scheduledRoomAllocationId && allocation.status === "ACTIVE") {
      throw new Error(
        "The room allocation is part of an internally confirmed schedule. Reopen the schedule before cancelling it.",
      );
    }
    const now = new Date().toISOString();
    this.connection
      .prepare(`
        UPDATE room_allocations
        SET status = 'CANCELLED', updated_at = ?
        WHERE id = ?
      `)
      .run(now, allocationId);
    this.addEvent(caseId, "ROOM_ALLOCATION_CANCELLED", "USER", { allocationId });
    return this.listRoomAllocations(caseId).find((item) => item.id === allocationId)!;
  }

  setCaseStatus(id: string, status: InterviewCaseStatus): void {
    const result = this.connection
      .prepare(`
        UPDATE interview_cases SET status = ?, updated_at = ? WHERE id = ?
      `)
      .run(status, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error(`Case not found: ${id}`);
  }

  holdInterviewCase(input: {
    caseId: string;
    decisionId?: string;
    reviewId?: string;
    note?: string;
  }): InterviewCaseRow {
    const interviewCase = this.getCase(input.caseId);
    if (!interviewCase) throw new Error(`Case not found: ${input.caseId}`);
    if (interviewCase.status === "ON_HOLD") return interviewCase;
    if (["CANCELLED", "CLOSED"].includes(interviewCase.status)) {
      throw new Error(`A closed case cannot be held: ${input.caseId}`);
    }
    const now = new Date().toISOString();
    this.connection
      .prepare(`
        UPDATE interview_cases SET status = 'ON_HOLD', updated_at = ? WHERE id = ?
      `)
      .run(now, input.caseId);
    this.addEvent(input.caseId, "INTERVIEW_ARRANGEMENT_HELD", "USER", {
      previousStatus: interviewCase.status,
      decisionId: input.decisionId ?? null,
      reviewId: input.reviewId ?? null,
      note: input.note?.trim() || null,
    });
    return this.getCase(input.caseId)!;
  }

  resumeHeldInterviewCase(caseId: string): {
    interviewCase: InterviewCaseRow;
    heldReviewId: string | null;
  } {
    const interviewCase = this.getCase(caseId);
    if (!interviewCase || interviewCase.status !== "ON_HOLD") {
      throw new Error(`Held case not found: ${caseId}`);
    }
    const row = this.connection
      .prepare(`
        SELECT detail_json FROM case_events
        WHERE case_id = ? AND event_type = 'INTERVIEW_ARRANGEMENT_HELD'
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(caseId) as SqlRow | undefined;
    const detail = row ? jsonRecord(asString(row.detail_json)) : null;
    const previousStatus = detail?.previousStatus;
    const restoredStatus = isInterviewCaseStatus(previousStatus) && previousStatus !== "ON_HOLD"
      ? previousStatus
      : "REVIEW_REQUIRED";
    const heldReviewId = nullableString(detail?.reviewId);
    this.connection
      .prepare(`
        UPDATE interview_cases SET status = ?, updated_at = ? WHERE id = ?
      `)
      .run(restoredStatus, new Date().toISOString(), caseId);
    this.addEvent(caseId, "INTERVIEW_ARRANGEMENT_RESUMED", "USER", {
      restoredStatus,
      heldReviewId,
    });
    return { interviewCase: this.getCase(caseId)!, heldReviewId };
  }

  setCaseDuration(id: string, durationMinutes: number): void {
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      throw new Error("durationMinutes must be a positive integer.");
    }
    this.connection
      .prepare(`
        UPDATE interview_cases
        SET duration_minutes = ?, updated_at = ? WHERE id = ?
      `)
      .run(durationMinutes, new Date().toISOString(), id);
    this.addEvent(id, "DURATION_CHANGED", "USER", { durationMinutes });
  }

  setCaseProposalDates(id: string, dates: string[]): void {
    if (
      dates.length === 0 ||
      dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))
    ) {
      throw new Error("At least one YYYY-MM-DD proposal date is required.");
    }
    this.connection
      .prepare(`
        UPDATE interview_cases
        SET proposal_dates_json = ?, updated_at = ? WHERE id = ?
      `)
      .run(JSON.stringify([...new Set(dates)].sort()), new Date().toISOString(), id);
    this.addEvent(id, "PROPOSAL_DATES_CHANGED", "USER", { dates });
  }

  upsertIdentityMapping(input: {
    ninehireUserId?: string;
    slackUserId: string;
    displayName?: string;
    email?: string;
  }): void {
    const now = new Date().toISOString();
    const existing = input.ninehireUserId
      ? (this.connection
          .prepare(
            "SELECT id FROM identity_mappings WHERE ninehire_user_id = ?",
          )
          .get(input.ninehireUserId) as SqlRow | undefined)
      : undefined;
    if (existing) {
      this.connection
        .prepare(`
          UPDATE identity_mappings
          SET slack_user_id = ?, display_name = ?, email = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.slackUserId,
          input.displayName ?? null,
          input.email ?? null,
          now,
          asString(existing.id),
        );
      return;
    }
    this.connection
      .prepare(`
        INSERT INTO identity_mappings(
          id, ninehire_user_id, slack_user_id, display_name, email,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        input.ninehireUserId ?? null,
        input.slackUserId,
        input.displayName ?? null,
        input.email ?? null,
        now,
        now,
      );
  }

  findIdentityByNinehireId(ninehireUserId: string): SqlRow | undefined {
    return this.connection
      .prepare(
        "SELECT * FROM identity_mappings WHERE ninehire_user_id = ?",
      )
      .get(ninehireUserId) as SqlRow | undefined;
  }

  addOrUpdateInterviewer(input: {
    caseId: string;
    ninehireUserId?: string;
    slackUserId?: string;
    displayName: string;
    email?: string;
    required?: boolean;
    source: "NINEHIRE" | "MANUAL";
  }): InterviewerRow {
    const now = new Date().toISOString();
    const existing = input.ninehireUserId
      ? (this.connection
          .prepare(`
            SELECT * FROM case_interviewers
            WHERE case_id = ? AND ninehire_user_id = ?
          `)
          .get(input.caseId, input.ninehireUserId) as SqlRow | undefined)
      : undefined;
    if (existing) {
      const existingStatus = asString(existing.status) as InterviewerStatus;
      const locallyExcluded = existingStatus === "EXCLUDED_BY_USER";
      const nextStatus =
        existingStatus === "EXCLUDED_UPSTREAM" ? "PENDING" : existingStatus;
      this.connection
        .prepare(`
          UPDATE case_interviewers
          SET slack_user_id = ?, display_name = ?, email = ?, required = ?,
              active = ?, source = ?, status = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.slackUserId ?? nullableString(existing.slack_user_id),
          input.displayName,
          input.email ?? nullableString(existing.email),
          input.required === false ? 0 : 1,
          locallyExcluded ? 0 : 1,
          input.source,
          nextStatus,
          now,
          asString(existing.id),
        );
      return this.getInterviewer(asString(existing.id))!;
    }

    const id = randomUUID();
    this.connection
      .prepare(`
        INSERT INTO case_interviewers(
          id, case_id, ninehire_user_id, slack_user_id, display_name, email,
          required, active, source, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'PENDING', ?, ?)
      `)
      .run(
        id,
        input.caseId,
        input.ninehireUserId ?? null,
        input.slackUserId ?? null,
        input.displayName,
        input.email ?? null,
        input.required === false ? 0 : 1,
        input.source,
        now,
        now,
      );
    this.addEvent(input.caseId, "INTERVIEWER_ADDED", "USER", {
      interviewerId: id,
      source: input.source,
    });
    return this.getInterviewer(id)!;
  }

  getInterviewer(id: string): InterviewerRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM case_interviewers WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? toInterviewer(row) : undefined;
  }

  findActiveInterviewerBySlackUser(
    caseId: string,
    slackUserId: string,
  ): InterviewerRow | undefined {
    const row = this.connection
      .prepare(`
        SELECT * FROM case_interviewers
        WHERE case_id = ? AND slack_user_id = ? AND active = 1
      `)
      .get(caseId, slackUserId) as SqlRow | undefined;
    return row ? toInterviewer(row) : undefined;
  }

  listInterviewers(caseId: string, activeOnly = true): InterviewerRow[] {
    const rows = this.connection
      .prepare(`
        SELECT * FROM case_interviewers
        WHERE case_id = ? ${activeOnly ? "AND active = 1" : ""}
        ORDER BY created_at ASC
      `)
      .all(caseId) as SqlRow[];
    return rows.map(toInterviewer);
  }

  deactivateMissingNinehireInterviewers(
    caseId: string,
    activeNinehireIds: string[],
  ): number {
    const current = this.listInterviewers(caseId).filter(
      (item) => item.source === "NINEHIRE" && item.ninehireUserId,
    );
    let changed = 0;
    for (const interviewer of current) {
      if (
        interviewer.ninehireUserId &&
        !activeNinehireIds.includes(interviewer.ninehireUserId)
      ) {
        this.connection
          .prepare(`
            UPDATE case_interviewers
            SET active = 0, status = 'EXCLUDED_UPSTREAM', updated_at = ?
            WHERE id = ? AND case_id = ?
          `)
          .run(new Date().toISOString(), interviewer.id, caseId);
        this.addEvent(caseId, "INTERVIEWER_REMOVED_UPSTREAM", "SYSTEM", {
          interviewerId: interviewer.id,
        });
        changed += 1;
      }
    }
    return changed;
  }

  excludeInterviewer(caseId: string, interviewerId: string): void {
    const result = this.connection
      .prepare(`
        UPDATE case_interviewers
        SET active = 0, status = 'EXCLUDED_BY_USER', updated_at = ?
        WHERE id = ? AND case_id = ?
      `)
      .run(new Date().toISOString(), interviewerId, caseId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Interviewer not found in case: ${interviewerId}`);
    }
    this.addEvent(caseId, "INTERVIEWER_EXCLUDED", "USER", { interviewerId });
    this.refreshCaseCollectionStatus(caseId);
  }

  setInterviewerRequired(
    caseId: string,
    interviewerId: string,
    required: boolean,
  ): void {
    const result = this.connection
      .prepare(`
        UPDATE case_interviewers
        SET required = ?, updated_at = ?
        WHERE id = ? AND case_id = ? AND active = 1
      `)
      .run(required ? 1 : 0, new Date().toISOString(), interviewerId, caseId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Active interviewer not found in case: ${interviewerId}`);
    }
    this.addEvent(caseId, "INTERVIEWER_REQUIREMENT_CHANGED", "USER", {
      interviewerId,
      required,
    });
    this.refreshCaseCollectionStatus(caseId);
  }

  markInterviewerDeclined(caseId: string, slackUserId: string): InterviewerRow {
    const interviewer = this.findActiveInterviewerBySlackUser(
      caseId,
      slackUserId,
    );
    if (!interviewer) throw new Error("This Slack user is not an interviewer.");
    if (interviewer.status === "DECLINED_PENDING_REVIEW") return interviewer;
    const now = new Date().toISOString();
    this.connection
      .prepare(`
        UPDATE case_interviewers
        SET status = 'DECLINED_PENDING_REVIEW', responded_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(now, now, interviewer.id);
    this.setCaseStatus(caseId, "REVIEW_REQUIRED");
    this.createReview({
      caseId,
      reviewType: "INTERVIEWER_DECLINED",
      reason: `${interviewer.displayName} marked this interview as unavailable.`,
    });
    this.addEvent(caseId, "INTERVIEWER_DECLINED", "SLACK_USER", {
      interviewerId: interviewer.id,
    });
    return this.getInterviewer(interviewer.id)!;
  }

  replaceAvailability(
    caseId: string,
    slackUserId: string,
    slots: TimeSlot[],
  ): InterviewerRow {
    const interviewer = this.findActiveInterviewerBySlackUser(
      caseId,
      slackUserId,
    );
    if (!interviewer) throw new Error("This Slack user is not an interviewer.");
    validateAvailabilitySlots(slots);
    this.transaction(() => {
      this.connection
        .prepare(
          "DELETE FROM availability_slots WHERE case_id = ? AND interviewer_id = ?",
        )
        .run(caseId, interviewer.id);
      const insert = this.connection.prepare(`
        INSERT INTO availability_slots(
          id, case_id, interviewer_id, date, start_time, end_time, submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const slot of slots) {
        insert.run(
          randomUUID(),
          caseId,
          interviewer.id,
          slot.date,
          slot.start,
          slot.end,
          now,
        );
      }
      this.connection
        .prepare(`
          UPDATE case_interviewers
          SET status = 'SUBMITTED', responded_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(now, now, interviewer.id);
    });
    this.refreshCaseCollectionStatus(caseId);
    this.addEvent(caseId, "AVAILABILITY_SUBMITTED", "SLACK_USER", {
      interviewerId: interviewer.id,
      slotCount: slots.length,
    });
    return this.getInterviewer(interviewer.id)!;
  }

  replaceAvailabilityForInterviewer(
    caseId: string,
    interviewerId: string,
    slots: TimeSlot[],
  ): InterviewerRow {
    const interviewer = this.getInterviewer(interviewerId);
    if (
      !interviewer ||
      interviewer.caseId !== caseId ||
      !interviewer.active
    ) {
      throw new Error("Active interviewer not found in this case.");
    }
    validateAvailabilitySlots(slots);
    this.transaction(() => {
      this.connection
        .prepare(
          "DELETE FROM availability_slots WHERE case_id = ? AND interviewer_id = ?",
        )
        .run(caseId, interviewerId);
      const insert = this.connection.prepare(`
        INSERT INTO availability_slots(
          id, case_id, interviewer_id, date, start_time, end_time, submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const slot of slots) {
        insert.run(
          randomUUID(),
          caseId,
          interviewerId,
          slot.date,
          slot.start,
          slot.end,
          now,
        );
      }
      this.connection
        .prepare(`
          UPDATE case_interviewers
          SET status = 'SUBMITTED', responded_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(now, now, interviewerId);
    });
    this.refreshCaseCollectionStatus(caseId);
    this.addEvent(caseId, "AVAILABILITY_MANUALLY_RECORDED", "USER", {
      interviewerId,
      slotCount: slots.length,
    });
    return this.getInterviewer(interviewerId)!;
  }

  refreshCaseCollectionStatus(caseId: string): void {
    const interviewCase = this.getCase(caseId);
    if (!interviewCase) throw new Error(`Case not found: ${caseId}`);
    if (
      ![
        "REQUEST_SENT",
        "COLLECTING_AVAILABILITY",
        "READY_TO_SCHEDULE",
        "REVIEW_REQUIRED",
      ].includes(interviewCase.status)
    ) {
      return;
    }
    const active = this.listInterviewers(caseId);
    const unresolved = active.filter(
      (item) => item.required && item.status !== "SUBMITTED",
    );
    this.setCaseStatus(
      caseId,
      unresolved.length === 0 ? "READY_TO_SCHEDULE" : "COLLECTING_AVAILABILITY",
    );
  }

  createDraft(input: {
    caseId: string;
    workflowReviewId?: string;
    channelId: string;
    previewText: string;
    blocksJson: string;
    payloadHash: string;
    messageType: DraftRow["messageType"];
  }): DraftRow {
    const existing = this.connection
      .prepare(`
        SELECT * FROM message_drafts
        WHERE case_id = ? AND payload_hash = ? AND message_type = ?
          AND workflow_review_id IS ?
          AND status IN ('DRAFT', 'APPROVED', 'SENDING', 'SENT')
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(
        input.caseId,
        input.payloadHash,
        input.messageType,
        input.workflowReviewId ?? null,
      ) as SqlRow | undefined;
    if (existing) return toDraft(existing);

    if (input.messageType === "INTERVIEWER_REQUEST") {
      const interviewCase = this.getCase(input.caseId);
      if (
        !interviewCase ||
        !["READY_FOR_DRAFT", "DRAFT_CREATED"].includes(interviewCase.status)
      ) {
        throw new Error(
          "Interviewer request drafts can only be created for cases ready to start scheduling.",
        );
      }
    }

    const id = randomUUID();
    this.connection
      .prepare(`
        INSERT INTO message_drafts(
          id, case_id, workflow_review_id, channel_id, preview_text, blocks_json, payload_hash,
          message_type, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)
      `)
      .run(
        id,
        input.caseId,
        input.workflowReviewId ?? null,
        input.channelId,
        input.previewText,
        input.blocksJson,
        input.payloadHash,
        input.messageType,
        new Date().toISOString(),
      );
    if (input.messageType === "INTERVIEWER_REQUEST") {
      this.setCaseStatus(input.caseId, "DRAFT_CREATED");
    }
    this.addEvent(input.caseId, "DRAFT_CREATED", "USER", {
      draftId: id,
      messageType: input.messageType,
    });
    return this.getDraft(id)!;
  }

  getDraft(id: string): DraftRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM message_drafts WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? toDraft(row) : undefined;
  }

  findActiveDraftByWorkflowReviewId(
    workflowReviewId: string,
    messageType: DraftRow["messageType"],
  ): DraftRow | undefined {
    const row = this.connection
      .prepare(`
        SELECT * FROM message_drafts
        WHERE workflow_review_id = ? AND message_type = ?
          AND status IN ('DRAFT', 'APPROVED', 'SENDING', 'SENT')
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(workflowReviewId, messageType) as SqlRow | undefined;
    return row ? toDraft(row) : undefined;
  }

  replacePendingDraftText(input: {
    draftId: string;
    previewText: string;
    blocksJson: string;
    payloadHash: string;
  }): DraftRow {
    const draft = this.getDraft(input.draftId);
    if (!draft || draft.status !== "DRAFT") {
      throw new Error(`Draft is not editable: ${input.draftId}`);
    }
    const updated = this.connection
      .prepare(
        `
          UPDATE message_drafts
          SET preview_text = ?, blocks_json = ?, payload_hash = ?
          WHERE id = ? AND status = 'DRAFT'
        `,
      )
      .run(input.previewText, input.blocksJson, input.payloadHash, input.draftId);
    if (Number(updated.changes) !== 1) {
      throw new Error(`Draft is not editable: ${input.draftId}`);
    }
    this.addEvent(draft.caseId, "DRAFT_TEXT_REVISED", "USER", {
      draftId: draft.id,
    });
    return this.getDraft(input.draftId)!;
  }

  listDrafts(status: DraftRow["status"] = "DRAFT"): DraftRow[] {
    return (
      this.connection
        .prepare(`
          SELECT * FROM message_drafts
          WHERE status = ? ORDER BY created_at ASC
        `)
        .all(status) as SqlRow[]
    ).map(toDraft);
  }

  approveDraft(id: string): DraftRow {
    const now = new Date();
    const result = this.connection
      .prepare(`
        UPDATE message_drafts
        SET status = 'APPROVED', approved_at = ?
        WHERE id = ? AND status = 'DRAFT'
      `)
      .run(new Date().toISOString(), id);
    if (Number(result.changes) !== 1) {
      const existing = this.getDraft(id);
      if (existing?.status === "SENT") return existing;
      if (existing?.status === "APPROVED") return existing;
      if (existing?.status === "SENDING") {
        const startedAt = existing.sendingStartedAt
          ? Date.parse(existing.sendingStartedAt)
          : Number.NaN;
        if (!Number.isFinite(startedAt) || now.getTime() - startedAt >= DRAFT_SEND_LEASE_MS) {
          this.connection
            .prepare(`
              UPDATE message_drafts
              SET status = 'APPROVED', sending_started_at = NULL
              WHERE id = ? AND status = 'SENDING'
            `)
            .run(id);
          return this.getDraft(id)!;
        }
        throw new Error("Draft is currently being sent by another operation.");
      }
      throw new Error(`Draft is not awaiting approval: ${id}`);
    }
    return this.getDraft(id)!;
  }

  claimDraftForSending(id: string, now = new Date()): DraftRow | undefined {
    const draft = this.getDraft(id);
    if (!draft) throw new Error(`Draft not found: ${id}`);
    if (draft.status === "SENT") return draft;
    if (draft.status === "SENDING") {
      const startedAt = draft.sendingStartedAt
        ? Date.parse(draft.sendingStartedAt)
        : Number.NaN;
      if (
        Number.isFinite(startedAt) &&
        now.getTime() - startedAt < DRAFT_SEND_LEASE_MS
      ) {
        return undefined;
      }
      this.connection
        .prepare(`
          UPDATE message_drafts
          SET status = 'APPROVED', sending_started_at = NULL
          WHERE id = ? AND status = 'SENDING'
        `)
        .run(id);
    }
    const result = this.connection
      .prepare(`
        UPDATE message_drafts
        SET status = 'SENDING', sending_started_at = ?
        WHERE id = ? AND status = 'APPROVED'
      `)
      .run(now.toISOString(), id);
    return Number(result.changes) === 1 ? this.getDraft(id)! : undefined;
  }

  resetDraftSending(id: string): DraftRow {
    const result = this.connection
      .prepare(`
        UPDATE message_drafts
        SET status = 'APPROVED', sending_started_at = NULL
        WHERE id = ? AND status = 'SENDING'
      `)
      .run(id);
    if (Number(result.changes) !== 1) {
      const draft = this.getDraft(id);
      if (draft?.status === "APPROVED" || draft?.status === "SENT") return draft;
      throw new Error(`Draft is not being sent: ${id}`);
    }
    return this.getDraft(id)!;
  }

  cancelDraft(id: string, reason: string): DraftRow {
    const draft = this.getDraft(id);
    if (!draft) throw new Error(`Draft not found: ${id}`);
    if (draft.status === "SENT") {
      throw new Error("A sent draft cannot be cancelled.");
    }
    if (draft.status === "SENDING") {
      throw new Error("A draft being sent cannot be cancelled.");
    }
    this.connection
      .prepare(`
        UPDATE message_drafts SET status = 'CANCELLED' WHERE id = ?
      `)
      .run(id);
    this.addEvent(draft.caseId, "DRAFT_CANCELLED", "SYSTEM", {
      draftId: id,
      reason,
    });
    return this.getDraft(id)!;
  }

  markDraftSent(id: string, slackMessageTs: string, sentAt = new Date()): DraftRow {
    const draft = this.getDraft(id);
    if (!draft) throw new Error(`Draft not found: ${id}`);
    if (draft.status === "SENT") return draft;
    if (draft.status !== "APPROVED" && draft.status !== "SENDING") {
      throw new Error(`Draft must be approved before sending: ${id}`);
    }
    this.transaction(() => {
      this.connection
        .prepare(`
          UPDATE message_drafts
          SET status = 'SENT', sending_started_at = NULL, sent_at = ?, slack_message_ts = ?
          WHERE id = ? AND status IN ('APPROVED', 'SENDING')
        `)
        .run(sentAt.toISOString(), slackMessageTs, id);
      if (draft.messageType === "INTERVIEWER_REQUEST") {
        this.setCaseStatus(draft.caseId, "COLLECTING_AVAILABILITY");
        this.scheduleReminders(draft.caseId, sentAt);
        this.addEvent(draft.caseId, "REQUEST_SENT", "USER", {
          draftId: id,
          slackMessageTs,
        });
      } else if (draft.messageType === "SCHEDULE_CONFIRMATION") {
        this.addEvent(draft.caseId, "SCHEDULE_CONFIRMATION_SENT", "USER", {
          draftId: id,
          slackMessageTs,
        });
      } else if (draft.messageType === "AVAILABILITY_RECOVERY") {
        if (draft.workflowReviewId) {
          this.connection
            .prepare(`
              UPDATE workflow_reviews
              SET status = 'RESOLVED', resolution = 'AVAILABILITY_RECOVERY_SENT', resolved_at = ?
              WHERE id = ? AND status = 'OPEN'
            `)
            .run(new Date().toISOString(), draft.workflowReviewId);
        }
        this.addEvent(draft.caseId, "AVAILABILITY_RECOVERY_SENT", "USER", {
          draftId: id,
          slackMessageTs,
          workflowReviewId: draft.workflowReviewId,
        });
      } else {
        this.addEvent(draft.caseId, "SCHEDULE_UPDATE_SENT", "USER", {
          draftId: id,
          slackMessageTs,
          messageType: draft.messageType,
        });
      }
    });
    return this.getDraft(id)!;
  }

  private scheduleReminders(caseId: string, sentAt: Date): void {
    const first = firstReminderAt(sentAt);
    const second = secondReminderAt(sentAt, first);
    const insert = this.connection.prepare(`
      INSERT OR IGNORE INTO reminders(
        id, case_id, interviewer_id, reminder_number, due_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const interviewer of this.listInterviewers(caseId)) {
      if (interviewer.status !== "PENDING") continue;
      insert.run(
        randomUUID(),
        caseId,
        interviewer.id,
        1,
        first.toISOString(),
      );
      insert.run(
        randomUUID(),
        caseId,
        interviewer.id,
        2,
        second.toISOString(),
      );
    }
  }

  listDueReminders(now = new Date()): Array<{
    id: string;
    caseId: string;
    interviewerId: string;
    reminderNumber: number;
    dueAt: string;
    slackUserId: string;
    displayName: string;
  }> {
    const rows = this.connection
      .prepare(`
        SELECT r.*, i.slack_user_id, i.display_name
        FROM reminders r
        JOIN case_interviewers i ON i.id = r.interviewer_id
        JOIN interview_cases c ON c.id = r.case_id
        WHERE r.sent_at IS NULL
          AND r.due_at <= ?
          AND i.active = 1
          AND i.status = 'PENDING'
          AND i.slack_user_id IS NOT NULL
          AND c.status IN ('REQUEST_SENT', 'COLLECTING_AVAILABILITY')
        ORDER BY r.due_at ASC
      `)
      .all(now.toISOString()) as SqlRow[];
    return rows.map((row) => ({
      id: asString(row.id),
      caseId: asString(row.case_id),
      interviewerId: asString(row.interviewer_id),
      reminderNumber: Number(row.reminder_number),
      dueAt: asString(row.due_at),
      slackUserId: asString(row.slack_user_id),
      displayName: asString(row.display_name),
    }));
  }

  claimReminder(
    id: string,
    now = new Date(),
    leaseDurationMs = 120_000,
  ): boolean {
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - leaseDurationMs).toISOString();
    const result = this.connection
      .prepare(`
        UPDATE reminders
        SET sending_started_at = ?
        WHERE id = ?
          AND sent_at IS NULL
          AND (sending_started_at IS NULL OR sending_started_at <= ?)
          AND EXISTS (
            SELECT 1
            FROM case_interviewers AS interviewer
            JOIN interview_cases AS interview_case ON interview_case.id = reminders.case_id
            WHERE interviewer.id = reminders.interviewer_id
              AND interviewer.active = 1
              AND interviewer.status = 'PENDING'
              AND interview_case.status IN ('REQUEST_SENT', 'COLLECTING_AVAILABILITY')
          )
      `)
      .run(nowIso, id, staleBefore);
    return result.changes === 1;
  }

  releaseReminder(id: string): void {
    this.connection
      .prepare(
        "UPDATE reminders SET sending_started_at = NULL WHERE id = ? AND sent_at IS NULL",
      )
      .run(id);
  }

  markReminderSent(id: string): void {
    const row = this.connection
      .prepare("SELECT * FROM reminders WHERE id = ?")
      .get(id) as SqlRow | undefined;
    if (!row) throw new Error(`Reminder not found: ${id}`);
    const updated = this.connection
      .prepare(
        "UPDATE reminders SET sent_at = ?, sending_started_at = NULL WHERE id = ? AND sent_at IS NULL",
      )
      .run(new Date().toISOString(), id);
    if (updated.changes === 0) return;
    if (Number(row.reminder_number) === 2) {
      const caseId = asString(row.case_id);
      this.createReview({
        caseId,
        reviewType: "INTERVIEWER_NO_RESPONSE",
        reason:
          "The interviewer has not responded after the configured two reminders.",
      });
      this.setCaseStatus(caseId, "REVIEW_REQUIRED");
    }
  }

  getCursor(key: string): string | undefined {
    const row = this.connection
      .prepare("SELECT cursor_value FROM sync_cursors WHERE cursor_key = ?")
      .get(key) as SqlRow | undefined;
    return row ? asString(row.cursor_value) : undefined;
  }

  getCursorInfo(key: string): { value: string; updatedAt: string } | undefined {
    const row = this.connection
      .prepare("SELECT cursor_value, updated_at FROM sync_cursors WHERE cursor_key = ?")
      .get(key) as SqlRow | undefined;
    return row
      ? { value: asString(row.cursor_value), updatedAt: asString(row.updated_at) }
      : undefined;
  }

  getLatestMeetingRoomSyncAt(): string | undefined {
    const row = this.connection
      .prepare("SELECT MAX(synced_at) AS synced_at FROM meeting_room_sync_dates")
      .get() as SqlRow;
    return nullableString(row.synced_at) ?? undefined;
  }

  getLatestSchemaVersion(): number {
    const row = this.connection
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as SqlRow;
    return Number(row.version ?? 0);
  }

  setCursor(key: string, value: string): void {
    this.connection
      .prepare(`
        INSERT INTO sync_cursors(cursor_key, cursor_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(cursor_key) DO UPDATE SET
          cursor_value = excluded.cursor_value,
          updated_at = excluded.updated_at
      `)
      .run(key, value, new Date().toISOString());
  }

  addEvent(
    caseId: string | undefined,
    eventType: string,
    actor: string,
    detail: Record<string, unknown>,
  ): void {
    this.connection
      .prepare(`
        INSERT INTO case_events(
          id, case_id, event_type, actor, detail_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        caseId ?? null,
        eventType,
        actor,
        JSON.stringify(detail),
        new Date().toISOString(),
      );
  }
}
