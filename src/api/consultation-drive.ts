/**
 * 相談のファイル受け渡し API (spec/feature/tech-consultation.md §6.4)。 loopback 限定の管理 API。
 *
 *   POST /v1/consultations/:id/drive/open   相談者本人が Drive フォルダを作って自分のアカウントに共有する
 *   POST /v1/consultations/:id/drive/sync   相談者本人か権限者が受け取り・回答を同期する
 *
 * 本人確認 (actor_user_id) は Discord の操作者を Bot が渡す。 Drive の鍵は Cc 本体だけが持つ (Bot へ渡さない) ので、
 * 受け渡しはこの API を通す。 メールアドレスは保存もログ出力もしない。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

import { Hono } from "hono";
import { z } from "zod";
import type { DriveTransferErrorCode, DriveTransferService } from "../consultation/drive-transfer-service.js";

const ActorSchema = z.object({ actor_user_id: z.string().trim().regex(/^\d{5,32}$/) }).strict();
const OpenSchema = ActorSchema.extend({ email: z.string().trim().min(3).max(254) }).strict();

const STATUS: Readonly<Record<DriveTransferErrorCode, 400 | 403 | 404 | 409 | 502 | 503>> = {
  consultation_not_found: 404,
  not_requester: 403,
  not_allowed: 403,
  transfer_unavailable: 409,
  drive_not_configured: 503,
  invalid_email: 400,
  folder_not_opened: 409,
  drive_failed: 502,
};

export function consultationDriveRouter(deps: { drive: DriveTransferService }): Hono {
  const app = new Hono();

  app.post("/:id/drive/open", async (c) => {
    const parsed = OpenSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const result = await deps.drive.open({
      consultationId: c.req.param("id"),
      actorUserId: parsed.data.actor_user_id,
      email: parsed.data.email,
    });
    if (!result.ok) return c.json({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) }, STATUS[result.error]);
    return c.json({ folder_url: result.folder.url, created: result.created });
  });

  app.post("/:id/drive/sync", async (c) => {
    const parsed = ActorSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const result = await deps.drive.sync({ consultationId: c.req.param("id"), actorUserId: parsed.data.actor_user_id });
    if (!result.ok) return c.json({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) }, STATUS[result.error]);
    return c.json({
      folder_url: result.folder.url,
      imported: result.imported,
      delivered: result.delivered,
      skipped: result.skipped,
    });
  });

  return app;
}
