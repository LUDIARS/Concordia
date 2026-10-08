import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { meetingLinkConfig } from "./config.js";
import type { MeetingLinkStore } from "./store.js";
import { redeemMeetingLink } from "./redeem.js";

const Request = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  meetingId: z.string().uuid(), audience: z.string().url().max(500) }).strict();
export function meetingLinkRouter(deps: { store: MeetingLinkStore; botConfig: () => { token: string | null; guildId: string | null } }): Hono {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 2048 }));
  app.post("/consume", async c => {
    c.header("Cache-Control", "no-store");
    if (!c.req.header("content-type")?.startsWith("application/json")) return c.json({ error: "json_required" }, 400);
    const parsed = Request.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const config = meetingLinkConfig();
    if (!config) return c.json({ error: "disabled" }, 503);
    const { code, meetingId, audience } = parsed.data;
    const bot = deps.botConfig();
    if (!bot.token || bot.guildId !== config.guildId) return c.json({ error: "guild_verifier_unavailable" }, 503);
    try {
      const identity = await redeemMeetingLink({ code, meetingId, audience }, { config, store: deps.store, member: async userId => {
      const response = await fetch("https://discord.com/api/v10/guilds/" + config.guildId + "/members/" + userId, {
        headers: { Authorization: "Bot " + bot.token }, redirect: "error", signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) return null;
      const member = z.object({ user: z.object({ id: z.string(), bot: z.boolean().optional() }), pending: z.boolean().optional() })
        .parse(await response.json());
      return { id: member.user.id, bot: member.user.bot ?? false, pending: member.pending ?? false };
      } });
      if (!identity) return c.json({ error: "invalid_or_expired" }, 403);
      return c.json(identity);
    } catch {
      return c.json({ error: "membership_unavailable" }, 503);
    }
  });
  return app;
}
