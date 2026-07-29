// 현재 로컬 운영 DB의 일별 백업을 수동으로 생성한다.
import { getConfig } from "../config.js";
import { BridgeDatabase } from "../db/database.js";
import { LocalDatabaseBackupService } from "../services/database-backup.js";

const config = getConfig();
const db = new BridgeDatabase(config.dbPath);
const backup = new LocalDatabaseBackupService(db, config.dbPath, {
  timeZone: config.timeZone,
});

try {
  const result = await backup.ensureDailyBackup();
  process.stdout.write(
    `${result.created ? "Created" : "Already exists"} database backup: ${result.backupPath}\n`,
  );
} finally {
  db.close();
}
