/**
 * 報告用プライベートチャンネルの API (spec/feature/private-channels.md §2)。 loopback 限定の管理 API。
 *
 *   POST /v1/discord/private-channels      受け付けて Bot に作らせる (新規 202 / 同じ key は 200)
 *   GET  /v1/discord/private-channels/:id  状態・チャンネル・URL
 *
 * 以後の投稿は `POST /v1/chat` に `discord_channel_id` を付けて送る (egress が ready のチャンネルだけ採用する)。
 *
 * @implements SPEC-PRIVCH-API
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { PrivateChannelsRepo } from "../db/private-channels-repo.js";
import type { ConcordiaEvent } from "../events.js";
import { privateChannelView, requestPrivateChannel } from "../platform/private-channel-request.js";

export interface PrivateChannelsApiDeps {
  repo: Pick<PrivateChannelsRepo, "create" | "find" | "findByKey">;
  adminUserId(): string | null;
  emit(event: ConcordiaEvent): void;
  now?: () => number;
}

export function privateChannelsRouter(deps: PrivateChannelsApiDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid_body" }, 400);
    const result = requestPrivateChannel({
      repo: deps.repo,
      adminUserId: deps.adminUserId,
      now,
      requestProvision: (row) => deps.emit({
        type: "discord.private_channel.requested",
        event_id: randomUUID(),
        private_channel_id: row.id,
        ts: Math.floor(now() / 1000),
      }),
    }, {
      name: body.name,
      viewer_user_ids: body.viewer_user_ids,
      text: body.text,
      key: body.key,
      session_id: body.session_id,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(privateChannelView(result.row), result.created ? 202 : 200);
  });

  app.get("/:id", (c) => {
    const row = deps.repo.find(c.req.param("id"));
    return row ? c.json(privateChannelView(row)) : c.json({ error: "private_channel_not_found" }, 404);
  });

  return app;
}
