// 설치 업데이트 전 기존 SQLite DB의 안전한 스냅샷을 생성한다.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const [databaseArgument, backupDirectoryArgument] = process.argv.slice(2);

if (!databaseArgument || !backupDirectoryArgument) {
  throw new Error("DB 경로와 백업 폴더 경로가 필요합니다.");
}

const databasePath = resolve(databaseArgument);
const backupDirectory = resolve(backupDirectoryArgument);

if (!existsSync(databasePath)) {
  throw new Error(`기존 DB를 찾지 못했습니다. ${databasePath}`);
}

mkdirSync(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const backupPath = resolve(backupDirectory, `bridge-pre-update-${timestamp}.db`);
const quotedBackupPath = backupPath.replaceAll("'", "''");
const database = new DatabaseSync(databasePath);

try {
  database.exec(`VACUUM INTO '${quotedBackupPath}'`);
} finally {
  database.close();
}

process.stdout.write(`${backupPath}\n`);
