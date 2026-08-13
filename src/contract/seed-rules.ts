import type { SessionRow } from "../shared/types.js";
import { CONTRACT_FIELDS, type SessionContract } from "./schema.js";

function decided<T>(value: T, rationale: string) { return { value, decided_by: "seed" as const, rationale, genius_card_ids: [] }; }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "task"; }
const PLAN_PATTERN = /(?:migration|schema|auth|認証|削除|delete|複数リポ|new service|新規サービス)/iu;

export function seedSessionContract(session: SessionRow, task: string, defaultSupervisor: string, teamId?: string | null): SessionContract {
  const mode = PLAN_PATTERN.test(task) ? "plan" : null;
  const model = metadataString(session.metadata, "model");
  const effort = metadataString(session.metadata, "effort_level");
  return {
    version: 1,
    mode: mode ? decided(mode, "高リスク作業を決定論で検出") : null,
    team: decided(teamId ?? null, teamId ? "repository has one configured team" : "team 未導入・未所属を明示"),
    model: decided(model ?? session.provider, model ? "現在の session runtime" : "現在の session provider"),
    effort: decided(effort ?? "medium", effort ? "現在の session runtime" : "既定 effort"),
    work_branch: decided(session.branch ?? `feat/${slug(task)}`, "checkout branch または task slug"),
    work_location: mode ? decided("worktree", "plan mode の決定論規則") : null,
    scope_dirs: decided(["."], "登録 repo root からの相対スコープ"),
    acceptance: mode ? decided("plan", "plan mode の受け入れ経路") : null,
    goal_and_go: decided({ enabled: metadataBoolean(session.metadata, "goal_and_go", "enabled") ?? false }, "spawn option"),
    continuation: decided("requeue", "プロセス使い捨てを既定とする"),
    testing_claim: mode ? decided({ required: false, service: null }, "plan は testing claim 不要") : null,
    supervisor: decided(defaultSupervisor, "CONCORDIA_DEFAULT_SUPERVISOR"),
  };
}

function metadataString(raw: string | null, key: string): string | null { try { const value = raw ? (JSON.parse(raw) as Record<string, unknown>)[key] : null; return typeof value === "string" && value ? value : null; } catch { return null; } }
function metadataBoolean(raw: string | null, key: string, nested: string): boolean | null { try { const root = raw ? (JSON.parse(raw) as Record<string, unknown>)[key] : null; const value = root && typeof root === "object" ? (root as Record<string, unknown>)[nested] : null; return typeof value === "boolean" ? value : null; } catch { return null; } }

export function undecidedFields(contract: SessionContract): string[] { return CONTRACT_FIELDS.filter((field) => contract[field] === null); }
