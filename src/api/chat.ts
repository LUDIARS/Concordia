/**
 * /v1/chat API.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { ChatRepo, ChatChannel } from "../db/chat-repo.js";
import type { Dispatcher } from "../dispatcher.js";
import { isActionableSuggestion } from "../chat-actionable.js";

const PostSchema = z.object({
  channel: z.enum(["chitchat", "consultation", "system"]),
  text: z.string().min(1).max(2000),
  session_id: z.string().nullable().optional(),
  author_label: z.string().min(1).max(64),
  in_reply_to: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export interface ChatApiDeps {
  chat: ChatRepo;
  dispatcher: Dispatcher;
}

export function chatRouter(deps: ChatApiDeps): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PostSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const actionable = isActionableSuggestion(parsed.data.text);
    const msg = deps.chat.insert({
      channel: parsed.data.channel as ChatChannel,
      session_id: parsed.data.session_id ?? null,
      author_label: parsed.data.author_label,
      text: parsed.data.text,
      in_reply_to: parsed.data.in_reply_to ?? null,
      is_actionable: actionable,
      metadata: parsed.data.metadata ? JSON.stringify(parsed.data.metadata) : null,
    });

    deps.dispatcher.onChatPosted({
      id: msg.id,
      channel: msg.channel,
      session_id: msg.session_id,
      text: msg.text,
      author_label: msg.author_label,
      is_actionable: actionable,
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
    const actionable = isActionableSuggestion(parsed.data.text);
    const msg = deps.chat.insert({
      channel: parsed.data.channel as ChatChannel,
      session_id: parsed.data.session_id ?? null,
      author_label: parsed.data.author_label,
      text: parsed.data.text,
      in_reply_to: target.id,
      is_actionable: actionable,
      metadata: parsed.data.metadata ? JSON.stringify(parsed.data.metadata) : null,
    });
    deps.dispatcher.onChatPosted({
      id: msg.id,
      channel: msg.channel,
      session_id: msg.session_id,
      text: msg.text,
      author_label: msg.author_label,
      is_actionable: actionable,
    });
    return c.json({ message: serialize(msg) });
  });

  return app;
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
