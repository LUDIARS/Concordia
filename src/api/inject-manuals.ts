/**
 * /v1/admin/inject-manuals API。 kind 別 Inject マニュアル (delegation の協調コンテキスト
 * へ差し込む作業マニュアル) の read / update。 kind は固定語彙 (追加・削除は不可)。
 * /v1/admin/* の adminAuth middleware (app.ts) に乗る。
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  INJECT_MANUAL_KINDS,
  isInjectManualKind,
  type InjectManualsRepo,
} from "../db/inject-manuals-repo.js";

/** content の上限 (バイト)。 プロンプト肥大の安全弁。 */
const MAX_CONTENT_BYTES = 32 * 1024;

const PutSchema = z.object({ content: z.string() });

export interface InjectManualsApiDeps {
  repo: InjectManualsRepo;
}

export function injectManualsRouter(deps: InjectManualsApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json({ manuals: deps.repo.list() });
  });

  app.put("/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (!isInjectManualKind(kind)) {
      return c.json({ error: "unknown_kind", kinds: INJECT_MANUAL_KINDS }, 400);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = PutSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    }
    if (Buffer.byteLength(parsed.data.content, "utf8") > MAX_CONTENT_BYTES) {
      return c.json({ error: "content_too_large", max_bytes: MAX_CONTENT_BYTES }, 400);
    }
    const manual = deps.repo.upsert(kind, parsed.data.content, Date.now());
    return c.json({ manual });
  });

  return app;
}
