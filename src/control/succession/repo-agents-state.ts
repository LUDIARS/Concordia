/**
 * リポ担当の状態 (親 metadata `repo_agents[]` / 子 metadata `repo_agent_of`) の読み書きと
 * 状態遷移 (純関数)。
 *
 * ```
 * requested ──brief 受領──▶ spawning ──子が登録──▶ active ──子が終了──▶ ended
 *     │                         │
 *     └─timeout─▶ brief_missing └─spawn 失敗─▶ spawn_failed
 * ```
 * 図以外の遷移は拒否する。 1 checkout につき 1 行で、 終端の行は新しい依頼で置き換える
 * (同じ checkout の重複行を作らない)。
 *
 * @implements spec/feature/session-auto-succession.md §3.4 (INV-1)
 */

import { LIVE_REPO_AGENT_STATUSES, repoKey } from "./repo-agent-policy.js";

export const REPO_AGENTS_METADATA_KEY = "repo_agents";
export const REPO_AGENT_OF_METADATA_KEY = "repo_agent_of";

export type RepoAgentStatus = "requested" | "spawning" | "active" | "ended" | "brief_missing" | "spawn_failed";
export type RepoAgentTrigger = "gate" | "branch" | "manual";

export interface RepoAgentRow {
  checkout: string;
  project_code: string | null;
  trigger: RepoAgentTrigger;
  /** 契機になったゲート rule (gate 契機のみ)。 */
  rule: string | null;
  status: RepoAgentStatus;
  /** 行を作った時刻 (epoch 秒)。 */
  at: number;
  /** 最後に状態が変わった時刻 (epoch 秒)。 */
  updated_at: number;
  spawn_id: string | null;
  child_session_id: string | null;
  /** 受領済みで spawn 待ちの依頼文 (spawn 上限で次の機会へ回したとき)。 */
  pending_brief: string | null;
  /** 終端に倒れた理由など。 */
  note: string | null;
}

export interface RepoAgentOf {
  parent_session_id: string;
  checkout: string;
  project_code: string | null;
}

const ALLOWED: Readonly<Record<RepoAgentStatus, readonly RepoAgentStatus[]>> = {
  requested: ["spawning", "brief_missing"],
  spawning: ["active", "spawn_failed"],
  active: ["ended"],
  ended: [],
  brief_missing: [],
  spawn_failed: [],
};

const STATUSES: ReadonlySet<string> = new Set(Object.keys(ALLOWED));
const TRIGGERS: ReadonlySet<string> = new Set(["gate", "branch", "manual"]);

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseRow(value: unknown): RepoAgentRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const checkout = str(raw.checkout);
  if (!checkout || typeof raw.status !== "string" || !STATUSES.has(raw.status)) return null;
  const at = typeof raw.at === "number" ? raw.at : 0;
  return {
    checkout,
    project_code: str(raw.project_code),
    trigger: typeof raw.trigger === "string" && TRIGGERS.has(raw.trigger) ? raw.trigger as RepoAgentTrigger : "manual",
    rule: str(raw.rule),
    status: raw.status as RepoAgentStatus,
    at,
    updated_at: typeof raw.updated_at === "number" ? raw.updated_at : at,
    spawn_id: str(raw.spawn_id),
    child_session_id: str(raw.child_session_id),
    pending_brief: str(raw.pending_brief),
    note: str(raw.note),
  };
}

export function readRepoAgents(metadata: Record<string, unknown>): RepoAgentRow[] {
  const value = metadata[REPO_AGENTS_METADATA_KEY];
  if (!Array.isArray(value)) return [];
  return value.map(parseRow).filter((row): row is RepoAgentRow => row !== null);
}

