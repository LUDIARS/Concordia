import type { SessionRow } from "../shared/types.js";
import { CONTRACT_FIELDS, type SessionContract } from "./schema.js";

function decided<T>(value: T, rationale: string) { return { value, decided_by: "seed" as const, rationale, genius_card_ids: [] }; }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "task"; }
const PLAN_PATTERN = /(?:migration|schema|auth|認証|削除|delete|複数リポ|new service|新規サービス)/iu;

/**
 * team settings の `worktree` (teams §3.1) を work_location の許容値へ写す。
 * `repo-root-only` なら plan mode の既定 (`worktree`) より優先して repo-root に固定する
 * (Unity 系のように worktree 運用が成立しないチーム向け)。 未所属・未指定は既存の
 * plan/vibes 既定を変えない。
 */
export interface TeamContractSettings {
  worktree?: "allowed" | "repo-root-only";
}

export function resolveTeamWorkLocation(
  mode: "plan" | "vibes" | null,
  teamSettings?: TeamContractSettings | null,
): "worktree" | "repo-root" | null {
  if (teamSettings?.worktree === "repo-root-only") return "repo-root";
  if (mode === "vibes") return "repo-root";
  return mode === "plan" ? "worktree" : null;
}

/**
 * mode は決定論で決め切る (2026-08-21 neco 指示で判断ダイアログを撤廃)。
 *
 * 以前は高リスク語に当たらないタスクの mode を null のまま残し、 Discord の契約カードで
 * 人間に plan/vibes を選ばせていた。 未回答の間は契約が未確定 = harness の
 * contract-incomplete が編集を全部 deny するため、 委託セッションはカードを待って止まった。
 * 判断自体に意味が無い (回答は事実上いつも同じ) ので、 seed 側で決め切る。
 */
export function seedSessionContract(session: SessionRow, task: string, defaultSupervisor: string, teamId?: string | null, teamSettings?: TeamContractSettings | null): SessionContract {
  const mode: "plan" | "vibes" = PLAN_PATTERN.test(task) ? "plan" : "vibes";
  const model = readRuntimeModel(session.metadata);
  const effort = readRuntimeEffort(session.metadata);
  const workLocation = resolveTeamWorkLocation(mode, teamSettings);
  return {
    version: 1,
    mode: decided(mode, mode === "plan" ? "高リスク作業を決定論で検出" : "高リスク語に当たらないため既定レーン"),
    team: decided(teamId ?? null, teamId ? "repository has one configured team" : "team 未導入・未所属を明示"),
    // runtime が実際に報告した model / effort だけを seed とする。 不明なら null のまま
    // 残し、 LLM tier (review-port) → 質問カード (human tier) が決める。 provider 名や
    // 固定 "medium" の埋め草 seed は LLM tier を恒久的に不発にしていたため廃止 (2026-08-14)。
    model: model ? decided(model, "現在の session runtime") : null,
    effort: effort ? decided(effort, "現在の session runtime") : null,
    work_branch: decided(session.branch ?? `feat/${slug(task)}`, "checkout branch または task slug"),
    work_location: decided(
      workLocation ?? (mode === "vibes" ? "repo-root" : "worktree"),
      teamSettings?.worktree === "repo-root-only" ? "team settings: worktree=repo-root-only" : "mode の決定論規則",
    ),
    scope_dirs: decided(["."], "登録 repo root からの相対スコープ"),
    acceptance: decided(mode === "plan" ? "plan" : "human-ok", "mode から導出"),
    goal_and_go: decided({ enabled: metadataBoolean(session.metadata, "goal_and_go", "enabled") ?? true }, "default ON; explicit spawn option may disable"),
    continuation: decided("requeue", "プロセス使い捨てを既定とする"),
    // vibes の service は spawn 時点では解けない (Excubitor catalog 参照が非同期)。
    // 解決できたら ensureSessionContract が seed の上から埋め直す。
    testing_claim: decided(
      { required: false, service: null },
      mode === "plan" ? "plan は testing claim 不要" : "vibes: service 未解決 (必要なら claim を明示取得)",
    ),
    supervisor: decided(defaultSupervisor, "CONCORDIA_DEFAULT_SUPERVISOR"),
  };
}

function metadataString(raw: string | null, key: string): string | null { try { const value = raw ? (JSON.parse(raw) as Record<string, unknown>)[key] : null; return typeof value === "string" && value ? value : null; } catch { return null; } }

/** Lictor 登録時は `model` / `effort_level`、 runtime 切替後は `effort` に載る。 両方読む。 */
export function readRuntimeModel(metadata: string | null): string | null { return metadataString(metadata, "model"); }
export function readRuntimeEffort(metadata: string | null): string | null { return metadataString(metadata, "effort") ?? metadataString(metadata, "effort_level"); }
function metadataBoolean(raw: string | null, key: string, nested: string): boolean | null { try { const root = raw ? (JSON.parse(raw) as Record<string, unknown>)[key] : null; const value = root && typeof root === "object" ? (root as Record<string, unknown>)[nested] : null; return typeof value === "boolean" ? value : null; } catch { return null; } }

export function undecidedFields(contract: SessionContract): string[] { return CONTRACT_FIELDS.filter((field) => contract[field] === null); }
