import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  InterviewCaseStatus,
  InterviewerStatus,
  SlackNotificationInput,
  TimeSlot,
} from "../domain/types.js";
import { firstReminderAt, secondReminderAt } from "../domain/calendar.js";

type SqlRow = Record<string, unknown>;

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
  status: "DRAFT" | "APPROVED" | "SENT" | "CANCELLED";
  approvedAt: string | null;
  sentAt: string | null;
  slackMessageTs: string | null;
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

export interface CaseBundle {
  interviewCase: InterviewCaseRow;
  interviewers: InterviewerRow[];
  availability: Array<TimeSlot & { interviewerId: string }>;
  drafts: DraftRow[];
}

function asString(value: unknown): string {
  return String(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
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
    status: asString(row.status) as DraftRow["status"],
    approvedAt: nullableString(row.approved_at),
    sentAt: nullableString(row.sent_at),
    slackMessageTs: nullableString(row.slack_message_ts),
    createdAt: asString(row.created_at),
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
        channel_id TEXT NOT NULL,
        preview_text TEXT NOT NULL,
        blocks_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_at TEXT,
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

      CREATE TABLE IF NOT EXISTS sync_cursors (
        cursor_key TEXT PRIMARY KEY,
        cursor_value TEXT NOT NULL,
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
        "SELECT COUNT(*) AS count FROM interview_cases WHERE status != 'CLOSED'",
      ),
      pendingDrafts: scalar(
        "SELECT COUNT(*) AS count FROM message_drafts WHERE status = 'DRAFT'",
      ),
      pendingInterviewers: scalar(
        "SELECT COUNT(*) AS count FROM case_interviewers WHERE active = 1 AND status = 'PENDING'",
      ),
    };
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

  createReview(input: {
    notificationId?: string;
    caseId?: string;
    reviewType: string;
    reason: string;
    summary?: Record<string, unknown>;
  }): string {
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

  getReview(id: string): ReviewRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM workflow_reviews WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? toReview(row) : undefined;
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

  createInterviewCase(input: {
    notificationId?: string;
    candidateRef?: string;
    candidateName?: string;
    recruitmentRef?: string;
    recruitmentName?: string;
    durationMinutes?: number;
    proposalDates: string[];
  }): InterviewCaseRow {
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
        JSON.stringify(input.proposalDates),
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

  getCase(id: string): InterviewCaseRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM interview_cases WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? toCase(row) : undefined;
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

  setCaseStatus(id: string, status: InterviewCaseStatus): void {
    const result = this.connection
      .prepare(`
        UPDATE interview_cases SET status = ?, updated_at = ? WHERE id = ?
      `)
      .run(status, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error(`Case not found: ${id}`);
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
    for (const slot of slots) {
      if (
        !/^\d{2}:\d{2}$/.test(slot.start) ||
        !/^\d{2}:\d{2}$/.test(slot.end) ||
        slot.start >= slot.end
      ) {
        throw new Error(
          `Invalid availability range: ${slot.date} ${slot.start}-${slot.end}`,
        );
      }
    }
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
    channelId: string;
    previewText: string;
    blocksJson: string;
    payloadHash: string;
  }): DraftRow {
    const existing = this.connection
      .prepare(`
        SELECT * FROM message_drafts
        WHERE case_id = ? AND payload_hash = ?
          AND status IN ('DRAFT', 'APPROVED', 'SENT')
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(input.caseId, input.payloadHash) as SqlRow | undefined;
    if (existing) return toDraft(existing);

    const id = randomUUID();
    this.connection
      .prepare(`
        INSERT INTO message_drafts(
          id, case_id, channel_id, preview_text, blocks_json, payload_hash,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?)
      `)
      .run(
        id,
        input.caseId,
        input.channelId,
        input.previewText,
        input.blocksJson,
        input.payloadHash,
        new Date().toISOString(),
      );
    this.setCaseStatus(input.caseId, "DRAFT_CREATED");
    this.addEvent(input.caseId, "DRAFT_CREATED", "USER", { draftId: id });
    return this.getDraft(id)!;
  }

  getDraft(id: string): DraftRow | undefined {
    const row = this.connection
      .prepare("SELECT * FROM message_drafts WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? toDraft(row) : undefined;
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
    const result = this.connection
      .prepare(`
        UPDATE message_drafts
        SET status = 'APPROVED', approved_at = ?
        WHERE id = ? AND status = 'DRAFT'
      `)
      .run(new Date().toISOString(), id);
    if (Number(result.changes) !== 1) {
      const existing = this.getDraft(id);
      if (existing?.status === "APPROVED") return existing;
      throw new Error(`Draft is not awaiting approval: ${id}`);
    }
    return this.getDraft(id)!;
  }

  cancelDraft(id: string, reason: string): DraftRow {
    const draft = this.getDraft(id);
    if (!draft) throw new Error(`Draft not found: ${id}`);
    if (draft.status === "SENT") {
      throw new Error("A sent draft cannot be cancelled.");
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
    if (draft.status !== "APPROVED") {
      throw new Error(`Draft must be approved before sending: ${id}`);
    }
    this.transaction(() => {
      this.connection
        .prepare(`
          UPDATE message_drafts
          SET status = 'SENT', sent_at = ?, slack_message_ts = ?
          WHERE id = ?
        `)
        .run(sentAt.toISOString(), slackMessageTs, id);
      this.setCaseStatus(draft.caseId, "COLLECTING_AVAILABILITY");
      this.scheduleReminders(draft.caseId, sentAt);
      this.addEvent(draft.caseId, "REQUEST_SENT", "USER", {
        draftId: id,
        slackMessageTs,
      });
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
        WHERE r.sent_at IS NULL
          AND r.due_at <= ?
          AND i.active = 1
          AND i.status = 'PENDING'
          AND i.slack_user_id IS NOT NULL
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

  markReminderSent(id: string): void {
    const row = this.connection
      .prepare("SELECT * FROM reminders WHERE id = ?")
      .get(id) as SqlRow | undefined;
    if (!row) throw new Error(`Reminder not found: ${id}`);
    this.connection
      .prepare("UPDATE reminders SET sent_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
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
