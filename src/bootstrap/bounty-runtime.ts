/**
 * バグバウンティの受付より後段 (仕分け・再審・修正・反映確認・管理面・公開面) の起動配線
 * (spec/feature/bug-bounty.md §5-§8.2)。 core.ts は既存の部品を渡すだけにする。
 *
 * - 操作者の経路の鍵: Bot の内部トークンを起動時に用意し、Cocoiru の鍵は設定ストアから復号して検証する (CC-BOUNTY-INV-10)。
 * - 委託の起動: 予約した run id で delegation service を invoke し、結果不明は run を照会してから扱う。
 * - Discord への投稿: 本社は本社 Bot、子会社の受付口はその会社の Bot (無ければ本社 Bot) で、mention は本人だけ許す。
 * - 定期の処理: 仕分けの起動と照合、Actio の再試行、hotfix の照合、PR の記録、Actio done の知らせ。
 *
 * @implements SPEC-BOUNTY-TRIAGE
 * @implements SPEC-BOUNTY-FIX
 * @implements SPEC-BOUNTY-CLOSE
 * @implements SPEC-BOUNTY-WEBUI
 */

import type Database from "better-sqlite3";
import { createBountyActioAdapter } from "../bounty/actio-adapter.js";
import { createBountyFlow, type BountyFlow } from "../bounty/composition.js";
import { parseBountyHotfixDailyLimit } from "../bounty/fix-policy.js";
import { BOUNTY_HOTFIX_DAILY_LIMIT_KEY } from "../bounty/hotfix-settings.js";
import { createBountyNotifier } from "../bounty/notifier-adapter.js";
import { createCocoiruKeyStore, ensureBountyOperatorToken, type CocoiruKeyStore } from "../bounty/operator-credentials.js";
import { verifyBountyOperator } from "../bounty/operator-auth.js";
import { createBountyPrLookup } from "../bounty/pr-lookup-adapter.js";
import type { BountyRunStatus } from "../bounty/ports.js";
import type { BountyFlowRoutesDeps } from "../api/bounty-routes.js";
import type { BountyOperatorVerifier } from "../api/bounty-actor.js";
import type { BountyReportsRepo } from "../db/bounty-reports-repo.js";
import type { BountyReportersRepo } from "../db/bounty-reporters-repo.js";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { ActioBinding } from "../taskflow/actio-binding.js";
import type { ActioBindingScope } from "../taskflow/actio-binding-scope.js";
import { startPeriodic, type PeriodicHandle } from "../personal-budget/periodic.js";
import type { PersonalBudgetRewardPort } from "../personal-budget/reward-service.js";
import { resolveSubsidiaryBotToken } from "../deploy/service-deployed-runtime.js";
import type { InvokeInput } from "../delegation/contracts.js";
import type { InvokeResult } from "../delegation/service.js";

const BOUNTY_TICK_MS = 2 * 60_000;

