// 대시보드의 사용자 결정 요청을 기존 업무 서비스로 연결한다.
import { WebClient } from "@slack/web-api";
import { getConfig } from "../config.js";
import { DaouOfficeBrowserController } from "../daou-office/browser.js";
import { BridgeDatabase } from "../db/database.js";
import { NinehireRecruitmentWorkflowAdapter } from "../ninehire/adapter.js";
import { NinehireMcpGateway } from "../ninehire/gateway.js";
import { OperationalReadinessService } from "../services/operational-readiness.js";
import { WorkflowService, type SlackIdentityResolver } from "../services/workflow.js";
import { InterviewArrangementSkills } from "../skills/interview-arrangement.js";

class DashboardSlackIdentityResolver implements SlackIdentityResolver {
  constructor(private readonly client: WebClient) {}

  async lookupUserIdByEmail(email: string): Promise<string | undefined> {
    try {
      const response = await this.client.users.lookupByEmail({ email });
      return response.user?.id;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "data" in error
          ? String((error as { data?: { error?: string } }).data?.error)
          : "";
      if (code === "users_not_found") return undefined;
      throw error;
    }
  }
}

function createRuntime() {
  const config = getConfig();
  const db = new BridgeDatabase(config.dbPath);
  const gateway = new NinehireMcpGateway(config.ninehire);
  const ninehire = new NinehireRecruitmentWorkflowAdapter(gateway);
  const slackClient = config.slack.botToken ? new WebClient(config.slack.botToken) : undefined;
  const workflow = new WorkflowService(
    db,
    config,
    ninehire,
    slackClient ? new DashboardSlackIdentityResolver(slackClient) : undefined,
  );
  const readiness = new OperationalReadinessService(
    config,
    db,
    gateway,
    new DaouOfficeBrowserController(config.daouOffice),
    slackClient,
  );
  const skills = new InterviewArrangementSkills(db, workflow, readiness);
  return { db, skills };
}

export async function createDashboardTriageDecision(reviewId: string) {
  const runtime = createRuntime();
  try {
    return runtime.skills.createCandidateTriageDecision(reviewId);
  } finally {
    runtime.db.close();
  }
}

export async function resolveDashboardDecision(input: {
  decisionId: string;
  optionId: string;
  note?: string;
}) {
  const runtime = createRuntime();
  try {
    return await runtime.skills.resolveDecision(input);
  } finally {
    runtime.db.close();
  }
}
