/**
 * 確認フロー API。 Discord コマンド `/confirm` はここを HTTP で叩く。
 *
 * サービスの起動・停止を伴うので、 start/ok/ng は **testing claim** を必ず通す
 * (他セッションが同じサービスを触っていたら双方に警告 inject が飛ぶ)。
 *
 * spec/feature/develop-confirm-flow.md §6。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { ConfirmService } from "../release/confirm-service.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { openTestingClaim, releaseTestingClaims } from "../testing/claim-lifecycle.js";

const ActionSchema = z.object({
  service: z.string().min(1).max(64),
  /** 誰が操作したか (Discord ユーザ or セッション)。 testing claim の主体になる。 */
  session_id: z.string().max(120).optional(),
  reason: z.string().max(500).optional(),
});

export interface ConfirmApiDeps {
  service: ConfirmService;
  testingClaims?: TestingClaimsRepo;
}

export function confirmRouter(deps: ConfirmApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ confirms: deps.service.list() }));

  app.post("/:action{start|ok|ng}", async (c) => {
    const action = c.req.param("action") as "start" | "ok" | "ng";
    const body = await c.req.json().catch(() => null);
    const parsed = ActionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const { service, session_id, reason } = parsed.data;
    // 起動・停止を伴うので作業宣言する。 claim は advisory なので衝突しても止めない
    // (Concordia が両者に警告を流す)。
    const claimant = session_id ?? `confirm:${service}`;
    const now = Math.floor(Date.now() / 1000);
    if (deps.testingClaims) {
      openTestingClaim(deps.testingClaims, {
        service,
        sessionId: claimant,
        note: `confirm ${action}`,
        now,
      });
    }
    try {
      const result =
        action === "start" ? await deps.service.start(service, session_id ?? "web-admin")
        : action === "ok" ? await deps.service.ok(service, session_id ?? "web-admin")
        : await deps.service.ng(service, reason);
      return c.json(result, result.ok ? 200 : 409);
    } finally {
      if (deps.testingClaims) {
        releaseTestingClaims(deps.testingClaims, {
          sessionId: claimant,
          service,
          now: Math.floor(Date.now() / 1000),
        });
      }
    }
  });

  return app;
}
