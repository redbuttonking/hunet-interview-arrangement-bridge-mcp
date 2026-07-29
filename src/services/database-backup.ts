// 로컬 운영 DB를 안전하게 백업하고 오래된 일별 백업을 정리한다.
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export interface DatabaseBackupSource {
  backupTo(path: string): Promise<number>;
}

export interface DatabaseBackupResult {
  backupPath: string;
  created: boolean;
  pageCount?: number;
  removedPaths: string[];
  retainedBackupCount: number;
}

export interface LocalDatabaseBackupOptions {
  directory?: string;
  retentionCount?: number;
  timeZone?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dateKey(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((item) => item.type === type)?.value;
    if (!value) throw new Error(`Unable to format backup date part: ${type}`);
    return value;
  };

  return `${part("year")}-${part("month")}-${part("day")}`;
}

export class LocalDatabaseBackupService {
  private readonly directory: string;
  private readonly retentionCount: number;
  private readonly timeZone: string;
  private readonly databaseName: string;

  constructor(
    private readonly database: DatabaseBackupSource,
    databasePath: string,
    options: LocalDatabaseBackupOptions = {},
  ) {
    this.directory = options.directory ?? join(dirname(databasePath), "backups");
    this.retentionCount = options.retentionCount ?? 14;
    this.timeZone = options.timeZone ?? "Asia/Seoul";
    this.databaseName = basename(databasePath, extname(databasePath));
    if (this.retentionCount < 1 || !Number.isInteger(this.retentionCount)) {
      throw new Error("Backup retention count must be a positive integer.");
    }
  }

  async ensureDailyBackup(now = new Date()): Promise<DatabaseBackupResult> {
    await mkdir(this.directory, { recursive: true });
    const filePattern = new RegExp(
      `^${escapeRegExp(this.databaseName)}-\\d{4}-\\d{2}-\\d{2}\\.db$`,
    );
    const entries = await readdir(this.directory, { withFileTypes: true });
    const backupNames = entries
      .filter((entry) => entry.isFile() && filePattern.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const todayName = `${this.databaseName}-${dateKey(now, this.timeZone)}.db`;
    const backupPath = join(this.directory, todayName);
    let pageCount: number | undefined;
    let created = false;

    if (!backupNames.includes(todayName)) {
      pageCount = await this.database.backupTo(backupPath);
      backupNames.push(todayName);
      backupNames.sort();
      created = true;
    }

    const expiredNames = backupNames.slice(
      0,
      Math.max(0, backupNames.length - this.retentionCount),
    );
    const removedPaths = expiredNames.map((name) => join(this.directory, name));
    await Promise.all(removedPaths.map((path) => rm(path, { force: true })));

    return {
      backupPath,
      created,
      ...(pageCount === undefined ? {} : { pageCount }),
      removedPaths,
      retainedBackupCount: backupNames.length - expiredNames.length,
    };
  }
}
