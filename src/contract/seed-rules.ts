import type { SessionRow } from "../shared/types.js";
import { CONTRACT_FIELDS, type ContractMode, type SessionContract } from "./schema.js";

function decided<T>(value: T, rationale: string) { return { value, decided_by: "seed" as const, rationale, genius_card_ids: [] }; }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "task"; }
/**
 * repo-root (本体フォルダ) で動かして見たい内容か (spec/feature/session-fragment.md §3)。
 * mode とは連動させない。 初回タスク指示 (spawn) とタスク切り替え (task-change) の seed で判定する。
 */
const REPO_ROOT_VIEW_PATTERN = /(?:画面|表示|見た目|目視|プレビュー|動作確認|レイアウト|スタイル|デザイン調整|\bUI\b|\bUX\b|\bcss\b|unity|シーン|アニメーション|演出)/iu;

/**
 * team settings の `worktree` (teams §3.1) を work_location の許容値へ写す。
 * `repo-root-only` なら repo-root に固定する (Unity 系のように worktree 運用が成立しないチーム向け)。
 * 未所属・未指定は null (タスク文の判定に任せる)。
 */
export interface TeamContractSettings {
  worktree?: "allowed" | "repo-root-only";
}

export function resolveTeamWorkLocation(teamSettings?: TeamContractSettings | null): "repo-root" | null {
  return teamSettings?.worktree === "repo-root-only" ? "repo-root" : null;
}

/** タスク文が repo-root で見たい内容か (pure)。 */
export function wantsRepoRootView(task: string): boolean {
  return REPO_ROOT_VIEW_PATTERN.test(task);
}

/** Director case に紐づくセッションだけ structured、 それ以外は fragment (pure)。 */
export function seedContractMode(metadata: string | null): ContractMode {
  return metadataString(metadata, "director_case_id") ? "structured" : "fragment";
}

/**
 * 契約の seed は決定論で決め切る (2026-08-21 neco 指示で判断ダイアログを撤廃)。
 * plan / vibes の区分は 2026-10-06 に撤廃した (spec/feature/session-fragment.md)。
 */
export function seedSessionContract(session: SessionRow, task: string, defaultSupervisor: string, teamId?: string | null, teamSettings?: TeamContractSettings | null): SessionContract {
  const mode = seedContractMode(session.metadata);
  const model = readRuntimeModel(session.metadata);
  const effort = readRuntimeEffort(session.metadata);
  const teamLocation = resolveTeamWorkLocation(teamSettings);
  const repoRootView = wantsRepoRootView(task);
  return {
    version: 1,
    mode: decided(mode, mode === "structured" ? "Director case のプラン工程に紐づく" : "セッションで指示された作業"),
    team: decided(teamId ?? null, teamId ? "repository has one configured team" : "team 未導入・未所属を明示"),
    // runtime が実際に報告した model / effort だけを seed とする。 不明なら null のまま
    // 残し、 LLM tier (review-port) → 質問カード (human tier) が決める。 provider 名や
    // 固定 "medium" の埋め草 seed は LLM tier を恒久的に不発にしていたため廃止 (2026-08-14)。
    model: model ? decided(model, "現在の session runtime") : null,
    effort: effort ? decided(effort, "現在の session runtime") : null,
    work_branch: decided(session.branch ?? `feat/${slug(task)}`, "checkout branch または task slug"),
    work_location: decided(
      teamLocation ?? (repoRootView ? "repo-root" : "worktree"),
      teamLocation
        ? "team settings: worktree=repo-root-only"
        : repoRootView ? "repo-root で見たい内容 (タスク文の判定)" : "repo-root で見る必要のない内容",
    ),
    scope_dirs: decided(["."], "登録 repo root からの相対スコープ"),
    acceptance: decided(mode === "structured" ? "plan" : "human-ok", "mode から導出"),
    goal_and_go: decided({ enabled: metadataBoolean(session.metadata, "goal_and_go", "enabled") ?? true }, "default ON; explicit spawn option may disable"),
    continuation: decided("requeue", "プロセス使い捨てを既定とする"),
    // testing claim は自動取得しない (vibes の撤廃)。 テストする側が明示的に claim する。
    testing_claim: decided({ required: false, service: null }, "testing claim は明示取得のみ"),
    supervisor: decided(defaultSupervisor, "CONCORDIA_DEFAULT_SUPERVISOR"),
  };
}

function metadataString(raw: string | null, key: string): string | null { try { const value = raw ? (JSON.parse(raw) as Record<string, unknown>)[key] : null; return typeof value === "string" && value ? value : null; } catch { return null; } }

/** Lictor 登録時は `model` / `effort_level`、 runtime 切替後は `effort` に載る。 両方読む。 */
export function readRuntimeModel(metadata: string | null): string | null { return metadataString(metadata, "model"); }
export function readRuntimeEffort(metadata: string | null): string | null { return metadataString(metadata, "effort") ?? metadataString(metadata, "effort_level"); }
function metadataBoolean(raw: string | null, key: string, nested: string): boolean | null { try { const root = raw ? (JSON.parse(raw) as Record<string, unknown>)[key] : null; const value = root && typeof root === "object" ? (root as Record<string, unknown>)[nested] : null; return typeof value === "boolean" ? value : null; } catch { return null; } }

export function undecidedFields(contract: SessionContract): string[] { return CONTRACT_FIELDS.filter((field) => contract[field] === null); }
