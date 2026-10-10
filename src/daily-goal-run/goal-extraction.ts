/**
 * 投稿の読み取り port と、 ヘッドレス Claude CLI (`claude -p`) による実装。
 *
 * @implements spec/feature/daily-goal-run.md — 2. ゴール・受入条件を読み取る / CC-DG-INV-09
 *
 * LLM には本文に書かれていることだけを、 項目ごとの引用付きで JSON にさせる。 返った値は
 * 信用せず、 use case が extraction-guard で引用を検査する。 失敗・時間切れは推測で埋めず
 * 失敗として返す。
 */

import { extractJson } from "../rules/claude-runner.js";
import { PERMISSION_KEYS, type ExtractedGoal, type GoalPermissions } from "./domain.js";

export type ExtractionResult = { ok: true; extracted: ExtractedGoal } | { ok: false; error: string };

export interface GoalExtractionPort {
  extract(text: string): Promise<ExtractionResult>;
}

/** ヘッドレス実行。 API キーを使わない既存の Claude CLI 呼び出し (runClaude) を注入する。 */
export type HeadlessRunner = (prompt: string, opts: { timeoutMs: number; conversationOnly: boolean; model?: string }) =>
  Promise<{ ok: boolean; stdout: string }>;

/** 短いと無言で死ぬため 60 秒以上にする。 */
export const EXTRACTION_TIMEOUT_MS = 90_000;

export function buildExtractionPrompt(text: string): string {
  return [
    "次の Discord 投稿は、ある人がその日の作業目標を書いたものです。投稿に書かれていることだけを JSON で返してください。",
    "書かれていない項目は推測で作らず、空にしてください。特に受入条件をゴール文から推測して作ってはいけません。",
    "各項目には、その根拠となる投稿本文の部分をそのまま (一字一句変えずに) quotes に入れてください。",
    "出力は JSON オブジェクト 1 つだけ。形式:",
    '{"project":"<プロジェクト名または略称 | 空>","goalText":"<その日に達成すること | 空>","acceptance":["<受入条件>"],',
    '"permissions":{"merge":false,"test":false,"service":false,"deploy":false},"actioTaskIds":["<Actio task ID>"],',
    '"quotes":{"project":"<本文の引用>","goalText":"<本文の引用>","acceptance.0":"<本文の引用>","permissions.test":"<本文の引用>"}}',
    "許可 (merge=マージ / test=テスト / service=サービス操作 / deploy=反映) は本文で明示的に許しているものだけ true。",
    "",
    "--- 投稿 ---",
    text,
    "--- ここまで ---",
  ].join("\n");
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];
}

/** LLM の JSON を ExtractedGoal に整える。 形が違えば null。 */
export function parseExtractionOutput(stdout: string): ExtractedGoal | null {
  const json = extractJson(stdout);
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const rawPermissions = (o.permissions && typeof o.permissions === "object" ? o.permissions : {}) as Record<string, unknown>;
  const permissions = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, rawPermissions[key] === true])) as unknown as GoalPermissions;
  const rawQuotes = (o.quotes && typeof o.quotes === "object" ? o.quotes : {}) as Record<string, unknown>;
  const quotes = Object.fromEntries(Object.entries(rawQuotes).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const project = typeof o.project === "string" ? o.project.trim() : "";
  const goalText = typeof o.goalText === "string" ? o.goalText.trim() : "";
  return {
    ...(project ? { project } : {}),
    ...(goalText ? { goalText } : {}),
    acceptance: strings(o.acceptance), permissions, actioTaskIds: strings(o.actioTaskIds), quotes,
  };
}

export function createLlmGoalExtraction(run: HeadlessRunner, opts: { model?: string; timeoutMs?: number } = {}): GoalExtractionPort {
  return {
    async extract(text) {
      try {
        const result = await run(buildExtractionPrompt(text), {
          timeoutMs: Math.max(60_000, opts.timeoutMs ?? EXTRACTION_TIMEOUT_MS), conversationOnly: true,
          ...(opts.model ? { model: opts.model } : {}),
        });
        if (!result.ok) return { ok: false, error: "読み取りの実行に失敗しました (時間切れを含む)" };
        const extracted = parseExtractionOutput(result.stdout);
        return extracted ? { ok: true, extracted } : { ok: false, error: "読み取りの結果を解釈できませんでした" };
      } catch (error) {
        return { ok: false, error: `読み取りの実行に失敗しました: ${String(error).slice(0, 300)}` };
      }
    },
  };
}
