// 로컬 DB 일별 백업과 보관 개수를 검증한다.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeDatabase } from "../src/db/database.js";
import { LocalDatabaseBackupService } from "../src/services/database-backup.js";

let db: BridgeDatabase | undefined;
let temporaryDirectory: string | undefined;

afterEach(async () => {
  db?.close();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  db = undefined;
  temporaryDirectory = undefined;
});

describe("LocalDatabaseBackupService", () => {
  it("creates one backup per day and retains only the newest 14 backups", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "interview-bridge-backup-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    db = new BridgeDatabase(databasePath);
    db.createInterviewCase({
      candidateName: "Candidate",
      recruitmentRef: "R1",
      proposalDates: ["2026-08-01"],
    });
    const service = new LocalDatabaseBackupService(db, databasePath, {
      timeZone: "UTC",
    });

    const first = await service.ensureDailyBackup(new Date("2026-08-01T12:00:00Z"));
    const duplicate = await service.ensureDailyBackup(new Date("2026-08-01T18:00:00Z"));

    expect(first).toMatchObject({
      created: true,
      retainedBackupCount: 1,
    });
    expect(duplicate).toMatchObject({
      created: false,
      retainedBackupCount: 1,
    });

    for (let day = 2; day <= 15; day += 1) {
      await service.ensureDailyBackup(new Date(`2026-08-${String(day).padStart(2, "0")}T12:00:00Z`));
    }

    const backupNames = await readdir(join(temporaryDirectory, "backups"));
    expect(backupNames).toHaveLength(14);
    expect(backupNames).not.toContain("bridge-2026-08-01.db");
    expect(backupNames).toContain("bridge-2026-08-15.db");

    const restored = new BridgeDatabase(join(temporaryDirectory, "backups", "bridge-2026-08-15.db"));
    expect(restored.listCases()).toHaveLength(1);
    restored.close();
  });
});
