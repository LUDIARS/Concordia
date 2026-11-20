/**
 * 委託テンプレートの model に書かれた役割名 (opus / sonnet / haiku / fable / sol / astra / luna、
 * Claude は `[1m]` 接尾辞可) を、 spawn 直前に role map でモデル ID へ解決する。
 *
 * - 明示的なモデル ID (claude-opus-5-5 等) はそのまま通す (上書きの互換)。
 * - 役割名なのに解決できない (provider と系統が合わない / role map に無い) ときは止める。
 *   古い ID へ黙って戻すと、 対応表を更新しても旧モデルで起動し続けるため。
 *
 * @implements CC-MODEL-ROLE-MAP MRM-TPL-01..03
 */
import { contract } from './ontime-runtime.js'; /* augur-inject:import:7c1e5a20 */
import augurContract_3b9d0e41 from './template-model-role.contract.js'; /* augur-inject:contract-predicate:3b9d0e41 */
import type { RoleMap } from "./role-map.js";

export const CLAUDE_MODEL_ROLES = ["opus", "sonnet", "haiku", "fable"] as const;
export const CODEX_MODEL_ROLES = ["sol", "astra", "luna"] as const;

const ROLE_NAME = /^(opus|sonnet|haiku|fable|sol|astra|luna)(\[1m\])?$/;

export interface ParsedModelRole { role: string; suffix: string }

/** 役割名なら role と接尾辞を返す。 モデル ID・空・auto は null。 */
export function parseModelRole(model: string | null | undefined): ParsedModelRole | null {
  const match = ROLE_NAME.exec((model ?? "").trim().toLowerCase());
  return match ? { role: match[1]!, suffix: match[2] ?? "" } : null;
}

export type TemplateModelResolution =
  | { ok: true; model: string | null; role: string | null }
  | { ok: false; error: string };

export function resolveTemplateModel(input: {
  provider: string;
  model: string | null | undefined;
  roles: RoleMap["roles"];
}): TemplateModelResolution {
  const parsed = parseModelRole(input.model);
  if (!parsed) return { ok: true, model: input.model ?? null, role: null };
  const family = input.provider === "claude" ? "claude"
    : input.provider === "codex" || input.provider === "codex-sdk" ? "codex" : null;
  const roles = family === "claude" ? CLAUDE_MODEL_ROLES as readonly string[]
    : family === "codex" ? CODEX_MODEL_ROLES as readonly string[] : [];
  if (!family || !roles.includes(parsed.role) || (family === "codex" && parsed.suffix)) {
    return { ok: false, error: `delegation_model_role_unresolved:${parsed.role}${parsed.suffix} (provider ${input.provider})` };
  }
  const modelId = input.roles[family][parsed.role]?.trim();
  if (!modelId) return { ok: false, error: `delegation_model_role_unresolved:${parsed.role} (role map has no ${family} entry)` };
  return { ok: true, model: `${modelId}${parsed.suffix}`, role: parsed.role };
}
// @ts-expect-error augur-inject
resolveTemplateModel = contract(resolveTemplateModel, { ...augurContract_3b9d0e41, contractId: 'model-role-tpl-C-1', mode: 'observe', sample: 1, where: 'src/model-catalog/template-model-role.ts:34', rule: 'contract-wrap', id: '3b9d0e41' }); /* augur-inject:contract-wrap:3b9d0e41 */
