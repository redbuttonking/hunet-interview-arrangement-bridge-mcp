"use client";

// 설치형 인터뷰 운영 서비스의 Slack 채널과 Codex 연결을 관리한다.

import { useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Code2,
  ExternalLink,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  ShieldCheck,
  LockKeyhole,
} from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

type RecruitmentChannelMapping = {
  recruitmentId: string;
  recruitmentName: string;
  channelId: string;
};

type InProgressRecruitment = {
  recruitmentId: string;
  recruitmentName: string;
};

type ManagementSettings = {
  slackSourceChannelId: string;
  recruitmentChannels: RecruitmentChannelMapping[];
  workerRestartRequired: boolean;
  codex: {
    installed: boolean;
    connected: boolean;
  };
};

type ManagementSettingsClientProps = {
  initialSettings: ManagementSettings;
};

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "요청을 처리하지 못했습니다.");
  return payload;
}

function sortMappings(mappings: RecruitmentChannelMapping[]): RecruitmentChannelMapping[] {
  return [...mappings].sort((left, right) => left.recruitmentName.localeCompare(right.recruitmentName, "ko"));
}

function mergeRecruitments(
  current: InProgressRecruitment[],
  incoming: InProgressRecruitment[],
): InProgressRecruitment[] {
  const merged = new Map(current.map((item) => [item.recruitmentId, item]));
  for (const item of incoming) merged.set(item.recruitmentId, item);
  return [...merged.values()].sort((left, right) => left.recruitmentName.localeCompare(right.recruitmentName, "ko"));
}

