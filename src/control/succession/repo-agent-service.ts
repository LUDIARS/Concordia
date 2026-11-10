/**
 * リポ担当エージェントへの受け渡しのユースケース。
 *
 * - onGateDenied: ゲートの deny (cwd と作業先のずれ) を契機に requested 行を書き、
 *   deny 応答へ依頼文の書き方 (同じ checkout なら §3.5 の案内) を返す。
 * - onAssistantText: 親の発言の repo-brief を受け取り、 担当を立てる / 担当へ追加依頼を渡す。
 * - onChildRegistered / onSessionEnded: 子の登録・終了で親子の状態を結ぶ。
 * - sweep: 時間切れ・保留中の spawn・副契機 (リポ分岐) を監視の走査ごとに処理する。
 *
 * 状態は親 metadata の行 (repo-agents-state) で持ち、 更新は updateMetadata の中で
 * 現在値に対して遷移させる (読んでから書く間に別経路が更新しても遷移規則が守られる)。
 *
 * @implements spec/feature/session-auto-succession.md §3.3, §3.4, §3.5 (CC-AUTO-SUCC-02, INV-1, INV-3, INV-5, INV-7)
 */

import type { SessionRow } from "../../shared/types.js";
import type { PendingRepoAgentLink } from "../pending-relictor.js";
import type { SpawnProvider, SpawnRequest, SpawnResult } from "../spawner.js";
import { isDelegatedSession, isRepoAgentSession, parseSessionMetadata } from "./managed-session.js";
import {
  branchedCheckouts,
  decideRepoAgentHandoff,
  isRepoMismatchDenial,
  launchCheckoutOf,
  resolveCheckout,
  type GateHitLike,
  type ResolvedCheckout,
} from "./repo-agent-policy.js";
import {
  buildAlreadyAssignedText,
  buildAssignedNoticeText,
  buildAssignmentLine,
  buildBranchBriefRequestText,
  buildBriefRequestText,
  buildChildBriefText,
  buildChildEndedNoticeText,
  buildChildFollowupText,
  buildChildTitle,
  buildRejectedBriefText,
  hasRepoBriefFence,
  parseRepoBriefs,
  type RepoBrief,
} from "./repo-brief.js";
import {
  addRequestedRow,
  expiredRepoAgents,
  findRepoAgent,
  isLiveRepoAgent,
  patchRepoAgent,
  readRepoAgentOf,
  readRepoAgents,
  REPO_AGENTS_METADATA_KEY,
  transitionRepoAgent,
  type RepoAgentRow,
  type RepoAgentTrigger,
  type RowsResult,
} from "./repo-agents-state.js";
import type { RepoAgentSettings } from "./succession-settings.js";
import type { SpawnBudget } from "./spawn-budget.js";

export const REPO_AGENT_INJECT_SOURCE = "auto:repo-agent";
export const REPO_AGENT_BRIEF_INJECT_SOURCE = "auto:repo-agent-brief";
/** pending succession の TTL と同じ。 これを過ぎた spawning 行は子が来ない (§8)。 */
export const REPO_AGENT_SPAWNING_TIMEOUT_SEC = 5 * 60;

export interface RepoAgentServicePorts {
  sessions: {
    findSession(id: string): SessionRow | null;
    updateMetadata(id: string, update: (current: Record<string, unknown>) => Record<string, unknown>): void;
  };
  settings(): RepoAgentSettings;
  registeredRepos(): readonly string[];
  workspaceRoots(): readonly string[];
  projectCodeFor(repo: string): string | null;
  toSpawnProvider(provider: string): SpawnProvider | null;
  isSessionEnding(metadataJson: string | null): boolean;
  inject(sessionId: string, text: string, source: string): void;
  /** 親スレッドへの 1 行投稿 (best-effort)。 */
  postLine(sessionId: string, text: string): void;
  /** 子のスレッド表記 (Discord チャンネル mention 等)。 未作成なら null。 */
  childThread(childSessionId: string): string | null;
  /** 子の最後の assistant 発言。 */
  lastAssistantText(sessionId: string): string | null;
  recordPending(input: { cwd: string; spawnId: string; handoff: string; repoAgent: PendingRepoAgentLink }): void;
  forgetPending(spawnId: string): void;
  spawn(request: SpawnRequest): Promise<SpawnResult>;
  spawnBudget: SpawnBudget;
  newSpawnId(): string;
  now(): number;
  log: { info(message: string): void; warn(message: string): void };
}

