/**
 * `/v1/admin/settings` — 設定レジストリの読み書き API (W5-2)。
 *
 * GET はセクション分けした全項目 (現在値 + 出所)、 PUT はキー単位の更新。
 * secret は **値を返さず** `set: true|false` だけを返す (redaction は resolve 層で行う)。
 *
 * 受け付けられない更新は黙って無視せず 400 で理由を返す。 「保存したのに効かない」 を作らない。
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  persistSettingUpdate,
  prepareSettingUpdate,
  type PreparedSettingUpdate,
  type SettingUpdateError,
  type SettingsDbWriter,
} from "../config/settings/apply.js";
import { listSettingsBySection } from "../config/settings/registry.js";
import type { SettingsDbReader } from "../config/settings/resolve.js";

export interface SettingsApiDeps {
  reader: SettingsDbReader;
  writer: SettingsDbWriter;
  /** 変更を即座に効かせたい消費者へ通知する (購読の張り替え等)。 省略可。 */
  onChanged?: (keys: string[]) => void;
}

const UpdateSchema = z.object({
  updates: z.record(z.unknown()).refine((value) => Object.keys(value).length > 0, {
    message: "updates must not be empty",
  }),
});

export function settingsRouter(deps: SettingsApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ sections: listSettingsBySection(deps.reader) }));

  app.put("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    }

    // 1 件でも受け付けられない更新があれば**何も書かずに**返す。 部分適用は
    // 「どこまで保存されたか分からない」 状態を作るため採らない。
    const entries = Object.entries(parsed.data.updates);
    const prepared: PreparedSettingUpdate[] = [];
    const rejected: SettingUpdateError[] = [];
    for (const [key, value] of entries) {
      const result = prepareSettingUpdate(key, value);
      if (!result.ok) {
        rejected.push(result.error);
        continue;
      }
      const unavailable = deps.writer.checkWritable(result.update.target, result.update.stored !== null);
      if (unavailable) {
        rejected.push({ code: "backend_unavailable", key, detail: unavailable });
        continue;
      }
      prepared.push(result.update);
    }
    if (rejected.length > 0) return c.json({ error: "rejected", rejected }, 400);

    try {
      deps.writer.transaction(() => {
        for (const update of prepared) persistSettingUpdate(update, deps.writer);
      });
    } catch {
      // DB 例外の詳細にはローカルパス等が含まれ得るため API へは出さない。
      return c.json({ error: "persistence_failed" }, 503);
    }
    deps.onChanged?.(entries.map(([key]) => key));
    return c.json({ ok: true, sections: listSettingsBySection(deps.reader) });
  });

  return app;
}
