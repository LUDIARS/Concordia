/**
 * prompt event からセッションの current_task (タイトル) を決める業務判断 (SPEC-SESSION-PROMPT-TITLE)。
 *
 * hook は UserPromptSubmit の本文先頭を `summary` として送る。 そこには人の指示だけでなく
 * Cc の方針更新・pasted_content・task-notification・自動確認などの制御注入も届くため、
 * そのまま current_task にするとタイトルが注入文で上書きされる (2026-10-07 neco 指摘)。
 * ここでは制御注入を除外し、人の指示だけを 1 行のタイトルにする。 I/O を持たない純関数。
 */

/** タイトルの最大文字数。 Discord の topic / Slack カードで 1 行に収まる長さ。 */
export const PROMPT_TITLE_MAX = 80;

export type PromptTitleDecision =
  | { kind: "control" }
  | { kind: "human"; title: string; body: string };

/** 行頭がこれで始まる prompt は Cc / ハーネス / Claude Code 由来の制御注入。 */
const CONTROL_PREFIXES: readonly string[] = [
  "[Cc ",
  "[自動確認]",
  "[SYSTEM NOTIFICATION",
  "# Phase boundary handoff",
  "⚠️ ブランチ切替",
  "次タスクを Actio から取得",
];

/** `<pasted_content ...>` / `<task-notification>` / `<system-reminder>` などのタグで始まる注入。 */
const CONTROL_TAG = /^<[a-z][a-z0-9_-]*[\s>]/i;

/** Discord 中継が付ける「「<名前>」さんからの指示:」の前置き。 */
const REQUESTER_PREFIX = /^「[^」\n]{1,40}」さんからの指示[:：]\s*/;

export function decidePromptTitle(text: string): PromptTitleDecision {
  const trimmed = text.trim();
  if (!trimmed || isControlPrompt(trimmed)) return { kind: "control" };
  const body = trimmed.replace(REQUESTER_PREFIX, "").trim();
  if (!body || isControlPrompt(body)) return { kind: "control" };
  const firstLine = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const title = clip(collapseSpaces(firstLine));
  return title ? { kind: "human", title, body } : { kind: "control" };
}

/** Context must be explicitly understood; prose and uncertain results never become titles. */
export function normalizeSummarizedTitle(raw: string): string | null {
  let result: unknown;
  try { result = JSON.parse(raw); } catch { return null; }
  if (!result || typeof result !== "object") return null;
  const candidate = result as { understood?: unknown; title?: unknown };
  if (candidate.understood !== true || typeof candidate.title !== "string") return null;
  const title = candidate.title.trim();
  if (!title || Array.from(title).length > 40 || /[\r\n@<>`]/u.test(title) || isControlPrompt(title)) return null;
  return title;
}

function isControlPrompt(text: string): boolean {
  return CONTROL_TAG.test(text) || CONTROL_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string): string {
  return text.length <= PROMPT_TITLE_MAX ? text : `${text.slice(0, PROMPT_TITLE_MAX - 1)}…`;
}
