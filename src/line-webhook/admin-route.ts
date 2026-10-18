/**
 * LINE webhook の管理 API (spec/feature/line-webhook-relay.md §管理 API と設定画面)。
 *
 * チャネルの秘密値 2 つ・サービスの中継トークンは書き込むだけで読み返さない (設定済みかどうかだけを返す)。
 * サービスの呼びかけの言葉は設定 `services.line_webhook_targets` の該当行だけを書き換える。
 * トークごとの紐付けはトーク ID の先頭数文字だけを返し、 ふだんの相手の変更と解除ができる。
 *
 * @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面
 */

import { Hono } from "hono";
import {
  clearLineChannelSecret,
  clearServiceRelayToken,
  describeLineChannelSecrets,
  isLineChannelSecretField,
  readServiceRelayToken,
  setLineChannelSecret,
  setServiceRelayToken,
  type LineChannelSecretStore,
} from "./channel-secrets.js";
import { LINE_WEBHOOK_PATH_PREFIX } from "./route.js";
import type { LineTalkLinkRow, LineTalkLinkStore } from "./talk-links.js";
import {
  listLineChannels,
  normalizeKeywords,
  replaceTargetKeywords,
  validateLineWebhookTargetEntries,
  type LineWebhookTarget,
} from "./targets.js";

/** チャネルアクセストークン (長期) でも収まる長さ。 これを超える値は貼り間違いとして弾く。 */
const MAX_SECRET_LENGTH = 4096;
/** 一覧に出すトーク ID の先頭の文字数。 */
const TALK_ID_PREFIX_LENGTH = 5;

export interface LineWebhookAdminDeps {
  targets: () => readonly LineWebhookTarget[];
  store: LineChannelSecretStore;
  talkLinks: LineTalkLinkStore;
  /** 設定 `services.line_webhook_targets` の生値 (JSON 配列の文字列)。 */
  readTargetsSetting: () => string | null;
  writeTargetsSetting: (entries: readonly string[]) => void;
}

export function lineWebhookAdminRouter(deps: LineWebhookAdminDeps): Hono {
  const app = new Hono();

  app.get("/channels", (c) => {
    const targets = deps.targets();
    return c.json({
      channels: listLineChannels(targets).map((name) => ({
        name,
        webhook_path: `${LINE_WEBHOOK_PATH_PREFIX}/${name}`,
        services: targets.filter((target) => target.channel === name).map((target) => target.name),
        ...describeLineChannelSecrets(deps.store, name),
      })),
    });
  });

  app.put("/channels/:channel/secrets/:field", async (c) => {
    const channel = c.req.param("channel");
    const field = c.req.param("field");
    if (!listLineChannels(deps.targets()).includes(channel)) return c.json({ error: "unknown_channel" }, 404);
    if (!isLineChannelSecretField(field)) return c.json({ error: "unknown_field" }, 404);
    const value = await readSecretValue(c.req.raw);
    if (value === null) return c.json({ error: "invalid_value", detail: `1〜${MAX_SECRET_LENGTH} 文字で入力します` }, 400);
    setLineChannelSecret(deps.store, channel, field, value);
    return c.json({ ok: true, ...describeLineChannelSecrets(deps.store, channel) });
  });

  app.delete("/channels/:channel/secrets/:field", (c) => {
    const channel = c.req.param("channel");
    const field = c.req.param("field");
    if (!listLineChannels(deps.targets()).includes(channel)) return c.json({ error: "unknown_channel" }, 404);
    if (!isLineChannelSecretField(field)) return c.json({ error: "unknown_field" }, 404);
    clearLineChannelSecret(deps.store, channel, field);
    return c.json({ ok: true, ...describeLineChannelSecrets(deps.store, channel) });
  });

  app.get("/services", (c) => c.json({
    services: deps.targets().map((target) => describeService(deps, target)),
  }));

  app.put("/services/:service/relay-token", async (c) => {
    const target = findService(deps, c.req.param("service"));
    if (!target) return c.json({ error: "unknown_service" }, 404);
    const value = await readSecretValue(c.req.raw);
    if (value === null) return c.json({ error: "invalid_value", detail: `1〜${MAX_SECRET_LENGTH} 文字で入力します` }, 400);
    setServiceRelayToken(deps.store, target.name, value);
    return c.json({ ok: true, relay_token_set: true });
  });

  app.delete("/services/:service/relay-token", (c) => {
    const target = findService(deps, c.req.param("service"));
    if (!target) return c.json({ error: "unknown_service" }, 404);
    clearServiceRelayToken(deps.store, target.name);
    return c.json({ ok: true, relay_token_set: false });
  });

  app.put("/services/:service/keywords", async (c) => {
    const target = findService(deps, c.req.param("service"));
    if (!target) return c.json({ error: "unknown_service" }, 404);
    const body = await c.req.json().catch(() => null) as { keywords?: unknown } | null;
    const keywords = normalizeKeywords(body?.keywords);
    if (typeof keywords === "string") return c.json({ error: "invalid_keywords", detail: keywords }, 400);
    const entries = replaceTargetKeywords(deps.readTargetsSetting(), target.name, keywords);
    // 設定が読めない (手で壊された等) なら書き換えない。
    if (!entries || validateLineWebhookTargetEntries(entries) !== null) {
      return c.json({ error: "targets_setting_unreadable" }, 409);
    }
    deps.writeTargetsSetting(entries);
    return c.json({ ok: true, keywords });
  });

  app.get("/links", (c) => c.json({ links: deps.talkLinks.list().map(describeLink) }));

  app.put("/links/:id/default", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || !deps.talkLinks.setDefault(id)) return c.json({ error: "unknown_link" }, 404);
    return c.json({ ok: true });
  });

  app.delete("/links/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || !deps.talkLinks.remove(id)) return c.json({ error: "unknown_link" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

/** 登録済みのサービス (enabled は問わない)。 */
function findService(deps: LineWebhookAdminDeps, name: string): LineWebhookTarget | null {
  return deps.targets().find((target) => target.name === name) ?? null;
}

function describeService(deps: LineWebhookAdminDeps, target: LineWebhookTarget) {
  return {
    name: target.name,
    channel: target.channel,
    enabled: target.enabled,
    keywords: target.keywords,
    relay_token_set: readServiceRelayToken(deps.store, target.name) !== null,
  };
}

/** トーク ID は先頭数文字だけ (全体は LINE のユーザー / グループを特定できるので出さない)。 */
function describeLink(row: LineTalkLinkRow) {
  return {
    id: row.id,
    channel: row.channel,
    talk_kind: talkKind(row.talkId),
    talk_id_prefix: row.talkId.slice(0, TALK_ID_PREFIX_LENGTH),
    service: row.service,
    is_default: row.isDefault,
    linked_at: row.linkedAt,
  };
}

/** LINE の ID は先頭 1 文字で種類が分かる (C: グループ、 R: トークルーム、 U: ユーザー)。 */
function talkKind(talkId: string): "group" | "room" | "user" | "unknown" {
  switch (talkId[0]) {
    case "C": return "group";
    case "R": return "room";
    case "U": return "user";
    default: return "unknown";
  }
}

async function readSecretValue(req: Request): Promise<string | null> {
  const body = await req.json().catch(() => null) as { value?: unknown } | null;
  const value = typeof body?.value === "string" ? body.value.trim() : "";
  return value === "" || value.length > MAX_SECRET_LENGTH ? null : value;
}
