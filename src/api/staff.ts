/**
 * /v1/staff — 社員名簿 (役職権限登録リスト) API。
 *
 *   GET    /v1/staff                     名簿 + 役職/権限の凡例 + サマリ
 *   POST   /v1/staff                     手動登録 (まだ発言していないユーザに役職を先付け)
 *   PATCH  /v1/staff/:platform/:userId   役職 / メモの更新
 *   DELETE /v1/staff/:platform/:userId   名簿から削除 (次の発言で ヒラ社員 として再記録される)
 *
 * 認証は他の /v1 と同じ loopback 前提。 名簿そのものが権限の正本なので、 ここを
 * 触れるのは WebUI (loopback) のみという扱いにする。
 */

import { Hono } from "hono";
import { z } from "zod";

import type { StaffPlatform, StaffRepo } from "../db/staff-repo.js";
import {
  CAPABILITY_LABEL,
  CAPABILITY_MIN_ROLE,
  STAFF_CAPABILITIES,
  STAFF_ROLES,
  STAFF_ROLE_LABEL,
  capabilitiesForRole,
} from "../staff/roles.js";

const PlatformSchema = z.enum(["discord", "slack"]);
const RoleSchema = z.enum(["staff", "manager", "executive"]);

const CreateSchema = z.object({
  platform: PlatformSchema,
  platform_user_id: z.string().trim().min(1).max(64),
  display_name: z.string().max(200).optional(),
  profile_name: z.string().max(200).optional(),
  role: RoleSchema,
  note: z.string().max(2000).optional(),
});

const PatchSchema = z.object({
  role: RoleSchema.optional(),
  note: z.string().max(2000).optional(),
}).refine((value) => value.role !== undefined || value.note !== undefined, {
  message: "role or note is required",
});

export interface StaffApiDeps {
  repo: StaffRepo;
}

/** 役職 → 何ができるか。 WebUI が権限表を描くための静的な凡例。 */
function roleLegend() {
  return STAFF_ROLES.map((role) => ({
    role,
    label: STAFF_ROLE_LABEL[role],
    capabilities: capabilitiesForRole(role).map((capability) => ({
      capability,
      label: CAPABILITY_LABEL[capability],
    })),
  }));
}

function capabilityLegend() {
  return STAFF_CAPABILITIES.map((capability) => ({
    capability,
    label: CAPABILITY_LABEL[capability],
    min_role: CAPABILITY_MIN_ROLE[capability],
    min_role_label: STAFF_ROLE_LABEL[CAPABILITY_MIN_ROLE[capability]],
  }));
}

export function staffRouter(deps: StaffApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const platformQuery = c.req.query("platform");
    const platform = PlatformSchema.safeParse(platformQuery);
    // 未知の platform を黙って「全件」に落とすと、 絞り込んだつもりの一覧に他 platform の
    // 社員が混ざる。 指定があって不正なときは弾く (未指定は従来どおり全件)。
    if (platformQuery !== undefined && !platform.success) {
      return c.json({ error: "invalid_platform" }, 400);
    }
    const counts = deps.repo.counts();
    return c.json({
      members: deps.repo.list(platform.success ? { platform: platform.data } : {}),
      counts,
      // 執行役員が 0 人だとキルスイッチを誰も踏めない。 WebUI で警告を出すための旗。
      has_executive: counts.discord.executive + counts.slack.executive > 0,
      roles: roleLegend(),
      capabilities: capabilityLegend(),
    });
  });

  app.post("/", async (c) => {
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const member = deps.repo.upsertManual({
      platform: parsed.data.platform,
      platformUserId: parsed.data.platform_user_id,
      displayName: parsed.data.display_name,
      profileName: parsed.data.profile_name,
      role: parsed.data.role,
      note: parsed.data.note,
    });
    if (!member) return c.json({ error: "invalid_user_id" }, 400);
    return c.json({ member }, 201);
  });

  app.patch("/:platform/:userId", async (c) => {
    const platform = PlatformSchema.safeParse(c.req.param("platform"));
    if (!platform.success) return c.json({ error: "invalid_platform" }, 400);
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    // Hono は path param を既にデコード済み。 ここで再度デコードすると `%` を含む ID が
    // 壊れ、 不正な escape (`%zz`) では URIError で 500 になる。
    const member = deps.repo.update(
      platform.data as StaffPlatform,
      c.req.param("userId"),
      parsed.data,
    );
    if (!member) return c.json({ error: "not_found" }, 404);
    return c.json({ member });
  });

  app.delete("/:platform/:userId", (c) => {
    const platform = PlatformSchema.safeParse(c.req.param("platform"));
    if (!platform.success) return c.json({ error: "invalid_platform" }, 400);
    const removed = deps.repo.remove(
      platform.data as StaffPlatform,
      c.req.param("userId"),
    );
    return c.json({ ok: removed }, removed ? 200 : 404);
  });

  return app;
}
