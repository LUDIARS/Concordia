import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import type { ForumProjectTarget } from "./forum-project-code.js";
import { forumTemplateDefaultArgs } from "./forum-template-tags.js";
import { callConcordia } from "./commands/_util.js";
import type { ForumSpawnProvider } from "../delegation/forum-provider-availability.js";

const FORUM_SPAWN_TRIGGER_PREFIX = "discord-forum";

/**
 * provider ごとの固定起動プラン。 タグ選択を廃し、 `pickProvider` (週間 rate-limit 枠の
 * 残量が多い方) だけで call_name と model/effort の overrides を決める。 codex は Terra、
 * claude は Sonnet-5 を常に high effort で使う (投稿内容による effort 分岐はしない
 * — neco 2026-07-18 指示)。
 */
const FORUM_PROVIDER_PLAN: Record<
  ForumSpawnProvider,
  { callName: string; overrides: { model?: string; reasoning_effort: string } }
> = {
  codex: { callName: "forum-codex-session", overrides: { model: "gpt-5.6-terra", reasoning_effort: "high" } },
  claude: { callName: "forum-claude-session", overrides: { reasoning_effort: "high" } },
};

export interface ForumSpawnThread {
  id: string;
  guildId: string;
  parentId: string | null;
  ownerId: string | null;
  name: string;
  fetchStarterMessage: () => Promise<{ content: string } | null>;
}

export interface ForumSpawnDeps {
  sessionForumId: string;
  botUserId: string;
  concordiaUrl: string;
  /**
   * このスレッドを処理している Bot インスタンス自身の子会社 (subsidiary) id。
   * 本社 Bot なら null。 spawn したセッションの metadata.subsidiary_id へ焼き込むために
   * `/v1/delegation/invoke` へ転送する (未指定だと子会社 Bot 経由の forum spawn が本社
   * セッションとして誤帰属し、 本社/子会社の可視範囲判定 (ownsSession) が壊れる)。
   */
  subsidiaryId?: string | null;
  templates: () => Promise<DelegationTemplateLite[]>;
  /** codex/claude のどちらが空いているかを返す (呼び出し側が週間 rate-limit 残量から判定する)。 */
  pickProvider: () => Promise<ForumSpawnProvider>;
  resolveProjectTarget: (title: string, body: string) => ForumProjectTarget | null;
  /** 通常の session spawn と同じ規則で、明示 cwd またはプロジェクトルートを解決する。 */
  resolveSpawnCwd: (provider: ForumSpawnProvider, requested?: string) => string | undefined;
  hasExistingRun: (triggeredBy: string) => boolean;
  /** Cc の Forum 返信も必ず親 Forum webhook + thread_id で投稿する。 */
  postToThread: (threadId: string, content: string) => Promise<void>;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export async function handleForumSpawnThread(deps: ForumSpawnDeps, thread: ForumSpawnThread): Promise<void> {
  if (thread.parentId !== deps.sessionForumId || !thread.ownerId || thread.ownerId === deps.botUserId) return;
  const triggeredBy = buildForumSpawnTrigger(thread.guildId, thread.id);
  if (deps.hasExistingRun(triggeredBy)) {
    deps.log.info(`forum-spawn duplicate ignored thread=${thread.id}`);
    return;
  }

  const provider = await deps.pickProvider();
  const plan = FORUM_PROVIDER_PLAN[provider];
  const templates = await deps.templates();
  const template = templates.find((t) => t.call_name === plan.callName && t.is_active);
  if (!template) {
    deps.log.warn(`forum-spawn missing/inactive template call_name=${plan.callName}`);
    await reply(deps, thread, `起動テンプレ \`${plan.callName}\` が見つからないか無効化されています。管理者に連絡してください。`);
    return;
  }

  const starter = await thread.fetchStarterMessage();
  if (!starter) {
    await reply(deps, thread, "最初の投稿を取得できなかったため、セッションを起動できませんでした。");
    return;
  }
  const body = starter.content.trim();
  if (isConcordiaSessionStarter(body)) {
    deps.log.info(`forum-spawn webhook-created Session thread ignored thread=${thread.id}`);
    return;
  }
  const project = deps.resolveProjectTarget(thread.name, body);
  if (!project) {
    deps.log.info(`forum-spawn project unresolved thread=${thread.id}`);
    await reply(
      deps,
      thread,
      "作業対象プロジェクトを特定できませんでした。プロジェクトコードまたはリポジトリ名を本文かタイトルに追記してください。Castra 直下では Session を起動しません。",
    );
    return;
  }
  const cwd = deps.resolveSpawnCwd(provider, project?.cwd);
  if (!cwd) {
    await reply(deps, thread, `プロジェクト \`${project.project}\` の作業ディレクトリを解決できませんでした。設定を確認してください。`);
    return;
  }
  const result = await callConcordia<{
    ok: boolean;
    run: { id: string; status: string };
    spawn_pid: number | null;
  }>(deps.concordiaUrl, "POST", "/v1/delegation/invoke", {
    call_name: template.call_name,
    args: forumTemplateDefaultArgs({ input_schema: template.input_schema ?? [] }),
    cwd,
    extra_prompt: buildForumSpawnPrompt(thread.name, body),
    triggered_by: triggeredBy,
    spawn: true,
    overrides: plan.overrides,
    subsidiary_id: deps.subsidiaryId ?? null,
  });
  if ("error" in result || !result.ok) {
    const error = "error" in result ? result.error : "delegation invoke failed";
    deps.log.warn(`forum-spawn failed thread=${thread.id} template=${template.call_name}: ${error}`);
    await reply(deps, thread, `セッション起動に失敗しました: ${error}`);
    return;
  }
  deps.log.info(
    `forum-spawn requested thread=${thread.id} run=${result.run.id} template=${template.call_name} ` +
    `provider=${provider} project=${project?.project ?? "workspace-default"} cwd=${cwd ?? "unresolved"}`,
  );
  await reply(deps, thread, `Cc がセッションを起動しました（provider: \`${provider}\`, run: \`${result.run.id}\`）。`);
}

export function isConcordiaSessionStarter(content: string): boolean {
  return /^\*\*(?:Session|TaskWorkflow)\*\* `[^`]+`/m.test(content) && content.includes("**Repository**");
}

export function buildForumSpawnTrigger(guildId: string, threadId: string): string {
  return `${FORUM_SPAWN_TRIGGER_PREFIX}:${guildId}:${threadId}`;
}

export function parseForumSpawnTrigger(value: string | null | undefined): { guildId: string; threadId: string } | null {
  if (!value) return null;
  const [prefix, guildId, threadId, ...rest] = value.split(":");
  if (prefix !== FORUM_SPAWN_TRIGGER_PREFIX || !guildId || !threadId || rest.length > 0) return null;
  return { guildId, threadId };
}

export function buildForumSpawnPrompt(title: string, body: string): string {
  return [
    "## Discord Session forum request",
    `Title: ${title.trim()}`,
    "",
    body.trim() || "（本文なし）",
  ].join("\n");
}

async function reply(deps: ForumSpawnDeps, thread: ForumSpawnThread, content: string): Promise<void> {
  await deps.postToThread(thread.id, content.slice(0, 1900));
}