export function ManagementSettingsClient({ initialSettings }: ManagementSettingsClientProps) {
  const [sourceChannelId, setSourceChannelId] = useState(initialSettings.slackSourceChannelId);
  const [settings, setSettings] = useState(initialSettings);
  const [availableRecruitments, setAvailableRecruitments] = useState<InProgressRecruitment[]>(
    initialSettings.recruitmentChannels.map(({ recruitmentId, recruitmentName }) => ({ recruitmentId, recruitmentName })),
  );
  const [selectedRecruitmentId, setSelectedRecruitmentId] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingRecruitment, setSavingRecruitment] = useState(false);
  const [loadingRecruitments, setLoadingRecruitments] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [connectingCodex, setConnectingCodex] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearMessage = () => {
    setError(null);
    setNotice(null);
  };

  const saveSettings = async () => {
    setSaving(true);
    clearMessage();
    try {
      const nextSettings = await requestJson<ManagementSettings>("/api/management/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slackSourceChannelId: sourceChannelId,
        }),
      });
      setSettings(nextSettings);
      setNotice("기본 Slack 채널 설정을 저장했습니다. 워커를 다시 시작하면 바로 적용됩니다.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "설정을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const restartWorker = async () => {
    setRestarting(true);
    clearMessage();
    try {
      await requestJson<{ restarted: true }>("/api/management/worker/restart", { method: "POST" });
      setSettings((current) => ({ ...current, workerRestartRequired: false }));
      setNotice("워커를 다시 시작했습니다. 다음 동기화부터 새 채널 설정을 사용합니다.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "워커를 다시 시작하지 못했습니다.");
    } finally {
      setRestarting(false);
    }
  };

  const loadRecruitments = async () => {
    setLoadingRecruitments(true);
    clearMessage();
    try {
      const payload = await requestJson<{ recruitments: InProgressRecruitment[] }>("/api/management/recruitments");
      setAvailableRecruitments((current) => mergeRecruitments(current, payload.recruitments));
      setNotice(`진행 중인 나인하이어 채용 ${payload.recruitments.length}건을 불러왔습니다.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "진행 중인 채용을 불러오지 못했습니다.");
    } finally {
      setLoadingRecruitments(false);
    }
  };

  const saveRecruitmentChannel = async () => {
    const recruitment = availableRecruitments.find((item) => item.recruitmentId === selectedRecruitmentId);
    if (!recruitment) {
      setError("먼저 진행 중인 채용을 불러온 뒤 채용을 선택해 주세요.");
      return;
    }

    setSavingRecruitment(true);
    clearMessage();
    try {
      const mapping = await requestJson<RecruitmentChannelMapping>("/api/management/recruitment-channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...recruitment, channelId: selectedChannelId }),
      });
      setSettings((current) => ({
        ...current,
        recruitmentChannels: sortMappings([
          ...current.recruitmentChannels.filter((item) => item.recruitmentId !== mapping.recruitmentId),
          mapping,
        ]),
      }));
      setAvailableRecruitments((current) => mergeRecruitments(current, [recruitment]));
      setSelectedChannelId("");
      setNotice(`“${mapping.recruitmentName}”의 면접관 일정 요청 채널을 저장했습니다.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "채용별 Slack 채널을 저장하지 못했습니다.");
    } finally {
      setSavingRecruitment(false);
    }
  };

  const chooseMappingForEdit = (mapping: RecruitmentChannelMapping) => {
    setAvailableRecruitments((current) => mergeRecruitments(current, [{
      recruitmentId: mapping.recruitmentId,
      recruitmentName: mapping.recruitmentName,
    }]));
    setSelectedRecruitmentId(mapping.recruitmentId);
    setSelectedChannelId(mapping.channelId);
    clearMessage();
  };

  const connectCodex = async () => {
    setConnectingCodex(true);
    clearMessage();
    try {
      const codex = await requestJson<ManagementSettings["codex"]>("/api/management/codex/connect", {
        method: "POST",
      });
      setSettings((current) => ({ ...current, codex }));
      if (!codex.installed) {
        setNotice("MCP 연결 정보는 저장했습니다. 이 PC에 Codex CLI를 설치한 뒤 아래 버튼을 다시 눌러 주세요.");
        return;
      }
      await requestJson<{ opened: true }>("/api/management/codex/open", { method: "POST" });
      setNotice("인터뷰 어레인지 MCP가 연결된 새 Codex 터미널을 열었습니다. 기존에 열려 있던 Codex 창은 새 연결을 쓰지 않습니다.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Codex MCP 연결을 설정하지 못했습니다.");
    } finally {
      setConnectingCodex(false);
    }
  };

  const changePassword = async () => {
    if (nextPassword !== confirmPassword) {
      setError("새 비밀번호와 확인 비밀번호가 일치하지 않습니다.");
      return;
    }
    setChangingPassword(true);
    clearMessage();
    try {
      await requestJson<{ changed: true }>("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, nextPassword }),
      });
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      setNotice("비밀번호를 변경했습니다. 다른 열린 대시보드 화면은 다시 로그인해야 합니다.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "비밀번호를 변경하지 못했습니다.");
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {notice ? <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-900"><CheckCircle2 className="mt-0.5 size-5 shrink-0" />{notice}</div> : null}
      {error ? <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-900"><CircleAlert className="mt-0.5 size-5 shrink-0" />{error}</div> : null}

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700"><ShieldCheck className="size-5" /></span>
            <div>
              <CardTitle>Slack 운영 채널</CardTitle>
              <CardDescription className="mt-1">나인하이어 알림을 받는 개인 Slack 채널을 관리합니다. 면접관 일정 요청 채널은 아래에서 채용별로만 연결합니다. 토큰과 API 키는 이 화면에 표시하지 않습니다.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-5">
            <label className="grid gap-2 text-sm font-semibold text-slate-800">
              나인하이어 알림 채널 ID
              <input value={sourceChannelId} onChange={(event) => setSourceChannelId(event.target.value)} placeholder="C0123456789" spellCheck={false} />
              <span className="text-xs font-normal leading-5 text-slate-500">나인하이어의 후보자·평가·일정 알림을 받는 개인 Slack 채널입니다.</span>
            </label>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button disabled={saving} onClick={() => void saveSettings()} type="button">{saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}기본 설정 저장</Button>
            {settings.workerRestartRequired ? <Button disabled={restarting} onClick={() => void restartWorker()} type="button" variant="outline">{restarting ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCw className="size-4" />}워커 다시 시작</Button> : null}
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-500">채널 ID는 Slack 채널 메뉴의 <span className="font-medium text-slate-700">채널 세부 정보 → 채널 ID 복사</span>에서 확인할 수 있습니다.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-rose-50 text-rose-700"><LockKeyhole className="size-5" /></span>
            <div>
              <CardTitle>관리자 비밀번호</CardTitle>
              <CardDescription className="mt-1">이 PC의 대시보드 로그인 비밀번호를 변경합니다. 비밀번호를 바꾸면 다른 열린 대시보드 화면은 다시 로그인해야 합니다.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 lg:grid-cols-3">
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-slate-800">
              현재 비밀번호
              <input autoComplete="current-password" onChange={(event) => setCurrentPassword(event.target.value)} type="password" value={currentPassword} />
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-slate-800">
              새 비밀번호
              <input autoComplete="new-password" minLength={8} onChange={(event) => setNextPassword(event.target.value)} type="password" value={nextPassword} />
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-slate-800">
              새 비밀번호 확인
              <input autoComplete="new-password" minLength={8} onChange={(event) => setConfirmPassword(event.target.value)} type="password" value={confirmPassword} />
            </label>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button disabled={changingPassword || !currentPassword || !nextPassword || !confirmPassword} onClick={() => void changePassword()} type="button">
              {changingPassword ? <LoaderCircle className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}비밀번호 변경
            </Button>
            <p className="text-sm leading-6 text-slate-500">새 비밀번호는 8자 이상으로 설정해 주세요.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-700"><Plus className="size-5" /></span>
            <div>
              <CardTitle>채용별 면접관 일정 요청 채널</CardTitle>
              <CardDescription className="mt-1">채용을 추가할 때는 나인하이어에서 채용을 선택하고, 그 채용팀이 사용하는 Slack 채널 ID만 연결하면 됩니다. 테스트 채널도 “인터뷰 어레인지 자동화 테스트 채용”에만 연결합니다. 채용 ID를 직접 찾거나 입력할 필요는 없습니다.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {settings.recruitmentChannels.length > 0 ? (
            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
              {settings.recruitmentChannels.map((mapping) => (
                <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" key={mapping.recruitmentId}>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900" title={mapping.recruitmentName}>{mapping.recruitmentName}</p>
                    <p className="mt-1 text-xs text-slate-500">Slack 채널 ID. {mapping.channelId}</p>
                  </div>
                  <Button onClick={() => chooseMappingForEdit(mapping)} size="sm" type="button" variant="outline">변경</Button>
                </div>
              ))}
            </div>
          ) : <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">아직 채용별 채널이 없습니다. 아래에서 첫 채용을 연결해 주세요.</p>}

          <div className="grid grid-cols-1 gap-4 rounded-xl bg-slate-50 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(17rem,0.8fr)_auto] xl:items-end">
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-slate-800">
              나인하이어 채용
              <select className="min-w-0 w-full" onChange={(event) => setSelectedRecruitmentId(event.target.value)} value={selectedRecruitmentId}>
                <option value="">진행 중인 채용을 불러온 뒤 선택</option>
                {availableRecruitments.map((recruitment) => <option key={recruitment.recruitmentId} value={recruitment.recruitmentId}>{recruitment.recruitmentName}</option>)}
              </select>
            </label>
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-slate-800">
              면접관 일정 요청 Slack 채널 ID
              <input className="min-w-0 w-full" onChange={(event) => setSelectedChannelId(event.target.value)} placeholder="C0123456789" spellCheck={false} value={selectedChannelId} />
            </label>
            <div className="flex flex-wrap gap-2 xl:justify-self-end">
              <Button disabled={loadingRecruitments} onClick={() => void loadRecruitments()} type="button" variant="outline">{loadingRecruitments ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}채용 불러오기</Button>
              <Button disabled={savingRecruitment} onClick={() => void saveRecruitmentChannel()} type="button">{savingRecruitment ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}연결 저장</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-700"><Code2 className="size-5" /></span>
            <div><CardTitle>Codex MCP 연결</CardTitle><CardDescription className="mt-1">이 PC의 Codex에 인터뷰 브릿지 도구를 등록한 뒤, 바로 새 Codex 대화 터미널을 엽니다. 기존 Codex 설정은 유지합니다.</CardDescription></div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2 text-sm font-medium">
            <span className={settings.codex.installed ? "rounded-full bg-emerald-50 px-3 py-1.5 text-emerald-800" : "rounded-full bg-amber-50 px-3 py-1.5 text-amber-800"}>Codex CLI {settings.codex.installed ? "설치됨" : "설치 확인 필요"}</span>
            <span className={settings.codex.connected ? "rounded-full bg-emerald-50 px-3 py-1.5 text-emerald-800" : "rounded-full bg-slate-100 px-3 py-1.5 text-slate-700"}>인터뷰 브릿지 {settings.codex.connected ? "연결 설정됨" : "연결 전"}</span>
          </div>
          <Button disabled={connectingCodex} onClick={() => void connectCodex()} type="button" variant="outline">{connectingCodex ? <LoaderCircle className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}Codex 연결 후 대화 열기</Button>
        </CardContent>
      </Card>
    </div>
  );
}
