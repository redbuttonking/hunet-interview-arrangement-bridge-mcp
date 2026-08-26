// 대시보드 단일 관리자 로그인과 세션을 안전하게 관리한다.

import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { getConfig } from "../config.js";
import { BridgeDatabase } from "../db/database.js";

const scrypt = promisify(scryptCallback);

const DEFAULT_ADMIN_EMAIL = "hr@hunet.co.kr";
const DEFAULT_ADMIN_PASSWORD = "hunetno1!";
const PASSWORD_MINIMUM_LENGTH = 8;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

export const DASHBOARD_SESSION_COOKIE = "hunet_interview_ops_session";

type SessionIssue = {
  token: string;
  expiresAt: Date;
};

type LoginFailure = {
  count: number;
  firstFailedAt: number;
};

const loginFailures = new Map<string, LoginFailure>();
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1_000;
const MAX_LOGIN_FAILURES = 5;

function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

async function hashPassword(password: string, salt = randomBytes(16).toString("base64url")): Promise<string> {
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, salt, expectedHash] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHash) return false;

  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(expectedHash, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function withDatabase<T>(operation: (database: BridgeDatabase) => T): T {
  const database = new BridgeDatabase(getConfig().dbPath);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

async function ensureDashboardAdmin(): Promise<{ email: string; passwordHash: string }> {
  const existing = withDatabase((database) => database.getDashboardAuthSettings());
  if (existing) return existing;

  const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
  return withDatabase((database) => database.initializeDashboardAuthSettings({
    email: DEFAULT_ADMIN_EMAIL,
    passwordHash,
  }));
}

function createSession(): SessionIssue {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  withDatabase((database) => database.createDashboardAuthSession({
    tokenHash: hashSessionToken(token),
    expiresAt,
  }));
  return { token, expiresAt };
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: false,
    path: "/",
    expires: expiresAt,
  };
}

export function getDashboardLoginRetryAfterMs(clientKey: string): number {
  const failure = loginFailures.get(clientKey);
  if (!failure) return 0;
  const elapsed = Date.now() - failure.firstFailedAt;
  if (elapsed >= LOGIN_ATTEMPT_WINDOW_MS) {
    loginFailures.delete(clientKey);
    return 0;
  }
  return failure.count >= MAX_LOGIN_FAILURES ? LOGIN_ATTEMPT_WINDOW_MS - elapsed : 0;
}

export function recordDashboardLoginFailure(clientKey: string): void {
  const previous = loginFailures.get(clientKey);
  const now = Date.now();
  if (!previous || now - previous.firstFailedAt >= LOGIN_ATTEMPT_WINDOW_MS) {
    loginFailures.set(clientKey, { count: 1, firstFailedAt: now });
    return;
  }
  loginFailures.set(clientKey, { ...previous, count: previous.count + 1 });
}

export function clearDashboardLoginFailures(clientKey: string): void {
  loginFailures.delete(clientKey);
}

export async function authenticateDashboardAdmin(input: {
  email: string;
  password: string;
}): Promise<SessionIssue | undefined> {
  const settings = await ensureDashboardAdmin();
  const emailMatches = normalizeEmail(input.email) === normalizeEmail(settings.email);
  const passwordMatches = await verifyPassword(input.password, settings.passwordHash);
  if (!emailMatches || !passwordMatches) return undefined;
  return createSession();
}

export function validateDashboardSession(token: string | undefined): boolean {
  if (!token) return false;
  return withDatabase((database) => Boolean(database.findActiveDashboardAuthSession(hashSessionToken(token))));
}

export function revokeDashboardSession(token: string | undefined): void {
  if (!token) return;
  withDatabase((database) => database.deleteDashboardAuthSession(hashSessionToken(token)));
}

export async function changeDashboardPassword(input: {
  currentPassword: string;
  nextPassword: string;
}): Promise<SessionIssue | undefined> {
  if (input.nextPassword.length < PASSWORD_MINIMUM_LENGTH) {
    throw new Error(`새 비밀번호는 ${PASSWORD_MINIMUM_LENGTH}자 이상이어야 합니다.`);
  }
  const settings = await ensureDashboardAdmin();
  if (!await verifyPassword(input.currentPassword, settings.passwordHash)) return undefined;

  const passwordHash = await hashPassword(input.nextPassword);
  withDatabase((database) => database.replaceDashboardAuthPassword({ passwordHash }));
  return createSession();
}
