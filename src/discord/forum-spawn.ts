import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import type { ForumProjectTarget } from "./forum-project-code.js";
import {
  forumTemplateDefaultArgs,
  SESSION_RUNTIME_RULE_TAG_NAMES,
} from "./forum-template-tags.js";
import { callConcordia } from "./commands/_util.js";
import type { DelegationProvider } from "../db/delegation-repo.js";
import type { ForumDelegationSelectionInput, ForumDelegationSelection } from "./forum-delegation-selector.js";
import {
  hasConcordiaManagedForumTag,
  type ForumTagIdentity,
  type ForumTagState,
} from "./forum-system-tag.js";

const FORUM_SPAWN_TRIGGER_PREFIX = "discord-forum";

export interface ForumSpawnThread {
  id: string;
  guildId: string;
  parentId: string | null;
  ownerId: string | null;
  name: string;
  appliedTags: readonly string[];
  availableTags: readonly ForumTagIdentity[];
  fetchStarterMessage: () => Promise<{ content: string } | null>;
  fetchTagState: () => Promise<ForumTagState>;
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
  /** `claude -p --model sonnet` による one-shot template selector。 */
  selectTemplate: (input: ForumDelegationSelectionInput) => Promise<ForumDelegationSelection>;
  resolveProjectTarget: (title: string, body: string) => ForumProjectTarget | null;
  /** 通常の session spawn と同じ規則で、明示 cwd またはプロジェクトルートを解決する。 */
  resolveSpawnCwd: (provider: DelegationProvider, requested?: string) => string | undefined;
  /** Exact Discord user ID authorization for the thread owner. */
  isLaunchUserAllowed?: (userId: string) => boolean;
  hasExistingRun: (triggeredBy: string) => boolean;
  /** Cc の Forum 返信も必ず親 Forum webhook + thread_id で投稿する。 */
  postToThread: (threadId: string, content: string) => Promise<void>;
  /** Discord の ThreadCreate と starter message 作成競合を bounded retry するための差し替え口。 */
  wait?: (ms: number) => Promise<void>;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export async function handleForumSpawnThread(deps: ForumSpawnDeps, thread: ForumSpawnThread): Promise<void> {
  if (thread.parentId !== deps.sessionForumId) return;
  if (hasConcordiaManagedForumTag(thread)) {
    deps.log.info(`forum-spawn Cc-managed thread ignored thread=${thread.id}`);
    return;
  }
  if (!thread.ownerId || thread.ownerId === deps.botUserId) return;
  if (deps.isLaunchUserAllowed?.(thread.ownerId) !== true) {
    deps.log.warn(`forum-spawn unauthorized owner=${thread.ownerId} thread=${thread.id}`);
    await reply(deps, thread, "このユーザーにはセッション起動権限がありません。");
    return;
  }
  const triggeredBy = buildForumSpawnTrigger(thread.guildId, thread.id);
  if (deps.hasExistingRun(triggeredBy)) {
    deps.log.info(`forum-spawn duplicate ignored thread=${thread.id}`);
    return;
  }

  const starter = await fetchStarterWithRetry(thread, deps.wait);
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
  const templates = await deps.templates();
  const selection = await deps.selectTemplate({ title: thread.name, body, templates });
  if (!selection.ok) {
    deps.log.warn(`forum-spawn template selection failed thread=${thread.id}: ${selection.error}`);
    await reply(deps, thread, selection.error);
    return;
  }
  const template = selection.template;
  const provider = template.target_provider;
  if (!provider) {
    deps.log.warn(`forum-spawn selected template missing provider thread=${thread.id} template=${template.call_name}`);
    await reply(deps, thread, `起動テンプレ \`${template.call_name}\` の provider 設定がありません。`);
    return;
  }
  const cwd = deps.resolveSpawnCwd(provider, project?.cwd);
  if (!cwd) {
    await reply(deps, thread, `プロジェクト \`${project.project}\` の作業ディレクトリを解決できませんでした。設定を確認してください。`);
    return;
  }

  let freshTagState: ForumTagState;
  try {
    freshTagState = await thread.fetchTagState();
  } catch (error) {
    deps.log.warn(`forum-spawn tag refresh failed thread=${thread.id}: ${(error as Error).message}`);
    await reply(deps, thread, "Forum タグの最新状態を確認できなかったため、セッションを起動しませんでした。");
    return;
  }
  if (hasConcordiaManagedForumTag(freshTagState)) {
    deps.log.info(`forum-spawn explicit/Cc-managed thread ignored after refresh thread=${thread.id}`);
    return;
  }
  const activeRuntimeRules = activeRuntimeRuleNames(freshTagState);

  const result = await callConcordia<{
    ok: boolean;
    run: { id: string; status: string };
    spawn_pid: number | null;
  }>(deps.concordiaUrl, "POST", "/v1/delegation/invoke", {
    call_name: template.call_name,
    args: forumTemplateDefaultArgs({ input_schema: template.input_schema ?? [] }),
    cwd,
    extra_prompt: buildForumSpawnPrompt(thread.name, body, activeRuntimeRules),
    triggered_by: triggeredBy,
    spawn: true,
    subsidiary_id: deps.subsidiaryId ?? null,
    project: project.project,
    requester_discord_user_id: thread.ownerId,
    source_discord_guild_id: thread.guildId,
    source_discord_channel_id: thread.id,
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
  return /^\*\*(?:Session|TaskWorkflow)\*\* `[^`]+`/m.test(content)
    && /\*\*(?:Repo|Repository)\*\*/.test(content);
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

export function buildForumSpawnPrompt(
  title: string,
  body: string,
  activeRuntimeRules: readonly string[] = [],
): string {
  return [
    "## Discord Session forum request",
    `Title: ${title.trim()}`,
    ...(activeRuntimeRules.length > 0
      ? ["", `Active rules: ${activeRuntimeRules.join(", ")}`]
      : []),
    "",
    body.trim() || "（本文なし）",
  ].join("\n");
}

async function fetchStarterWithRetry(
  thread: Pick<ForumSpawnThread, "fetchStarterMessage">,
  wait: ((ms: number) => Promise<void>) | undefined,
): Promise<{ content: string } | null> {
  const sleep = wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const starter = await thread.fetchStarterMessage();
      if (starter) return starter;
    } catch {
      // ThreadCreate can precede starter message visibility and Discord may answer
      // Unknown Message instead of null. Treat both forms as the same short race.
    }
    if (attempt < 2) await sleep(200 * (attempt + 1));
  }
  return null;
}

function activeRuntimeRuleNames(state: ForumTagState): string[] {
  const selected = new Set(state.appliedTags);
  const allowed = new Set<string>(SESSION_RUNTIME_RULE_TAG_NAMES);
  return state.availableTags
    .filter((tag) => selected.has(tag.id) && allowed.has(tag.name))
    .map((tag) => tag.name);
}

async function reply(deps: ForumSpawnDeps, thread: ForumSpawnThread, content: string): Promise<void> {
  await deps.postToThread(thread.id, content.slice(0, 1900));
}
