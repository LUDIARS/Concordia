/**
 * /v1/chat API.
 */

import { Hono } from "hono";
import os from "node:os";
import { z } from "zod";
import type { ChatRepo, ChatChannel } from "../db/chat-repo.js";
import { isActionableSuggestion } from "../chat-actionable.js";
import { eventBus } from "../events.js";
import { buildAttachmentRoots, createAttachmentGuard } from "../shared/attachment-paths.js";
import { configuredAttachmentRoots, isAttachmentEnforced } from "../config/attachment-policy.js";

const PostSchema = z.object({
  channel: z.enum(["chitchat", "consultation", "報告", "ぼやき", "system"]),
  text: z.string().min(1).max(2000),
  session_id: z.string().nullable().optional(),
  author_label: z.string().min(1).max(64),
  in_reply_to: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  /** spatial UI 用: "world"=全員に届く / "local"=自分の周囲だけ. 既定 "world". */
  scope: z.enum(["world", "local"]).optional(),
  /**
   * Lictor が握る送信先 Discord channel ID (spec/discord-lictor-relay.md)。
   * 指定されると egress は session→channel の DB ルックアップを経ず、 この
   * channel に直接 webhook 送信する (返信混線の根治)。
   */
  discord_channel_id: z.string().min(1).optional(),
  /**
   * Concordia サーバと同一ホスト上のファイル絶対パス一覧。
   * egress が読み込んで Discord webhook の files に添付する。最大 10 件。
   * 存在しないパスは egress で warn して skip される。
   */
  attachment_paths: z.array(z.string().min(1).max(500)).max(10).optional(),
});

/**
 * discord_channel_id / attachment_paths を metadata に畳み込む (egress が読む)。
 * metadata.webhook_username / metadata.webhook_avatar_url を指定すると、Discord
 * Forum webhook の表示名・画像を投稿単位で上書きできる。
 */
function buildMeta(parsed: z.infer<typeof PostSchema>, scope: string): string {
  const merged: Record<string, unknown> = {
    ...(parsed.metadata ?? {}),
    scope,
  };
  if (parsed.discord_channel_id) merged.discord_channel_id = parsed.discord_channel_id;
  if (parsed.attachment_paths?.length) merged.attachment_paths = parsed.attachment_paths;
  return JSON.stringify(merged);
}

export interface ChatApiDeps {
  chat: ChatRepo;
  resolveWorkspaceRoots: () => string[];
}

export function chatRouter(deps: ChatApiDeps): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PostSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const attachmentError = await validateAttachments(parsed.data.attachment_paths, deps);
    if (attachmentError) return c.json(attachmentError, 400);

    const actionable = isActionableSuggestion(parsed.data.text);
    const scope = parsed.data.scope ?? "world";
    const metadataJson = buildMeta(parsed.data, scope);
    const msg = deps.chat.insert({
      channel: parsed.data.channel as ChatChannel,
      session_id: parsed.data.session_id ?? null,
      author_label: parsed.data.author_label,
      text: parsed.data.text,
      in_reply_to: parsed.data.in_reply_to ?? null,
      is_actionable: actionable,
      metadata: metadataJson,
    });

    eventBus.emit({
      type: "chat.posted",
      message_id: msg.id,
      channel: msg.channel,
      author_label: msg.author_label,
      session_id: msg.session_id,
      ts: msg.ts,
      is_actionable: actionable,
      scope,
    });

    return c.json({ message: serialize(msg) });
  });

  app.get("/", (c) => {
    const q = c.req.query();
    const channel = q.channel as ChatChannel | undefined;
    const since = q.since ? Number(q.since) : undefined;
    const limit = q.limit ? Number(q.limit) : 50;
    const list = deps.chat.list({ channel, since, limit });
    return c.json({ messages: list.map(serialize) });
  });

  app.post("/:id/reply", async (c) => {
    const target = deps.chat.findById(Number(c.req.param("id")));
    if (!target) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PostSchema.safeParse({
      ...body,
      channel: body?.channel ?? target.channel,
      in_reply_to: target.id,
    });
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const attachmentError = await validateAttachments(parsed.data.attachment_paths, deps);
    if (attachmentError) return c.json(attachmentError, 400);
    const actionable = isActionableSuggestion(parsed.data.text);
    const scope = parsed.data.scope ?? "world";
    const metadataJson = buildMeta(parsed.data, scope);
    const msg = deps.chat.insert({
      channel: parsed.data.channel as ChatChannel,
      session_id: parsed.data.session_id ?? null,
      author_label: parsed.data.author_label,
      text: parsed.data.text,
      in_reply_to: target.id,
      is_actionable: actionable,
      metadata: metadataJson,
    });
    eventBus.emit({
      type: "chat.posted",
      message_id: msg.id,
      channel: msg.channel,
      author_label: msg.author_label,
      session_id: msg.session_id,
      ts: msg.ts,
      is_actionable: actionable,
      scope,
    });
    return c.json({ message: serialize(msg) });
  });

  return app;
}

async function validateAttachments(
  paths: string[] | undefined,
  deps: ChatApiDeps,
): Promise<{ error: "attachment_paths_rejected"; rejected_count: number; reasons: string[] } | null> {
  if (!paths?.length) return null;
  const enforce = isAttachmentEnforced();
  const guard = createAttachmentGuard({
    roots: buildAttachmentRoots({
      workspaceRoots: deps.resolveWorkspaceRoots(),
      tempDir: os.tmpdir(),
      configuredRoots: configuredAttachmentRoots(),
    }),
    enforce,
  });
  const failures = (await Promise.all(paths.map((attachmentPath) => guard.check(attachmentPath))))
    .filter((result): result is Extract<typeof result, { ok: false }> => !result.ok);
  if (!failures.length || !enforce) return null;
  return {
    error: "attachment_paths_rejected",
    rejected_count: failures.length,
    reasons: [...new Set(failures.map((failure) => failure.reason))],
  };
}

function serialize(m: { id: number; channel: string; session_id: string | null; author_label: string; ts: number; text: string; in_reply_to: number | null; is_actionable: number; metadata: string | null }) {
  return {
    id: m.id,
    channel: m.channel,
    session_id: m.session_id,
    author_label: m.author_label,
    ts: m.ts,
    text: m.text,
    in_reply_to: m.in_reply_to,
    is_actionable: !!m.is_actionable,
    metadata: m.metadata ? safeParse(m.metadata) : null,
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
