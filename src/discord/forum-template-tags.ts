import { REST, Routes } from "discord.js";
import type { InputSchemaItem } from "../db/delegation-repo.js";
import { CONCORDIA_MANAGED_FORUM_TAG_NAME } from "./forum-system-tag.js";

export const MAX_FORUM_TEMPLATES = 7;
export const MAX_FORUM_TAG_NAME_LENGTH = 20;
/** Discord の forum あたりのタグ数上限。名前長と同値なのは偶然なので別定数にする。 */
export const MAX_FORUM_TAGS = 20;

export const SESSION_WORK_TAG_NAMES = ["設計相談", "実装", "レビュー", "テスト", "雑用"] as const;
export const SESSION_STATE_TAG_NAMES = ["作業中", "待機", "lost"] as const;
export const SESSION_RUNTIME_RULE_TAG_NAMES = ["Unity", "Webサービス", "アプリ"] as const;

export interface ForumTemplateTagSource {
  id: string;
  call_name: string;
  title: string;
  is_active: boolean | number;
  forum_tag: boolean | number;
  input_schema: InputSchemaItem[] | string;
}

export interface ForumTagValidationResult {
  ok: boolean;
  error?: string;
}

export function forumTemplateTagName(template: Pick<ForumTemplateTagSource, "title" | "call_name">): string {
  return template.title.trim() || template.call_name;
}

export function validateForumTemplateTags(templates: readonly ForumTemplateTagSource[]): ForumTagValidationResult {
  const enabled = templates.filter((template) => Boolean(template.is_active) && Boolean(template.forum_tag));
  if (enabled.length > MAX_FORUM_TEMPLATES) {
    return { ok: false, error: `forum_tag templates must be at most ${MAX_FORUM_TEMPLATES}` };
  }

  const reservedLabels = new Set(
    [
      ...SESSION_WORK_TAG_NAMES,
      ...SESSION_STATE_TAG_NAMES,
      ...SESSION_RUNTIME_RULE_TAG_NAMES,
      CONCORDIA_MANAGED_FORUM_TAG_NAME,
    ]
      .map((label) => label.toLocaleLowerCase()),
  );
  const labels = new Set<string>();
  for (const template of enabled) {
    const label = forumTemplateTagName(template);
    if (!label) return { ok: false, error: `forum_tag template ${template.call_name} requires a title` };
    if (label.length > MAX_FORUM_TAG_NAME_LENGTH) {
      return {
        ok: false,
        error: `forum_tag title must be ${MAX_FORUM_TAG_NAME_LENGTH} characters or fewer: ${template.call_name}`,
      };
    }
    const normalized = label.toLocaleLowerCase();
    if (reservedLabels.has(normalized)) {
      return { ok: false, error: `forum_tag title is reserved: ${label}` };
    }
    if (labels.has(normalized)) return { ok: false, error: `duplicate forum_tag title: ${label}` };
    labels.add(normalized);

    const schema = parseInputSchema(template.input_schema);
    const missing = schema.find((item) => item.required && item.default === undefined);
    if (missing) {
      return {
        ok: false,
        error: `forum_tag template ${template.call_name} has required arg without default: ${missing.name}`,
      };
    }
  }
  return { ok: true };
}

export function forumTemplateDefaultArgs(template: Pick<ForumTemplateTagSource, "input_schema">): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const item of parseInputSchema(template.input_schema)) {
    if (item.default !== undefined) args[item.name] = item.default;
  }
  return args;
}

export function desiredSessionForumTagNames(templates: readonly ForumTemplateTagSource[]): string[] {
  const validation = validateForumTemplateTags(templates);
  if (!validation.ok) throw new Error(validation.error);
  const templateNames = templates
    .filter((template) => Boolean(template.is_active) && Boolean(template.forum_tag))
    .map(forumTemplateTagName);
  return [
    ...SESSION_WORK_TAG_NAMES,
    ...SESSION_STATE_TAG_NAMES,
    ...SESSION_RUNTIME_RULE_TAG_NAMES,
    CONCORDIA_MANAGED_FORUM_TAG_NAME,
    ...templateNames,
  ];
}

