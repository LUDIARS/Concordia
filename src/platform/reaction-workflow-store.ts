/**
 * カスタムワークフロー JSON (`<workspaceRoot>/.claude/custom-reaction-workflows.json`) の
 * 読み書き。 自由プロンプト種別 (add-as-workflow) と スキル種別 (設計 §10.2 C-9) の
 * 両方をここに保存する。
 *
 * Runner (`reaction-workflow.ts`) と設定 API (`api/reaction-skill-workflows.ts`) が
 * **同じパス解決**を通ることが要件 — 書いた先と読む先がずれると、 設定画面で保存した
 * 割り当てが発火しない。
 *
 * SRP: 永続化 (パス解決 / 読み / 検証 / 書き) のみ。 写像は reaction-workflow-skill.ts。
 *
 * @implements SPEC-RWF-SKILL-ENTRY
 * @implements SPEC-RWF-SKILL-ENTRY-SHAPE
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isReservedNonActionEmoji,
  type CustomPromptWorkflowEntry,
  type CustomSkillWorkflowEntry,
  type CustomWorkflowEntry,
} from "./reaction-workflow-plan.js";
import { isWorkflowAction } from "./reaction-workflow-action.js";
import { isSafeSkillName } from "../skills/catalog.js";

/** 同一ファイルへの read-modify-write を直列化するプロセス内キュー。 */
const updateQueues = new Map<string, Promise<void>>();
let temporaryFileSequence = 0;

/**
 * 保存先。 workspaceRoot は Castra (`E:/Document/Ars`) なので `.claude/` はその直下。
 * add-as-workflow のプロンプトが案内している既定パスと同じ場所を指す。
 */
export function resolveCustomWorkflowsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".claude", "custom-reaction-workflows.json");
}

/** JSON の 1 要素を検証して正規化する。 不正な要素は null (呼び出し側で捨てる)。 */
export function normalizeCustomWorkflowEntry(raw: unknown): CustomWorkflowEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const emoji = typeof item.emoji === "string" ? item.emoji.trim() : "";
  if (!emoji || isReservedNonActionEmoji(emoji)) return null;

  if (item.kind === "skill") {
    const skill = typeof item.skill === "string" ? item.skill.trim() : "";
    if (!isSafeSkillName(skill)) return null;
    const entry: CustomSkillWorkflowEntry = {
      kind: "skill",
      emoji,
      skill,
      mode: item.mode === "headless" ? "headless" : "inject",
    };
    if (typeof item.args === "string" && item.args.trim() && !/[\r\n\0]/u.test(item.args)) {
      entry.args = item.args.trim();
    }
    if (typeof item.model === "string" && item.model.trim()) entry.model = item.model.trim();
    if (typeof item.cwd === "string" && item.cwd.trim()) entry.cwd = item.cwd.trim();
    if (isWorkflowAction(item.action)) entry.action = item.action;
    if (typeof item.label === "string" && item.label.trim()) entry.label = item.label.trim();
    return entry;
  }

  if (typeof item.prompt !== "string") return null;
  const entry: CustomPromptWorkflowEntry = {
    emoji,
    label: typeof item.label === "string" ? item.label : "",
    prompt: item.prompt,
  };
  if (typeof item.model === "string" && item.model.trim()) entry.model = item.model.trim();
  if (typeof item.cwd === "string" && item.cwd.trim()) entry.cwd = item.cwd.trim();
  return entry;
}

/** JSON 全体を検証する (配列でなければ空)。 */
export function normalizeCustomWorkflows(parsed: unknown): CustomWorkflowEntry[] {
  if (!Array.isArray(parsed)) return [];
  const out: CustomWorkflowEntry[] = [];
  for (const raw of parsed) {
    const entry = normalizeCustomWorkflowEntry(raw);
    if (entry) out.push(entry);
  }
  return out;
}

/** 読み込む。 不在 / parse 失敗はどちらも空配列 (RWF を止めない)。 */
export async function readCustomWorkflows(path: string): Promise<CustomWorkflowEntry[]> {
  try {
    return normalizeCustomWorkflows(JSON.parse(await readFile(path, "utf-8")) as unknown);
  } catch {
    return [];
  }
}

/** 書き戻す (UTF-8、 インデント 2)。 ディレクトリが無ければ作る。 */
export async function writeCustomWorkflows(
  path: string,
  entries: readonly CustomWorkflowEntry[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${++temporaryFileSequence}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => { /* 書き込み前・rename 後なら一時ファイルは無い。 */ });
    throw error;
  }
}

/**
 * 同一 JSON の read-modify-write を失われた更新なしで行う。設定 API と migration は
 * 必ずこの境界を通し、更新途中のプロセス停止でも既存ファイルを壊さない。
 */
export async function updateCustomWorkflows(
  path: string,
  update: (entries: readonly CustomWorkflowEntry[]) => readonly CustomWorkflowEntry[],
): Promise<CustomWorkflowEntry[]> {
  const previous = updateQueues.get(path) ?? Promise.resolve();
  let result: CustomWorkflowEntry[] = [];
  const current = previous
    .catch(() => { /* 先行更新の失敗で後続更新まで永久に止めない。 */ })
    .then(async () => {
      const existing = await readCustomWorkflows(path);
      result = normalizeCustomWorkflows(update(existing));
      await writeCustomWorkflows(path, result);
    });
  updateQueues.set(path, current);
  try {
    await current;
    return result;
  } finally {
    if (updateQueues.get(path) === current) updateQueues.delete(path);
  }
}