export interface BountyRuntimeDeps {
  db: Database.Database;
  reports: BountyReportsRepo;
  reporters: BountyReportersRepo;
  projectCodes: ProjectCodesRepo;
  /** 子会社の関係プロジェクト。 会社が登録に無ければ null。 */
  subsidiaryProjects(companyId: string): readonly string[] | null;
  subsidiaryBotTokenEnc(companyId: string): string | null;
  delegation: {
    invoke(input: InvokeInput): Promise<InvokeResult>;
    findRun(runId: string): { status: string; child_session_id: string | null } | null;
  };
  actio: {
    bindings(scope?: ActioBindingScope): Promise<readonly ActioBinding[]>;
    transport: { request(binding: ActioBinding, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> };
  };
  rewards: PersonalBudgetRewardPort;
  sessions: {
    find(id: string): { status: string; ended_at: number | null } | null;
    inject(sessionId: string, text: string): void;
  };
  meta: { get(key: string): string | null; set(key: string, value: string): void; delete(key: string): void };
  secretBox: { encrypt(value: string): string; decrypt(value: string): string } | null;
  hqBotToken(): string | null;
  authorityChannel(): string | null;
  /** 本社の社員名簿で管理職以上か。 */
  isAuthority(platform: "discord", userId: string): boolean;
  readSetting(key: string): string | null;
  fetchImpl?: typeof fetch;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export interface BountyRuntime {
  flow: BountyFlow;
  verifyOperator: BountyOperatorVerifier;
  routes: BountyFlowRoutesDeps;
  cocoiruKey: CocoiruKeyStore;
  start(): PeriodicHandle;
}

const INACTIVE = new Set(["ended", "lost", "abandoned"]);

export function createBountyRuntime(deps: BountyRuntimeDeps): BountyRuntime {
  const botToken = ensureBountyOperatorToken();
  const cocoiruKey = createCocoiruKeyStore({ meta: deps.meta, secretBox: deps.secretBox });
  const verifyOperator: BountyOperatorVerifier = (platform, provided) =>
    verifyBountyOperator({ platform, provided, botToken, cocoiruKey: cocoiruKey.read() });
  const project = (code: string) => deps.projectCodes.findByCode(code);
  const hotfixDailyLimit = () => parseBountyHotfixDailyLimit(deps.readSetting(BOUNTY_HOTFIX_DAILY_LIMIT_KEY));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sessionActive = (id: string) => {
    const row = deps.sessions.find(id);
    return !!row && row.ended_at === null && !INACTIVE.has(row.status);
  };

  const flow = createBountyFlow({
    ledger: deps.reports,
    reporters: deps.reporters,
    projects: {
      registered: () => deps.projectCodes.list().map((row) => row.code),
      companyProjects: (companyId) => (companyId === null ? null : deps.subsidiaryProjects(companyId) ?? []),
      repoPath: (code) => project(code)?.repo_path ?? null,
      revisorWorkflow: (code) => project(code)?.revisor_workflow ?? null,
    },
    delegation: {
      launch: async (input) => {
        const result = await deps.delegation.invoke({
          reserved_run_id: input.runId,
          call_name: input.callName,
          args: { ...input.args, ...(input.taskflowReference ? { taskflow_reference: input.taskflowReference } : {}) },
          cwd: input.cwd,
          project: input.project,
          ...(input.branch ? { branch: input.branch } : {}),
          triggered_by: "bug-bounty",
          spawn: true,
          // Actio のタスクは bug-bounty が作って渡す。 委託側で新しいタスクを封印しない。
          task_binding: "caller",
        });
        if (!result.ok) return { ok: false, error: result.error };
        return result.run.status === "spawn_failed" ? { ok: false, error: result.run.error ?? "spawn_failed" } : { ok: true };
      },
      findRun: (runId) => {
        const run = deps.delegation.findRun(runId);
        return run ? { status: run.status as BountyRunStatus, childSessionId: run.child_session_id } : null;
      },
    },
    actio: createBountyActioAdapter({
      bindings: deps.actio.bindings,
      transport: deps.actio.transport,
      repoPath: (code) => project(code)?.repo_path ?? null,
    }),
    prs: createBountyPrLookup({ db: deps.db, repoOrigin: (code) => project(code)?.repo_origin ?? null }),
    notifier: createBountyNotifier({
      reporters: deps.reporters,
      postDiscord: async ({ channelId, subsidiaryId, content, mentionUserId }) => {
        const token = subsidiaryId === null
          ? deps.hqBotToken()
          : resolveSubsidiaryBotToken({
            encryptedToken: deps.subsidiaryBotTokenEnc(subsidiaryId),
            decrypt: (value) => deps.secretBox?.decrypt(value) ?? "",
            hqToken: deps.hqBotToken,
          });
        if (!token) throw new Error("Discord bot token is not configured");
        const response = await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
          method: "POST",
          headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
          // 本文由来の mention は許可しない。 本人だけを構造化フィールドで許す。
          body: JSON.stringify({ content, allowed_mentions: { parse: [], users: mentionUserId ? [mentionUserId] : [] } }),
        });
        if (!response.ok) throw new Error(`Discord rejected the bounty notice (${response.status})`);
      },
      injectSession: (sessionId, text) => {
        if (!sessionActive(sessionId)) return false;
        deps.sessions.inject(sessionId, text);
        return true;
      },
      authorityChannel: deps.authorityChannel,
      log: deps.log,
    }),
    rewards: deps.rewards,
    sessionActive,
    hotfixDailyLimit,
    log: deps.log,
  });

  const routes: BountyFlowRoutesDeps = {
    triage: flow.triage,
    judgement: flow.judgement,
    close: flow.close,
    fix: flow.fix,
    isAuthority: deps.isAuthority,
    reports: deps.reports,
    reporters: deps.reporters,
    cocoiruKey,
    hotfixDailyLimit,
    projectPublic: (code) => {
      const row = project(code);
      return row ? row.public_issues === 1 : null;
    },
    publicProjects: () => deps.projectCodes.listPublicIssues().map((row) => ({ code: row.code, project: row.project })),
  };

  return {
    flow,
    verifyOperator,
    routes,
    cocoiruKey,
    start: () => startPeriodic({ name: "bug bounty", intervalMs: BOUNTY_TICK_MS, run: () => flow.tick(), log: deps.log }),
  };
}
