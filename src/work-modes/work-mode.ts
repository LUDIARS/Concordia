import { contract } from './ontime-runtime.js'; /* augur-inject:import:9b685cce */
import augurContract_1ed9d2bc from './work-mode.contract.js'; /* augur-inject:contract-predicate:25f2770d */
/**
 * セッションが属する作業の進め方 (方式) の記録。
 *
 * @implements spec/feature/work-modes.md — CC-WM-INV-01
 *
 * 保存先は sessions.metadata JSON の `work_mode` キー (schema 列は足さない)。
 * 1 セッションは同時に 1 つの方式に属する。 別の方式が active なセッションへ
 * 別方式を書こうとしたら拒否し、 移す前の方式を閉じてから移すことを求める。
 *
 * SRP: 方式の型と metadata の読み書き (純粋マージ) だけ。 DB 反映は呼び出し側。
 */

export const WORK_MODES = [
  "interactive",
  "daily-goal-run",
  "delegation",
  "parttimer",
  "director-case",
  "consultation",
  "sprint",
] as const;

export type WorkMode = (typeof WORK_MODES)[number];

export interface WorkModeRecord {
  mode: WorkMode;
  /** 方式側の正本への参照 (例: daily goal id)。 正本を書き写さない (CC-WM-INV-02)。 */
  ref: string | null;
  since: number;
}

export type WithWorkModeResult =
  | { ok: true; metadata: string }
  | { ok: false; reason: "other_mode_active"; active: WorkModeRecord };

export function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === "string" && (WORK_MODES as readonly string[]).includes(value);
}

function parseMetadata(metadata: string | null | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** metadata から active な方式を読む。 未記録・壊れた値は null。 */
export function readWorkMode(metadata: string | null | undefined): WorkModeRecord | null {
  const value = parseMetadata(metadata).work_mode;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isWorkMode(row.mode)) return null;
  return {
    mode: row.mode,
    ref: typeof row.ref === "string" && row.ref ? row.ref : null,
    since: typeof row.since === "number" && Number.isFinite(row.since) ? row.since : 0,
  };
}

/**
 * 方式を記録した metadata を返す。 同じ方式・同じ参照の再記録は冪等。
 * 別の方式 (または同じ方式の別の参照) が active なら拒否する (CC-WM-INV-01)。
 */
export function withWorkMode(
  metadata: string | null | undefined,
  next: { mode: WorkMode; ref?: string | null; since: number },
): WithWorkModeResult {
  const base = parseMetadata(metadata);
  const active = readWorkMode(metadata);
  const ref = next.ref ?? null;
  if (active && (active.mode !== next.mode || active.ref !== ref)) {
    return { ok: false, reason: "other_mode_active", active };
  }
  if (active) return { ok: true, metadata: JSON.stringify(base) };
  return { ok: true, metadata: JSON.stringify({ ...base, work_mode: { mode: next.mode, ref, since: next.since } }) };
}
// @ts-expect-error augur-inject
withWorkMode = contract(withWorkMode, { ...augurContract_1ed9d2bc, contractId: 'wm-C-1', mode: 'observe', sample: 1, where: 'src/work-modes/work-mode.ts:67', rule: 'contract-wrap', id: '1ed9d2bc' }); /* augur-inject:contract-wrap:1ed9d2bc */

/** 指定した方式・参照が active なときだけ閉じる。 別方式の記録は消さない。 */
export function closeWorkMode(
  metadata: string | null | undefined,
  mode: WorkMode,
  ref: string | null = null,
): string {
  const base = parseMetadata(metadata);
  const active = readWorkMode(metadata);
  if (!active || active.mode !== mode || active.ref !== ref) return JSON.stringify(base);
  const { work_mode: _closed, ...rest } = base;
  return JSON.stringify(rest);
}