export interface GateDeniedInput {
  sessionId: string;
  hits: readonly GateHitLike[];
  cwd: string | null;
  filePath: string | null;
}

export interface RepoAgentService {
  /** deny 応答に載せる案内。 契機でなければ null。 */
  onGateDenied(input: GateDeniedInput): string | null;
  onAssistantText(sessionId: string, text: string): Promise<void>;
  /** 手動 (02c): POST /v1/sessions/:id/repo-agents。 */
  submitBriefs(sessionId: string, text: string): Promise<{ accepted: number; rejected: number }>;
  onChildRegistered(link: PendingRepoAgentLink, childSessionId: string): void;
  onSessionEnded(sessionId: string): void;
  sweep(session: SessionRow, idle: boolean): Promise<void>;
  list(sessionId: string): RepoAgentRow[];
}

function pathOfAction(cwd: string | null, filePath: string | null): string | null {
  // filePath の方が具体的 (cwd は起動 cwd のまま別リポのファイルを編集していることがある)。
  if (filePath && /^(?:[A-Za-z]:[\\/]|\/)/.test(filePath)) return filePath;
  return cwd && cwd.trim() ? cwd : null;
}

export function createRepoAgentService(ports: RepoAgentServicePorts): RepoAgentService {
  /** 親の行を現在値に対して更新する。 結果 (成否) を返す。 */
  const updateRows = (
    parentId: string,
    change: (rows: RepoAgentRow[]) => RowsResult,
  ): RowsResult => {
    let result: RowsResult = { ok: false, reason: "not_found" };
    ports.sessions.updateMetadata(parentId, (current) => {
      result = change(readRepoAgents(current));
      return result.ok ? { ...current, [REPO_AGENTS_METADATA_KEY]: result.rows } : current;
    });
    return result;
  };

  const rowsOf = (session: SessionRow): RepoAgentRow[] => readRepoAgents(parseSessionMetadata(session.metadata));

  const decide = (parent: SessionRow, target: ResolvedCheckout | null) => {
    const metadata = parseSessionMetadata(parent.metadata);
    return decideRepoAgentHandoff({
      parentStatus: parent.status,
      spawnable: ports.toSpawnProvider(parent.provider) !== null,
      managedElsewhere: isRepoAgentSession(metadata) || isDelegatedSession(metadata),
      launchCheckout: launchCheckoutOf(parent.repo_path, ports.registeredRepos()),
      target,
      agents: readRepoAgents(metadata),
      sessionEnding: ports.isSessionEnding(parent.metadata),
    }, ports.settings());
  };

  const request = (
    parent: SessionRow,
    target: ResolvedCheckout,
    trigger: RepoAgentTrigger,
    rule: string | null,
  ): RowsResult => updateRows(parent.id, (rows) => addRequestedRow(rows, {
    checkout: target.checkout,
    project_code: ports.projectCodeFor(target.repo),
    trigger,
    rule,
    now: ports.now(),
  }));

  const spawnFromRow = async (parent: SessionRow, row: RepoAgentRow, brief: string): Promise<void> => {
    const provider = ports.toSpawnProvider(parent.provider);
    if (!provider) return;
    if (!ports.spawnBudget.tryTake()) {
      // 上限超過は requested のまま依頼文を保留し、 次の走査で立てる (§3.2)。
      updateRows(parent.id, (rows) => patchRepoAgent(rows, row.checkout, { pending_brief: brief }));
      ports.log.info(`repo-agent: spawn 上限のため保留 parent=${parent.id} checkout=${row.checkout}`);
      return;
    }
    const spawnId = ports.newSpawnId();
    const moved = updateRows(parent.id, (rows) => transitionRepoAgent(rows, row.checkout, "spawning", ports.now(),
      { spawn_id: spawnId, pending_brief: null }));
    if (!moved.ok) {
      ports.log.warn(`repo-agent: spawning へ遷移できません parent=${parent.id} checkout=${row.checkout}: ${moved.reason}`);
      return;
    }
    const link: PendingRepoAgentLink = { parentSessionId: parent.id, checkout: row.checkout, projectCode: row.project_code };
    ports.recordPending({
      cwd: row.checkout,
      spawnId,
      handoff: buildChildBriefText({ parentSessionId: parent.id, checkout: row.checkout, projectCode: row.project_code, brief }),
      repoAgent: link,
    });
    // INV-7: 担当は親と同じ provider で立てる。
    const result = await ports.spawn({
      provider, cwd: row.checkout, mode: "tab", title: buildChildTitle(row.project_code, brief), spawnId,
    });
    if (result.ok) {
      ports.log.info(`repo-agent: spawned parent=${parent.id} checkout=${row.checkout}`);
      return;
    }
    ports.forgetPending(spawnId);
    updateRows(parent.id, (rows) => transitionRepoAgent(rows, row.checkout, "spawn_failed", ports.now(),
      { note: result.error.slice(0, 300) }));
    ports.inject(parent.id, `【リポ担当を立てられませんでした】${row.checkout}: ${result.error}`, REPO_AGENT_INJECT_SOURCE);
  };

  const acceptBrief = async (parent: SessionRow, brief: RepoBrief): Promise<boolean> => {
    const existing = findRepoAgent(rowsOf(parent), brief.target.checkout);
    if (existing && existing.status === "active" && existing.child_session_id) {
      // §3.5: 担当がいる checkout への repo-brief は追加依頼として子へ渡す。
      ports.inject(existing.child_session_id, buildChildFollowupText(parent.id, brief.brief), REPO_AGENT_BRIEF_INJECT_SOURCE);
      return true;
    }
    if (existing && existing.status === "spawning") {
      ports.inject(parent.id, buildAlreadyAssignedText(existing.checkout, null), REPO_AGENT_INJECT_SOURCE);
      return false;
    }
    if (existing && existing.status === "requested") {
      await spawnFromRow(parent, existing, brief.brief);
      return true;
    }
    // requested 行と一致しない = 手動 (02c)。
    const decision = decide(parent, brief.target);
    if (decision.action === "skip") {
      ports.log.info(`repo-agent: 手動依頼を見送り parent=${parent.id} checkout=${brief.target.checkout} reason=${decision.reason}`);
      if (decision.reason === "agent_limit") {
        ports.inject(parent.id, `【リポ担当の上限】担当は ${ports.settings().maxAgentsPerParent} までです。${brief.target.checkout} は立てませんでした。`, REPO_AGENT_INJECT_SOURCE);
      }
      return false;
    }
    const requested = request(parent, decision.target, "manual", null);
    if (!requested.ok) return false;
    await spawnFromRow(parent, requested.row, brief.brief);
    return true;
  };

  const submitBriefs = async (sessionId: string, text: string): Promise<{ accepted: number; rejected: number }> => {
    const parent = ports.sessions.findSession(sessionId);
    if (!parent || parent.status !== "active" || !ports.settings().enabled) return { accepted: 0, rejected: 0 };
    const parsed = parseRepoBriefs(text, (path) => resolveCheckout(path, ports.registeredRepos()));
    if (parsed.rejected.length > 0) ports.inject(sessionId, buildRejectedBriefText(parsed.rejected), REPO_AGENT_INJECT_SOURCE);
    let accepted = 0;
    for (const brief of parsed.briefs) {
      if (await acceptBrief(parent, brief)) accepted++;
    }
    return { accepted, rejected: parsed.rejected.length };
  };

  const expire = (parent: SessionRow): void => {
    const settings = ports.settings();
    const expired = expiredRepoAgents(rowsOf(parent), ports.now(), {
      briefTimeoutSec: settings.briefTimeoutSec, spawningTimeoutSec: REPO_AGENT_SPAWNING_TIMEOUT_SEC,
    });
    for (const item of expired) {
      const note = item.to === "brief_missing" ? "brief timeout" : "child did not register (pending expired)";
      const moved = updateRows(parent.id, (rows) => transitionRepoAgent(rows, item.checkout, item.to, ports.now(), { note }));
      if (moved.ok) ports.log.info(`repo-agent: ${item.checkout} → ${item.to} parent=${parent.id}`);
    }
  };

  const retryPending = async (parent: SessionRow): Promise<void> => {
    for (const row of rowsOf(parent)) {
      if (row.status !== "requested" || !row.pending_brief) continue;
      await spawnFromRow(parent, row, row.pending_brief);
    }
  };

  const proposeBranches = (parent: SessionRow): void => {
    const candidates = branchedCheckouts({
      launchCheckout: launchCheckoutOf(parent.repo_path, ports.registeredRepos()),
      activeRepos: parseActiveRepos(parent.active_repos),
      registeredRepos: ports.registeredRepos(),
      workspaceRoots: ports.workspaceRoots(),
    });
    const requested: string[] = [];
    for (const target of candidates) {
      // 行を書くたびに親を読み直す: 直前の行が上限・重複の判定に効くように。
      const latest = ports.sessions.findSession(parent.id);
      if (!latest) return;
      if (findRepoAgent(rowsOf(latest), target.checkout)) continue; // 一度提案した checkout は重ねない (INV-1)
      if (decide(latest, target).action !== "assign") continue;
      if (request(latest, target, "branch", null).ok) requested.push(target.checkout);
    }
    if (requested.length > 0) ports.inject(parent.id, buildBranchBriefRequestText(requested), REPO_AGENT_INJECT_SOURCE);
  };

  return {
    onGateDenied(input) {
      if (!ports.settings().enabled) return null;
      const hit = input.hits.find(isRepoMismatchDenial);
      if (!hit) return null;
      const parent = ports.sessions.findSession(input.sessionId);
      const path = pathOfAction(input.cwd, input.filePath);
      if (!parent || !path) return null;
      const target = resolveCheckout(path, ports.registeredRepos());
      const decision = decide(parent, target);
      if (decision.action === "skip") {
        if (decision.reason !== "already_assigned" || !target) return null;
        const row = findRepoAgent(rowsOf(parent), target.checkout);
        return buildAlreadyAssignedText(target.checkout, row?.child_session_id ?? null);
      }
      // 記録先行 (INV-1): 案内を返す前に requested 行を書く。
      const requested = request(parent, decision.target, "gate", hit.rule);
      if (!requested.ok) return null;
      ports.log.info(`repo-agent: gate deny を契機に requested parent=${parent.id} checkout=${decision.target.checkout} rule=${hit.rule}`);
      return buildBriefRequestText(decision.target.checkout);
    },

    async onAssistantText(sessionId, text) {
      if (!hasRepoBriefFence(text)) return;
      await submitBriefs(sessionId, text);
    },

    submitBriefs,

    onChildRegistered(link, childSessionId) {
      const moved = updateRows(link.parentSessionId, (rows) =>
        transitionRepoAgent(rows, link.checkout, "active", ports.now(), { child_session_id: childSessionId }));
      if (!moved.ok) {
        ports.log.warn(`repo-agent: 子の登録を親へ結べません parent=${link.parentSessionId} child=${childSessionId}: ${moved.reason}`);
        return;
      }
      const thread = ports.childThread(childSessionId);
      ports.inject(link.parentSessionId, buildAssignedNoticeText({
        childSessionId, checkout: link.checkout, projectCode: link.projectCode, childThread: thread,
      }), REPO_AGENT_INJECT_SOURCE);
      ports.postLine(link.parentSessionId, buildAssignmentLine({
        projectCode: link.projectCode, checkout: link.checkout, childThread: thread, childSessionId, ended: false,
      }));
    },

    onSessionEnded(sessionId) {
      const child = ports.sessions.findSession(sessionId);
      if (!child) return;
      const of = readRepoAgentOf(parseSessionMetadata(child.metadata));
      if (!of) return;
      const moved = updateRows(of.parent_session_id, (rows) =>
        transitionRepoAgent(rows, of.checkout, "ended", ports.now()));
      if (!moved.ok) return;
      const parent = ports.sessions.findSession(of.parent_session_id);
      // 親が畳まれていれば何もしない (結果は子のチャンネルに残る)。
      if (!parent || parent.status !== "active") return;
      ports.inject(parent.id, buildChildEndedNoticeText({
        childSessionId: sessionId, checkout: of.checkout, lastMessage: ports.lastAssistantText(sessionId),
      }), REPO_AGENT_INJECT_SOURCE);
      ports.postLine(parent.id, buildAssignmentLine({
        projectCode: of.project_code, checkout: of.checkout, childThread: ports.childThread(sessionId),
        childSessionId: sessionId, ended: true,
      }));
    },

    async sweep(session, idle) {
      if (session.status !== "active") return;
      expire(session);
      if (!ports.settings().enabled) return;
      await retryPending(session);
      // INV-3: 副契機の依頼 inject は待機中だけ。
      if (idle) proposeBranches(session);
    },

    list(sessionId) {
      const session = ports.sessions.findSession(sessionId);
      return session ? rowsOf(session) : [];
    },
  };
}

function parseActiveRepos(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  } catch {
    // 壊れた active_repos は「触ったリポなし」と同じ (副契機を出さない側に倒れる)。
    return [];
  }
}

export { isLiveRepoAgent };
