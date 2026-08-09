// 후보자와 회의실의 로컬 운영 데이터를 안전하게 초기화한다.
import { getConfig } from "../config.js";
import { BridgeDatabase } from "../db/database.js";

if (!process.argv.includes("--confirm")) {
  throw new Error("초기화하려면 --confirm 옵션이 필요합니다.");
}

const config = getConfig();
const database = new BridgeDatabase(config.dbPath);
try {
  const result = database.clearOperationalData();
  const deletedCount = Object.values(result.deleted).reduce((total, count) => total + count, 0);
  process.stdout.write(`초기화 완료. 삭제 ${deletedCount}건, 보존한 Slack 읽기 위치 ${result.retainedSlackCursorCount}건\n`);
} finally {
  database.close();
}