export function readRepoAgentOf(metadata: Record<string, unknown>): RepoAgentOf | null {
  const value = metadata[REPO_AGENT_OF_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const parent = str(raw.parent_session_id);
  const checkout = str(raw.checkout);
  if (!parent || !checkout) return null;
  return { parent_session_id: parent, checkout, project_code: str(raw.project_code) };
}

/** 子 metadata `repo_agent_of` に書く値。 */
export function repoAgentOfMetadata(link: { parentSessionId: string; checkout: string; projectCode: string | null }): RepoAgentOf {
  return { parent_session_id: link.parentSessionId, checkout: link.checkout, project_code: link.projectCode };
}

export function findRepoAgent(rows: readonly RepoAgentRow[], checkout: string): RepoAgentRow | null {
  const key = repoKey(checkout);
  return rows.find((row) => repoKey(row.checkout) === key) ?? null;
}

export function isLiveRepoAgent(row: RepoAgentRow): boolean {
  return LIVE_REPO_AGENT_STATUSES.has(row.status);
}

export type RowsResult = { ok: true; rows: RepoAgentRow[]; row: RepoAgentRow } | { ok: false; reason: string };

/** requested 行を足す。 同じ checkout に生きた行があれば拒否、 終端行なら置き換える。 */
export function addRequestedRow(
  rows: readonly RepoAgentRow[],
  input: { checkout: string; project_code: string | null; trigger: RepoAgentTrigger; rule: string | null; now: number },
): RowsResult {
  const existing = findRepoAgent(rows, input.checkout);
  if (existing && isLiveRepoAgent(existing)) return { ok: false, reason: "already_assigned" };
  const row: RepoAgentRow = {
    checkout: input.checkout, project_code: input.project_code, trigger: input.trigger, rule: input.rule,
    status: "requested", at: input.now, updated_at: input.now,
    spawn_id: null, child_session_id: null, pending_brief: null, note: null,
  };
  const rest = existing ? rows.filter((candidate) => candidate !== existing) : [...rows];
  return { ok: true, rows: [...rest, row], row };
}

/** 状態遷移。 図にない遷移・行なしは拒否する。 patch は状態以外の欄の更新。 */
export function transitionRepoAgent(
  rows: readonly RepoAgentRow[],
  checkout: string,
  to: RepoAgentStatus,
  now: number,
  patch: Partial<Pick<RepoAgentRow, "spawn_id" | "child_session_id" | "pending_brief" | "note">> = {},
): RowsResult {
  const existing = findRepoAgent(rows, checkout);
  if (!existing) return { ok: false, reason: "not_found" };
  if (!ALLOWED[existing.status].includes(to)) return { ok: false, reason: `invalid_transition:${existing.status}->${to}` };
  const row: RepoAgentRow = { ...existing, ...patch, status: to, updated_at: now };
  return { ok: true, rows: rows.map((candidate) => (candidate === existing ? row : candidate)), row };
}

/** 状態を変えずに欄だけ更新する (requested のまま依頼文を保留するとき)。 */
export function patchRepoAgent(
  rows: readonly RepoAgentRow[],
  checkout: string,
  patch: Partial<Pick<RepoAgentRow, "pending_brief" | "note">>,
): RowsResult {
  const existing = findRepoAgent(rows, checkout);
  if (!existing) return { ok: false, reason: "not_found" };
  const row: RepoAgentRow = { ...existing, ...patch };
  return { ok: true, rows: rows.map((candidate) => (candidate === existing ? row : candidate)), row };
}

/**
 * 時間切れの行と倒し先。 requested で依頼文が無いまま briefTimeout → brief_missing (INV-5)、
 * spawning のまま spawningTimeout (pending succession の TTL) → spawn_failed (§8: 再起動で子が来なくなる)。
 */
export function expiredRepoAgents(
  rows: readonly RepoAgentRow[],
  now: number,
  timeouts: { briefTimeoutSec: number; spawningTimeoutSec: number },
): Array<{ checkout: string; to: "brief_missing" | "spawn_failed" }> {
  const out: Array<{ checkout: string; to: "brief_missing" | "spawn_failed" }> = [];
  for (const row of rows) {
    const age = now - row.updated_at;
    if (row.status === "requested" && !row.pending_brief && age >= timeouts.briefTimeoutSec) {
      out.push({ checkout: row.checkout, to: "brief_missing" });
    } else if (row.status === "spawning" && age >= timeouts.spawningTimeoutSec) {
      out.push({ checkout: row.checkout, to: "spawn_failed" });
    }
  }
  return out;
}