interface DiscordForumChannelResponse {
  id: string;
  available_tags?: Array<{
    id: string;
    name: string;
    moderated?: boolean;
    emoji_id?: string | null;
    emoji_name?: string | null;
  }>;
}

export type ForumSiteTagSkipReason = "too_long" | "conflict" | "limit";

export interface ForumSiteTagMerge {
  /** base + 採用した拠点タグ (この順)。 */
  names: string[];
  /** 採用した拠点タグだけ。必須タグと分けて扱いたい呼び出し側向け。 */
  accepted: string[];
  skipped: Array<{ name: string; reason: ForumSiteTagSkipReason }>;
}

/**
 * 拠点タグを既存のタグ列へ足す際の唯一の判定。
 *
 * 同じ方針を Bot 起動時のレイアウト同期と管理 API 側の同期で二重に書くと、
 * 「片方だけタグが出る」ずれが起きる。落とした理由は呼び出し側が warn を出せるよう
 * skipped で返す (黙って消えると「タグを付けたのに効かない」原因が追えない)。
 */
export function mergeForumSiteTags(
  baseNames: readonly string[],
  siteNames: readonly string[],
): ForumSiteTagMerge {
  const names = [...baseNames];
  const accepted: string[] = [];
  const used = new Set(baseNames.map((name) => name.toLocaleLowerCase()));
  const skipped: Array<{ name: string; reason: ForumSiteTagSkipReason }> = [];
  for (const name of siteNames) {
    // 切り詰めると別 PC の名前と衝突しうるので、長すぎる名前は作らずに落とす。
    if (!name || name.length > MAX_FORUM_TAG_NAME_LENGTH) { skipped.push({ name, reason: "too_long" }); continue; }
    if (used.has(name.toLocaleLowerCase())) { skipped.push({ name, reason: "conflict" }); continue; }
    if (names.length >= MAX_FORUM_TAGS) { skipped.push({ name, reason: "limit" }); continue; }
    used.add(name.toLocaleLowerCase());
    names.push(name);
    accepted.push(name);
  }
  return { names, accepted, skipped };
}

export async function syncSessionForumTemplateTags(input: {
  token: string;
  forumId: string;
  templates: readonly ForumTemplateTagSource[];
  /** Villa から取得した active 拠点のPC名タグ。 */
  siteTags?: readonly string[];
  rest?: Pick<REST, "get" | "patch">;
}): Promise<{ forum_id: string; tags: string[] }> {
  if (!input.token) throw new Error("Discord token is not configured");
  if (!input.forumId) throw new Error("Session forum is not initialized");
  const { names: tagNames } = mergeForumSiteTags(
    desiredSessionForumTagNames(input.templates),
    input.siteTags ?? [],
  );
  const rest = input.rest ?? new REST({ version: "10" }).setToken(input.token);
  const current = await rest.get(Routes.channel(input.forumId)) as DiscordForumChannelResponse;
  const byName = new Map((current.available_tags ?? []).map((tag) => [tag.name, tag]));
  const availableTags = tagNames.map((name) => {
    const existing = byName.get(name);
    return existing
      ? {
          id: existing.id,
          name,
          moderated: existing.moderated ?? false,
          emoji_id: existing.emoji_id ?? null,
          emoji_name: existing.emoji_name ?? null,
        }
      : { name, moderated: false };
  });
  await rest.patch(Routes.channel(input.forumId), { body: { available_tags: availableTags } });
  return { forum_id: input.forumId, tags: tagNames };
}

function parseInputSchema(value: InputSchemaItem[] | string): InputSchemaItem[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as InputSchemaItem[] : [];
  } catch {
    return [];
  }
}
