import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import type { ForumProjectTarget } from "./forum-project-code.js";
import { forumTemplateDefaultArgs, forumTemplateTagName } from "./forum-template-tags.js";
import { callConcordia } from "./commands/_util.js";

const FORUM_SPAWN_TRIGGER_PREFIX = "discord-forum";

export interface ForumSpawnThread {
  id: string;
  guildId: string;
  parentId: string | null;
  ownerId: string | null;
  name: string;
  appliedTags: string[];
  parent: { availableTags: Array<{ id: string; name: string }> } | null;
  fetchStarterMessage: () => Promise<{ content: string } | null>;
  send: (options: { content: string; allowedMentions?: { parse: never[] } }) => Promise<unknown>;
}

export interface ForumSpawnDeps {
  sessionForumId: string;
  botUserId: string;
  concordiaUrl: string;
  templates: () => Promise<DelegationTemplateLite[]>;
  resolveProjectTarget: (title: string, body: string) => ForumProjectTarget | null;
  hasExistingRun: (triggeredBy: string) => boolean;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export async function handleForumSpawnThread(deps: ForumSpawnDeps, thread: ForumSpawnThread): Promise<void> {
  if (thread.parentId !== deps.sessionForumId || !thread.ownerId || thread.ownerId === deps.botUserId) return;
  const triggeredBy = buildForumSpawnTrigger(thread.guildId, thread.id);
  if (deps.hasExistingRun(triggeredBy)) {
    deps.log.info(`forum-spawn duplicate ignored thread=${thread.id}`);
    return;
  }

  const templates = (await deps.templates()).filter((template) => template.is_active && template.forum_tag);
  const selected = selectForumSpawnTemplate(thread.appliedTags, thread.parent?.availableTags ?? [], templates);
  if (selected.kind === "missing") {
    const available = templates.map(forumTemplateTagName).join(" / ") || "（現在利用可能なテンプレなし）";
    await reply(thread, `起動テンプレのタグが必要です。タグを付けて新しい投稿を作成してください。\n利用可能: ${available}`);
    return;
  }
  if (selected.kind === "ambiguous") {
    await reply(thread, `起動テンプレタグは1つだけ選んでください: ${selected.names.join(" / ")}`);
    return;
  }

  const starter = await thread.fetchStarterMessage();
  if (!starter) {
    await reply(thread, "最初の投稿を取得できなかったため、セッションを起動できませんでした。");
    return;
  }
  const body = starter.content.trim();
  const project = deps.resolveProjectTarget(thread.name, body);
  const result = await callConcordia<{
    ok: boolean;
    run: { id: string; status: string };
    spawn_pid: number | null;
  }>(deps.concordiaUrl, "POST", "/v1/delegation/invoke", {
    call_name: selected.template.call_name,
    args: forumTemplateDefaultArgs({ input_schema: selected.template.input_schema ?? [] }),
    cwd: project?.cwd,
    extra_prompt: buildForumSpawnPrompt(thread.name, body),
    triggered_by: triggeredBy,
    spawn: true,
  });
  if ("error" in result || !result.ok) {
    const error = "error" in result ? result.error : "delegation invoke failed";
    deps.log.warn(`forum-spawn failed thread=${thread.id} template=${selected.template.call_name}: ${error}`);
    await reply(thread, `セッション起動に失敗しました: ${error}`);
    return;
  }
  deps.log.info(
    `forum-spawn requested thread=${thread.id} run=${result.run.id} template=${selected.template.call_name} ` +
    `project=${project?.project ?? "template-default"}`,
  );
  await reply(thread, `Cc がセッションを起動しました（template: \`${selected.template.call_name}\`, run: \`${result.run.id}\`）。`);
}

export function selectForumSpawnTemplate(
  appliedTagIds: readonly string[],
  availableTags: readonly { id: string; name: string }[],
  templates: readonly DelegationTemplateLite[],
):
  | { kind: "missing" }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "selected"; template: DelegationTemplateLite } {
  const appliedNames = new Set(
    availableTags.filter((tag) => appliedTagIds.includes(tag.id)).map((tag) => tag.name.toLocaleLowerCase()),
  );
  const matches = templates.filter((template) => appliedNames.has(forumTemplateTagName(template).toLocaleLowerCase()));
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length > 1) return { kind: "ambiguous", names: matches.map(forumTemplateTagName) };
  return { kind: "selected", template: matches[0] };
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

async function reply(thread: ForumSpawnThread, content: string): Promise<void> {
  await thread.send({ content: content.slice(0, 1900), allowedMentions: { parse: [] } });
}
