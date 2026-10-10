/**
 * 構造化した書式の投稿を読む (純関数、 LLM を通さない)。
 *
 * @implements spec/feature/daily-goal-run.md — 2. ゴール・受入条件を読み取る
 *
 * 行頭の `プロジェクト:` `ゴール:` `受入条件:` `許可:` `task:` で項目を始める。 次の項目までの行は
 * 同じ項目の続き (受入条件は 1 行 1 件)。 引用 (quotes) には本文の値をそのまま入れる。
 */

import { PERMISSION_KEYS, type ExtractedGoal, type GoalPermissions, type PermissionKey } from "./domain.js";

type Key = "project" | "goal" | "acceptance" | "permissions" | "task";

const KEY_PATTERNS: Array<[RegExp, Key]> = [
  [/^(?:プロジェクト|project)\s*[:：]\s*(.*)$/i, "project"],
  [/^(?:ゴール|goal)\s*[:：]\s*(.*)$/i, "goal"],
  [/^(?:受入条件|受け入れ条件|acceptance)\s*[:：]\s*(.*)$/i, "acceptance"],
  [/^(?:許可|permissions?)\s*[:：]\s*(.*)$/i, "permissions"],
  [/^(?:task|tasks|actio|タスク)\s*[:：]\s*(.*)$/i, "task"],
];

const PERMISSION_WORDS: Array<[RegExp, PermissionKey]> = [
  [/^(?:マージ|merge)$/i, "merge"],
  [/^(?:テスト|test|tests)$/i, "test"],
  [/^(?:サービス操作|サービス|service)$/i, "service"],
  [/^(?:反映|デプロイ|deploy)$/i, "deploy"],
];

const BULLET = /^(?:[-*・•]|\d+[.)．）])\s*/;

function keyOf(line: string): [Key, string] | null {
  for (const [pattern, key] of KEY_PATTERNS) {
    const match = pattern.exec(line.trim());
    if (match) return [key, (match[1] ?? "").trim()];
  }
  return null;
}

/** 書式どおりの項目行 (プロジェクト / ゴール / 受入条件) が 1 行でもあれば構造化した投稿。 */
export function isStructuredPost(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const key = keyOf(line)?.[0];
    return key === "project" || key === "goal" || key === "acceptance";
  });
}

/** `許可:` の値。 書かれたものだけを可にし、 それ以外 (「なし」を含む) は不可。 */
export function parsePermissionWords(value: string): GoalPermissions {
  const permissions: GoalPermissions = { merge: false, test: false, service: false, deploy: false };
  for (const word of value.split(/[,、，\s/／]+/).map((w) => w.trim()).filter(Boolean)) {
    const hit = PERMISSION_WORDS.find(([pattern]) => pattern.test(word));
    if (hit) permissions[hit[1]] = true;
  }
  return permissions;
}

export function parseStructuredPost(text: string): ExtractedGoal {
  const sections = new Map<Key, string[]>();
  let current: Key | null = null;
  for (const line of text.split(/\r?\n/)) {
    const keyed = keyOf(line);
    if (keyed) {
      current = keyed[0];
      sections.set(current, keyed[1] ? [keyed[1]] : []);
      continue;
    }
    if (current && line.trim()) sections.get(current)!.push(line.trim());
  }
  const quotes: Record<string, string> = {};
  const project = sections.get("project")?.[0]?.trim();
  if (project) quotes.project = project;
  const goalLines = sections.get("goal") ?? [];
  const goalText = goalLines.join("\n").trim();
  if (goalText) quotes.goalText = goalLines[0]!;
  const acceptance = (sections.get("acceptance") ?? [])
    .flatMap((line) => line.split(/[;；]/))
    .map((item) => item.trim().replace(BULLET, "").trim())
    .filter(Boolean);
  acceptance.forEach((item, index) => { quotes[`acceptance.${index}`] = item; });
  const permissionText = (sections.get("permissions") ?? []).join(" ");
  const permissions = parsePermissionWords(permissionText);
  for (const key of PERMISSION_KEYS) if (permissions[key]) quotes[`permissions.${key}`] = permissionText;
  const actioTaskIds = [...new Set((sections.get("task") ?? []).join(" ").split(/[\s,、;]+/)
    .map((id) => id.trim().replace(/^actio:/i, "")).filter(Boolean))];
  return {
    ...(project ? { project } : {}),
    ...(goalText ? { goalText } : {}),
    acceptance, permissions, actioTaskIds, quotes,
  };
}
