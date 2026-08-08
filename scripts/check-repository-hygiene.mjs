// 추적 중인 파일에 로컬 비밀값과 운영 데이터가 포함되지 않았는지 점검한다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const forbiddenNames = [
  /^\.env(?:\..+)?$/u,
  /^data\/.*\.(?:db|sqlite)(?:-(?:wal|shm))?$/u,
  /^data\/backups\//u,
  /(?:^|\/)(?:.*\.(?:log|err|out))$/u,
];
const forbiddenFiles = trackedFiles.filter((file) =>
  file !== ".env.example" && forbiddenNames.some((pattern) => pattern.test(file)),
);

const inspectExtensions = new Set([
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
  ".md",
]);
const secretPatterns = [
  /\bxox[abpr]-[A-Za-z0-9-]{20,}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
];
const leakedSecrets = new Set();

function scanContents(file, contents, source) {
  const lines = contents.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (secretPatterns.some((pattern) => pattern.test(line))) {
      leakedSecrets.add(`${file}:${index + 1} (${source})`);
    }
  });
}

for (const file of trackedFiles) {
  const extension = file.includes(".") ? `.${file.split(".").pop()}` : "";
  if (!inspectExtensions.has(extension)) continue;
  if (existsSync(resolve(file))) {
    scanContents(file, readFileSync(resolve(file), "utf8"), "working tree");
  }
  try {
    const staged = execFileSync("git", [`show`, `:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    scanContents(file, staged, "index");
  } catch {
    // 파일이 아직 인덱스에 없거나 삭제된 경우에는 작업 트리만 검사한다.
  }
}

if (forbiddenFiles.length > 0 || leakedSecrets.length > 0) {
  if (forbiddenFiles.length > 0) {
    console.error("추적되면 안 되는 운영 파일:");
    forbiddenFiles.forEach((file) => console.error(`- ${file}`));
  }
  if (leakedSecrets.length > 0) {
    console.error("비밀값으로 보이는 패턴:");
    [...leakedSecrets].forEach((location) => console.error(`- ${location}`));
  }
  process.exitCode = 1;
  process.exit();
}

console.log(`저장소 민감정보 점검 통과: 추적 파일 ${trackedFiles.length}개`);
