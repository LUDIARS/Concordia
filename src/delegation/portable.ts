/**
 * 1 つの delegation を JSON で持ち運ぶ (コピー/貼付) ための可搬フォーマット。
 *
 * グローバルテンプレ (delegation_templates) と子会社が所有する複製
 * (subsidiary_delegations) はどちらも同じ delegation 形なので、 共通の可搬 JSON に
 * シリアライズ/デシリアライズして、 テンプレ間・子会社間でコピーできるようにする
 * (spec/feature/subsidiary-delegation.md §4 / spec/delegation.md)。
 *
 * 受理は緩く (kind/version は任意、 余剰キーは無視)、 出力は常に kind/version 付き。
 */

import { z } from "zod";
import {
  DELEGATION_PROVIDERS,
  type DelegationProvider,
  type DelegationTemplateRow,
  parseInputSchema,
  parseRuntimeOptions,
  type InputSchemaItem,
} from "../db/delegation-repo.js";
import type { SubsidiaryDelegationRow } from "../db/subsidiary-repo.js";

export const PORTABLE_KIND = "concordia.delegation";
export const PORTABLE_VERSION = 1;

const InputSchemaItemSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean(),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

/** 貼付 (import) で受理する可搬 delegation。 kind/version は任意、 余剰キーは無視。 */
export const PortableDelegationSchema = z.object({
  kind: z.string().optional(),
  version: z.number().optional(),
  call_name: z.string().max(64).optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  target_provider: z.enum(
    DELEGATION_PROVIDERS as unknown as [DelegationProvider, ...DelegationProvider[]],
  ),
  model: z.string().max(120).nullable().optional(),
  runtime_options: z.record(z.unknown()).optional(),
  prompt_template: z.string().max(20000).optional(),
  input_schema: z.array(InputSchemaItemSchema).optional(),
  default_cwd: z.string().max(1000).nullable().optional(),
  project: z.string().max(200).nullable().optional(),
  emoji: z.string().max(8).optional(),
});

export type PortableDelegation = z.infer<typeof PortableDelegationSchema>;

/** 出力用の正規化済み可搬 delegation (kind/version + input_schema は配列)。 */
export interface PortableDelegationOut {
  kind: string;
  version: number;
  call_name: string;
  title: string;
  description: string;
  target_provider: DelegationProvider;
  model: string | null;
  runtime_options: Record<string, unknown>;
  prompt_template: string;
  input_schema: InputSchemaItem[];
  default_cwd: string | null;
  project: string | null;
  emoji: string;
}

export function templateToPortable(row: DelegationTemplateRow): PortableDelegationOut {
  return {
    kind: PORTABLE_KIND,
    version: PORTABLE_VERSION,
    call_name: row.call_name,
    title: row.title,
    description: row.description,
    target_provider: row.target_provider as DelegationProvider,
    model: row.model,
    runtime_options: parseRuntimeOptions(row.runtime_options_json),
    prompt_template: row.prompt_template,
    input_schema: parseInputSchema(row.input_schema),
    default_cwd: row.default_cwd,
    project: row.project,
    emoji: row.emoji,
  };
}

export function ownedToPortable(row: SubsidiaryDelegationRow): PortableDelegationOut {
  return {
    kind: PORTABLE_KIND,
    version: PORTABLE_VERSION,
    call_name: row.call_name,
    title: row.title,
    description: row.description,
    target_provider: row.target_provider as DelegationProvider,
    model: row.model,
    runtime_options: {},
    prompt_template: row.prompt_template,
    input_schema: parseInputSchema(row.input_schema),
    default_cwd: row.default_cwd,
    project: row.project,
    emoji: row.emoji,
  };
}

/** 可搬 JSON (unknown) を検証して正規化する。 失敗時は理由付きで返す (無言フォールバック禁止)。 */
export function parsePortable(
  input: unknown,
): { ok: true; data: PortableDelegation } | { ok: false; error: z.ZodError } {
  const parsed = PortableDelegationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error };
  return { ok: true, data: parsed.data };
}
