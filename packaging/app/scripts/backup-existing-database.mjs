// 설치 업데이트 전 기존 SQLite DB의 안전한 스냅샷을 생성한다.
import { backup, DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [databaseArgument, backupDirectoryArgument] = process.argv.slice(2);

if (!databaseArgument || !backupDirectoryArgument) {
  throw new Error("DB 경로와 백업 폴더 경로가 필요합니다.");
}

const databasePath = resolve(databaseArgument);
const backupDirectory = resolve(backupDirectoryArgument);

// 설치 EXE의 임시 폴더가 아니라 전달받은 영구 설치 경로를 사용한다.
mkdirSync(dirname(databasePath), { recursive: true });

if (!existsSync(databasePath)) {
  throw new Error(`기존 DB를 찾지 못했습니다. ${databasePath}`);
}

if (!statSync(databasePath).isFile()) {
  throw new Error(`기존 DB 경로가 파일이 아닙니다. ${databasePath}`);
}

mkdirSync(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const backupPath = resolve(backupDirectory, `bridge-pre-update-${timestamp}.db`);
let database;

try {
  database = new DatabaseSync(databasePath);
  await backup(database, backupPath);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(`기존 운영 DB를 열거나 백업하지 못했습니다. 경로: ${databasePath}. 원인: ${reason}`);
} finally {
  database?.close();
}

process.stdout.write(`${backupPath}\n`);
