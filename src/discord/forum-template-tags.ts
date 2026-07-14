import { REST, Routes } from "discord.js";
import type { InputSchemaItem } from "../db/delegation-repo.js";

export const MAX_FORUM_TEMPLATES = 10;
export const MAX_FORUM_TAG_NAME_LENGTH = 20;

export const SESSION_WORK_TAG_NAMES = ["設計相談", "実装", "レビュー", "テスト", "雑用"] as const;
export const SESSION_STATE_TAG_NAMES = ["作業中", "待機", "lost"] as const;

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
  return [...SESSION_WORK_TAG_NAMES, ...SESSION_STATE_TAG_NAMES, ...templateNames];
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

export async function syncSessionForumTemplateTags(input: {
  token: string;
  forumId: string;
  templates: readonly ForumTemplateTagSource[];
  rest?: Pick<REST, "get" | "patch">;
}): Promise<{ forum_id: string; tags: string[] }> {
  if (!input.token) throw new Error("Discord token is not configured");
  if (!input.forumId) throw new Error("Session forum is not initialized");
  const tagNames = desiredSessionForumTagNames(input.templates);
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
