/**
 * バグバウンティ企画の API (spec/feature/bug-bounty.md §0 §8.2 §18.3)。
 *
 *   GET  /v1/bounty/events                    一覧 (段階付き、開始の新しい順)
 *   POST /v1/admin/bounty/events              作成
 *   PATCH /v1/admin/bounty/events/:id         編集 (渡した項目だけ)
 *   POST /v1/admin/bounty/events/:id/end      早期終了
 *
 * 書き込みは `/v1/admin/*` の adminAuth の配下 (WebUI の管理面 = 権限者)。 入力の形だけをここで検証し、
 * 期間・対象・開始済みの制約は use case (event-service.ts → event-policy.ts) が判定する。
 *
 * @implements SPEC-BOUNTY-EVENT
 * @implements SPEC-BOUNTY-WEBUI
 */

import { Hono } from "hono";
import { z } from "zod";
import type { BountyEventDraft } from "../bounty/event-policy.js";
import {
  BOUNTY_EVENT_CHANNELS,
  MAX_BOUNTY_EVENT_GUIDANCE_CHARS,
  MAX_BOUNTY_EVENT_PROJECTS,
  MAX_BOUNTY_EVENT_TITLE_CHARS,
} from "../bounty/event-policy.js";
import type { BountyEventError, BountyEventService, BountyEventView } from "../bounty/event-service.js";

/** 管理面の操作者として記録する名前 (bounty-admin.ts と同じ)。 */
const ADMIN_ACTOR = "webui-admin";

const Time = z.number().int().positive();
const Override = z.record(z.enum(["s1", "s2", "s3", "s4"]), z.number().int().min(0)).nullable();

const EventSchema = z.object({
  title: z.string().max(MAX_BOUNTY_EVENT_TITLE_CHARS * 2),
  starts_at: Time,
  ends_at: Time,
  projects: z.array(z.string().max(64)).max(MAX_BOUNTY_EVENT_PROJECTS * 2),
  channels: z.array(z.enum(BOUNTY_EVENT_CHANNELS as unknown as [string, ...string[]])).max(BOUNTY_EVENT_CHANNELS.length),
  guidance: z.string().max(MAX_BOUNTY_EVENT_GUIDANCE_CHARS * 2).optional(),
  reward_override: Override.optional(),
}).strict();

const EventPatchSchema = EventSchema.partial().strict();

const STATUS: Readonly<Record<BountyEventError, 400 | 404 | 409>> = {
  title_invalid: 400,
  guidance_invalid: 400,
  period_invalid: 400,
  projects_invalid: 400,
  unknown_project: 400,
  channels_invalid: 400,
  reward_override_invalid: 400,
  event_projects_reduced: 409,
  event_started: 409,
  event_ended: 409,
  event_not_found: 404,
  state_changed: 409,
};

export interface BountyEventsApiDeps {
  events: Pick<BountyEventService, "list" | "create" | "update" | "endEarly">;
}

/** 応答の形 (snake_case)。 */
export function bountyEventBody(event: BountyEventView): Record<string, unknown> {
  return {
    id: event.id,
    title: event.title,
    starts_at: event.startsAt,
    ends_at: event.endsAt,
    projects: event.projects,
    channels: event.channels,
    guidance: event.guidance,
    reward_override: event.rewardOverride,
    ended_early_at: event.endedEarlyAt,
    ended_by: event.endedBy,
    created_by: event.createdBy,
    created_at: event.createdAt,
    updated_at: event.updatedAt,
    phase: event.phase,
  };
}

function toDraft(input: z.infer<typeof EventPatchSchema>): BountyEventDraft {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.starts_at !== undefined ? { startsAt: input.starts_at } : {}),
    ...(input.ends_at !== undefined ? { endsAt: input.ends_at } : {}),
    ...(input.projects !== undefined ? { projects: input.projects } : {}),
    ...(input.channels !== undefined ? { channels: input.channels } : {}),
    ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
    ...(input.reward_override !== undefined ? { rewardOverride: input.reward_override } : {}),
  };
}

/** 一覧 (`/v1/bounty` の配下、報告の一覧と同じ管理面の読み出し)。 */
export function bountyEventsReadRouter(deps: Pick<BountyEventsApiDeps, "events">): Hono {
  const app = new Hono();
  app.get("/events", (c) => c.json({ events: deps.events.list().map(bountyEventBody) }));
  return app;
}

/** 作成・編集・早期終了 (`/v1/admin/bounty` の配下)。 */
export function bountyEventsAdminRouter(deps: BountyEventsApiDeps): Hono {
  const app = new Hono();

  app.post("/events", async (c) => {
    const parsed = EventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_event" }, 400);
    const result = deps.events.create(toDraft(parsed.data), ADMIN_ACTOR);
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    return c.json({ event: bountyEventBody(result.event) }, 201);
  });

  app.patch("/events/:id", async (c) => {
    const parsed = EventPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_event" }, 400);
    const result = deps.events.update(c.req.param("id"), toDraft(parsed.data));
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    return c.json({ event: bountyEventBody(result.event) });
  });

  app.post("/events/:id/end", (c) => {
    const result = deps.events.endEarly(c.req.param("id"), ADMIN_ACTOR);
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    return c.json({ event: bountyEventBody(result.event) });
  });

  return app;
}
