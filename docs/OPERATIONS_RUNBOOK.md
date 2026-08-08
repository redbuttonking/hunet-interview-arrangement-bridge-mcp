<!-- 인터뷰 어레인지 브리지의 로컬 운영·복구 절차를 설명한다. -->
# 인터뷰 어레인지 운영 런북

이 문서는 한 대의 Windows PC에서 파일럿 워커, MCP 서버, 로컬 대시보드를 운영할 때 사용하는 절차입니다. 실제 Slack·나인하이어 발송이나 다우오피스 변경은 이 문서만으로 자동 실행하지 않고, 기존 승인 절차를 지킵니다.

## 구성요소별 역할

| 구성요소 | 실행 주체 | 역할 | 종료되어도 유지되는 것 |
|---|---|---|---|
| 워커 | 작업 스케줄러 또는 `start:worker` | Slack Socket Mode, 5분 재조회, 리마인드, 외부 조회 재시도 | SQLite 상태와 이벤트 이력 |
| MCP 서버 | Codex가 stdio로 시작 | Codex 요청을 로컬 DB·외부 어댑터로 전달 | 워커가 저장한 상태 |
| 대시보드 | `start:dashboard` | 상태 확인, 사용자 결정, 초안 승인 | 워커 수신과 동기화 |
| 다우오피스 브라우저 | 전용 Edge 프로필 | 회의실 예약을 읽기 전용으로 조회 | 다우오피스의 실제 예약 |

대시보드를 닫아도 워커는 계속 실행되어야 합니다. 반대로 Codex를 종료해도 워커가 저장한 이벤트와 로컬 상태는 유지됩니다.

## 최초 설치

```powershell
cd C:\Users\user\Desktop\codex-mcp
npm install
npm run build
npm test
npm run check:repo
```

실제 토큰은 `.env`에만 저장합니다. `.env`, `data/bridge.db`, `data/backups`, 로그 파일은 Git이나 개인 클라우드 동기화 폴더에 넣지 않습니다.

## 워커 시작·중지·상태 확인

빌드 결과를 사용하는 운영 명령은 다음과 같습니다.

```powershell
npm run build
npm run start:worker
```

로그인할 때 자동 시작하려면 관리자 권한이 아닌 일반 사용자 작업으로 다음을 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage-worker-task.ps1 -Action Install
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage-worker-task.ps1 -Action Status
```

운영 중에는 다음으로 재시작하거나 중지합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage-worker-task.ps1 -Action Restart
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage-worker-task.ps1 -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage-worker-task.ps1 -Action Start
```

작업을 완전히 해제해야 할 때만 다음 명령을 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage-worker-task.ps1 -Action Remove
```

`Status`의 작업 스케줄러 상태만으로 정상 여부를 판단하지 않습니다. 대시보드 또는 `bridge_status`에서 heartbeat, 마지막 성공 주기, 실패 재시도 대기열을 함께 확인해야 합니다.

## 워커 장애 복구

1. `Status`와 대시보드의 워커 상태에서 마지막 heartbeat와 마지막 성공 동기화 시각을 확인합니다.
2. 워커가 중복 실행 중이면 작업 스케줄러의 동일 작업만 남기고, 별도 터미널에서 실행한 `start:worker`를 종료합니다.
3. 복구 전 현재 DB를 백업합니다.

   ```powershell
   npm run backup:db
   ```

4. 워커를 `Restart`합니다.
5. 재시작 후 Slack 마지막 커서 이후 메시지 재조회와 나인하이어 일정 재조회를 수행합니다. 워커 중단 구간에서 필수 면접관 제출이 누락된 경우에는 자동 발송하지 않고 대시보드 검토 건에서 재제출 초안을 승인합니다.
6. 실패 재시도 작업이 남아 있으면 원인과 대상을 확인합니다. 복구가 가능하다고 판단한 작업만 `retry_integration_job` 또는 대시보드의 `재시도 승인`으로 다음 워커 주기에 다시 넣습니다. 이 작업은 외부 메시지를 즉시 발송하지 않습니다.

DB를 복구할 때는 실행 중인 워커를 먼저 중지하고 백업 파일을 별도 복구 폴더에 복사해 내용을 검증합니다. 검증하지 않은 백업으로 `data/bridge.db`를 덮어쓰지 않습니다.

## 대시보드와 MCP 실행

```powershell
npm run build:dashboard
npm run start:dashboard
```

브라우저 주소는 `http://127.0.0.1:3100`입니다. 개발 중 `dev:dashboard`를 실행한 상태에서 별도의 `npm run build`로 `.next`를 덮어쓰지 않습니다. 그런 경우 CSS·JavaScript 번들이 서로 다른 빌드 결과를 가리켜 화면이 깨질 수 있습니다.

Codex의 `interview_bridge`는 `.codex/config.toml`의 stdio 설정으로 연결합니다. MCP 서버가 연결되지 않으면 먼저 `npm run build`를 실행하고, Codex 세션을 다시 시작한 뒤 도구 목록과 `bridge_status`를 확인합니다.

`.codex/config.toml`은 PC별 Codex 설정이므로 Git에 포함하지 않습니다. 프로젝트를 다른 PC로 옮기면 `cwd`와 빌드 결과 경로를 새 PC에 맞게 다시 설정합니다. 기본 시작 제한시간은 30초, 도구 호출 제한시간은 120초로 두며 외부 연동이 느리다는 이유로 무제한 시간으로 설정하지 않습니다.

## 스킬과 사용자 승인 경계

인터뷰 업무 스킬은 반복 작업의 순서를 안내할 뿐 외부 부작용을 자동 승인하지 않습니다.

1. `bridge_status` 또는 대시보드에서 워커·연동 상태를 먼저 읽습니다.
2. 조회와 동기화로 평가·면접관·회의실 상태를 최신화합니다.
3. 사용자 판단이 필요한 결정은 후보자·채용·선택지를 확인한 뒤 하나를 선택합니다.
4. Slack 메시지는 초안을 먼저 만들고 대상·내용·채널을 확인합니다.
5. 사용자가 명시적으로 승인한 뒤에만 발송합니다.
6. 나인하이어 후보자 일정 발송과 다우오피스 예약 생성·수정·취소는 현재 수동 영역으로 남깁니다.

대시보드 버튼은 이 결정 흐름을 화면으로 표현하는 인터페이스이며, Codex 자연어 대화와 동일한 상태·이벤트 이력을 사용해야 합니다.

## 백업과 보안 점검

```powershell
npm run backup:db
npm run check:repo
git status --short
```

백업은 `data/backups/bridge-YYYY-MM-DD.db`에 저장되고 기본 14개를 유지합니다. 백업 파일에는 후보자 이름과 평가 의견이 포함될 수 있으므로 접근 권한이 제한된 로컬 폴더에만 보관합니다.

`check:repo`는 Git이 추적하는 파일만 검사합니다. 실제 `.env`와 로컬 DB의 내용까지 출력하거나 외부로 전송하지 않습니다. 점검 실패 시 토큰·DB·로그를 커밋하지 말고, 먼저 `git status`와 스테이징 영역을 확인합니다.

## 운영 전환 전 보류 항목

다음 조건을 충족하기 전에는 여러 채용 담당자가 동시에 사용하는 중앙 운영으로 전환하지 않습니다.

- 대시보드 로그인·역할·승인자 감사 기록.
- 공유 DB와 동시 워커 단일 실행 보장.
- DB 백업 암호화와 보존·삭제 정책.
- Slack·나인하이어·다우오피스 장애 통합 테스트.
- 후보자 개인정보 보존 기간과 삭제 절차.
