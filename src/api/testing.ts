/**
 * /v1/testing — 起動テスト / 再起動の宣言 (一報) API。
 *
 * ルール: 再起動・起動テストは Excubitor 経由でプロジェクト本体フォルダのみで行い、
 * 実行前にここへ claim を宣言する。 Concordia が「いま何がテスト中か」 の正本を持ち、
 * 同一サービスへの並行テストを検知したら両セッションへ警告 inject して交通整備する。
 *
 *   POST /v1/testing/claim   { session_id, service, branch?, note? }
 *   POST /v1/testing/release { session_id, service? }   (service 省略 = 全解放)
 *   GET  /v1/testing         → { claims: [...] }
 */

import { Hono } from "hono";
import { z } from "zod";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { injectTestingNotice } from "../testing/notify.js";
import { openTestingClaim, releaseTestingClaims } from "../testing/claim-lifecycle.js";

const ClaimSchema = z.object({
  session_id: z.string().min(1),
  service: z.string().min(1).max(64),
  branch: z.string().max(200).nullable().optional(),
  note: z.string().max(500).optional(),
});

const ReleaseSchema = z.object({
  session_id: z.string().min(1),
  service: z.string().min(1).max(64).optional(),
});

export interface TestingApiDeps {
  claims: TestingClaimsRepo;
  sessions: SessionsRepo;
  log?: { info: (m: string) => void; warn: (m: string) => void };
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export function testingRouter(deps: TestingApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json({ claims: deps.claims.listActive(nowSec()) });
  });

  app.post("/claim", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ClaimSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const { session_id, service, branch, note } = parsed.data;
    const { claim, conflicts } = openTestingClaim(deps.claims, {
      service,
      sessionId: session_id,
      branch: branch ?? deps.sessions.findSession(session_id)?.branch ?? null,
      note,
      now: nowSec(),
    });
    if (conflicts.length > 0) {
      // 交通整備: 双方に相手の存在を知らせる (advisory — 強制ロックはしない)。
      const holders = conflicts.map((x) => `${x.session_id} (${x.note || "note なし"})`).join(", ");
      injectTestingNotice(
        deps.sessions, session_id,
        `⚠️ テスト交通整備: サービス「${service}」は現在 ${holders} もテスト中です。競合しないよう調整してください。`,
      );
      for (const other of conflicts) {
        injectTestingNotice(
          deps.sessions, other.session_id,
          `⚠️ テスト交通整備: サービス「${service}」のテストを ${session_id} も開始しました (${note || "note なし"})。競合しないよう調整してください。`,
        );
      }
      deps.log?.warn(`testing claim conflict service=${service} claimer=${session_id} holders=${conflicts.length}`);
    } else {
      deps.log?.info(`testing claim service=${service} session=${session_id}`);
    }
    return c.json({ ok: true, claim, conflicts });
  });

  app.post("/release", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ReleaseSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const released = releaseTestingClaims(deps.claims, {
      sessionId: parsed.data.session_id,
      service: parsed.data.service ?? null,
      now: nowSec(),
    });
    deps.log?.info(`testing release session=${parsed.data.session_id} service=${parsed.data.service ?? "*"} released=${released}`);
    return c.json({ ok: true, released });
  });

  return app;
}
