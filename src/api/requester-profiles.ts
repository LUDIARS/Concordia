/**
 * /v1/requester-profiles — 依頼者メモ (投稿ユーザーごとのローカルな前提) の一覧・編集。
 *
 * loopback の管理 UI 専用。 中身をログ・イベントへ出さない (CC-DLG-INV-04)。
 *
 * @implements spec/feature/dialogue-context.md §7
 * @implements SPEC-DLG-PROFILES
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RequesterProfilesRepo } from "../db/requester-profiles-repo.js";

const IdentitySchema = z.object({
  subsidiary_id: z.string().trim().min(1).max(120).nullable().default(null),
  platform: z.enum(["discord", "slack"]),
  platform_user_id: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
});

const FieldsSchema = z.object({
  display_name: z.string().max(100).optional(),
  skill_level: z.string().max(200).optional(),
  activities: z.string().max(4_000).optional(),
  notes: z.string().max(8_000).optional(),
});

const PutSchema = IdentitySchema.merge(FieldsSchema).strict();

export function requesterProfilesRouter(deps: { repo: RequesterProfilesRepo }): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    // 無指定は本社。 子会社は明示 query のみ (/v1/teams と同じ)。
    const subsidiaryId = c.req.query("subsidiary_id")?.trim() || null;
    return c.json({ profiles: deps.repo.list(subsidiaryId) });
  });

  app.put("/", async (c) => {
    const parsed = PutSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_profile", detail: parsed.error.flatten() }, 400);
    const { subsidiary_id, platform, platform_user_id, ...fields } = parsed.data;
    const profile = deps.repo.upsert({ subsidiary_id, platform, platform_user_id }, fields);
    return c.json({ profile });
  });

  app.delete("/:id", (c) => (deps.repo.delete(c.req.param("id"))
    ? c.json({ ok: true })
    : c.json({ error: "profile_not_found" }, 404)));

  return app;
}
