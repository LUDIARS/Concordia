import type { RunClaudeFn } from "../rules/claude-runner.js";
import { extractJson } from "../rules/claude-runner.js";
import type { DelegationTemplateLite } from "./delegation-template-cache.js";

const FORUM_SELECTOR_MODEL = "sonnet";
const FORUM_SELECTOR_TIMEOUT_MS = 45_000;

export type ForumDelegationSelection =
  | { ok: true; template: DelegationTemplateLite }
  | { ok: false; error: string };

export interface ForumDelegationSelectionInput {
  title: string;
  body: string;
  templates: readonly DelegationTemplateLite[];
}

/** Forum 投稿を active forum_tag template へ分類する one-shot selector。 */
export async function selectForumDelegationTemplate(
  runClaude: RunClaudeFn,
  input: ForumDelegationSelectionInput,
): Promise<ForumDelegationSelection> {
  const candidates = input.templates.filter((template) => template.is_active && template.forum_tag === true);
  if (candidates.length === 0) {
    return { ok: false, error: "利用可能な Forum 起動テンプレがありません。" };
  }

  let result: Awaited<ReturnType<RunClaudeFn>>;
  try {
    result = await runClaude(buildForumDelegationSelectorPrompt(input.title, input.body, candidates), {
      model: FORUM_SELECTOR_MODEL,
      timeoutMs: FORUM_SELECTOR_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, error: `起動テンプレの選択に失敗しました: ${(error as Error).message}` };
  }
  if (!result.ok) {
    return { ok: false, error: "起動テンプレの選択に失敗しました。" };
  }

  const parsed = extractJson(result.stdout);
  const callName = readCallName(parsed);
  if (!callName) {
    return { ok: false, error: "起動テンプレの選択結果が不正です。" };
  }
  const template = candidates.find((candidate) => candidate.call_name === callName);
  if (!template) {
    return { ok: false, error: `選択された起動テンプレ \`${callName}\` は利用できません。` };
  }
  return { ok: true, template };
}

export function buildForumDelegationSelectorPrompt(
  title: string,
  body: string,
  templates: readonly DelegationTemplateLite[],
): string {
  const candidateJson = templates.map((template) => ({
    call_name: template.call_name,
    title: template.title,
    description: template.description ?? "",
    provider: template.target_provider ?? "",
    model: template.model ?? "",
  }));
  return [
    "Discord Forum の依頼に最適な Delegation template を候補から1つだけ選んでください。",
    "候補外を選ばず、説明文や Markdown を付けず、JSON object だけを返してください。",
    '出力形式: {"call_name":"候補のcall_name"}',
    `候補: ${JSON.stringify(candidateJson)}`,
    `投稿タイトル: ${title.trim()}`,
    "投稿本文:",
    body.trim() || "（本文なし）",
  ].join("\n");
}

function readCallName(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const callName = (value as { call_name?: unknown }).call_name;
  return typeof callName === "string" && callName.trim() ? callName.trim() : null;
}
