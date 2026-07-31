/**
 * /v1/federation — マルチ拠点連合の管理 API (本社側、loopback 信頼境界)。
 *
 * この API は既存の /v1 面 (loopback 専用) にだけ生える。拠点からの inbound は
 * 連合 listener (src/federation/hq-listener.ts、別ポート) が受け、こちらへは来ない。
 *
 *   GET  /v1/federation                → 一覧 (登録 + ライブ接続状態 + 未配送数)
 *   POST /v1/federation/sites          → 拠点登録 + トークン発行 (平文はこの応答のみ)
 *   POST /v1/federation/sites/:id/revoke → 失効 (+ 接続中なら切断)
 *   PUT  /v1/federation/sites/:id/departments → 担当 guild の設定
 *   POST /v1/federation/sites/:id/config → 現在の設定を明示再配布
 */

import { Hono } from "hono";
import { z } from "zod";
import type { FederationSitesRepo } from "../db/federation-sites-repo.js";
import type { FederationOutboxRepo } from "../db/federation-outbox-repo.js";
import type { FederationConnections } from "../federation/hq-connections.js";
import { SITE_ID_PATTERN } from "../federation/protocol.js";
import { reportError } from "../errors.js";

const CreateSiteSchema = z.object({
  site_id: z.string().regex(SITE_ID_PATTERN, "site_id must match [a-z0-9][a-z0-9-]{1,63}"),
  name: z.string().max(200).nullable().optional(),
});
const DepartmentsSchema = z.object({
  departments: z.array(z.string().min(1).max(100)).max(100),
});

export interface FederationApiDeps {
  sites: FederationSitesRepo;
  outbox: FederationOutboxRepo;
  connections: FederationConnections;
  /** listener が有効か (env)。WebUI 表示用。 */
  listenerEnabled: boolean;
  /** 接続中拠点の強制切断 (listener 起動時のみ供給)。 */
  disconnectSite?: (siteId: string, code: "revoked") => void;
  redistributeConfig?: (siteId: string) => boolean;
}

export function federationRouter(deps: FederationApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const sites = deps.sites.list().map((row) => {
      const live = deps.connections.get(row.site_id);
      return {
        site_id: row.site_id,
        name: row.name,
        status: row.status,
        connection: live ? "online" : "offline",
        connected_at: live?.connectedAtSec ?? null,
        last_seen_at: live?.lastSeenSec ?? row.last_seen_at,
        last_connected_at: row.last_connected_at,
        site_version: live?.siteVersion ?? row.site_version,
        departments: row.departments,
        pending_events: deps.outbox.pendingCount(row.site_id),
        created_at: row.created_at,
        revoked_at: row.revoked_at,
      };
    });
    return c.json({ listener_enabled: deps.listenerEnabled, sites });
  });

  app.post("/sites", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSiteSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    if (deps.sites.find(parsed.data.site_id)) {
      return c.json({ error: "site_exists", site_id: parsed.data.site_id }, 409);
    }
    const { row, token } = deps.sites.create({
      siteId: parsed.data.site_id,
      name: parsed.data.name ?? null,
    });
    // token 平文はこの応答のみ。保存は暗号化済み (federation-sites-repo)。
    return c.json({ ok: true, site_id: row.site_id, token }, 201);
  });

  app.post("/sites/:id/revoke", (c) => {
    const siteId = c.req.param("id");
    const revoked = deps.sites.revoke(siteId);
    if (!revoked) return c.json({ error: "site_not_found_or_already_revoked", site_id: siteId }, 404);
    deps.disconnectSite?.(siteId, "revoked");
    return c.json({ ok: true, site_id: siteId });
  });

  app.put("/sites/:id/departments", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = DepartmentsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const siteId = c.req.param("id");
    if (!deps.sites.setDepartments(siteId, parsed.data.departments)) {
      return c.json({ error: "site_not_found", site_id: siteId }, 404);
    }
    // session_events は session 専用、Harness audit は tool 実行専用なので使わない。
    // errors 面は運用者へ即時に届き、割当変更の監査対象 (guild / site) を残せる。
    reportError("federation", "連合拠点の担当部署を更新しました", {
      site_id: siteId,
      departments: [...new Set(parsed.data.departments)],
    });
    return c.json({ ok: true, site_id: siteId, departments: [...new Set(parsed.data.departments)] });
  });

  app.post("/sites/:id/config", (c) => {
    const siteId = c.req.param("id");
    const site = deps.sites.find(siteId);
    if (!site || site.status !== "active") return c.json({ error: "site_not_found_or_revoked", site_id: siteId }, 404);
    return c.json({ ok: true, site_id: siteId, delivered: deps.redistributeConfig?.(siteId) ?? false });
  });

  return app;
}
