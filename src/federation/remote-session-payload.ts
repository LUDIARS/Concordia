/**
 * 本社 → 拠点の event payload (連合 Phase 4: 本社からの spawn 指示)。
 *
 * wire protocol の `event.payload` は不透明 JSON なので、ここで型と検証を持つ。
 * - `spawn`   : 本社 Session forum の拠点タグ付き投稿 → 拠点でセッションを起動する。
 * - `ingress` : 起動済みスレッドへの人の発言 → 拠点のセッションへ届ける。
 *
 * event は at-least-once で届く (再接続直後の再送) ので、受け手は `channel_id` /
 * `message_id` で冪等化する (remote-session-site.ts)。
 *
 * @implements spec/feature/federation-link.md §本社からのセッション起動
 */
import { z } from "zod";

/** 本文は Discord の投稿上限 (4000) に余白を持たせて切る。 */
export const REMOTE_SPAWN_MAX_BODY = 6000;
export const REMOTE_SPAWN_MAX_TITLE = 200;

const snowflake = z.string().regex(/^\d{5,32}$/);

const spawnSchema = z.object({
  type: z.literal("spawn"),
  guild_id: snowflake,
  channel_id: snowflake,
  author_id: snowflake.nullable(),
  title: z.string().max(REMOTE_SPAWN_MAX_TITLE),
  body: z.string().max(REMOTE_SPAWN_MAX_BODY),
  runtime_rules: z.array(z.string().max(100)).max(20).default([]),
  ts: z.number().int(),
});

const ingressSchema = z.object({
  type: z.literal("ingress"),
  guild_id: snowflake,
  channel_id: snowflake,
  message_id: snowflake,
  author_id: snowflake,
  author_label: z.string(),
  text: z.string(),
  ts: z.number().int(),
}).passthrough();

export type RemoteSpawnPayload = z.infer<typeof spawnSchema>;
export type RemoteIngressPayload = z.infer<typeof ingressSchema>;
export type SiteEventPayload = RemoteSpawnPayload | RemoteIngressPayload;

/** 本社が組み立てる spawn payload。 長すぎる題名・本文はここで切る。 */
export function buildRemoteSpawnPayload(input: {
  guildId: string;
  channelId: string;
  authorId: string | null;
  title: string;
  body: string;
  runtimeRules: readonly string[];
  ts: number;
}): RemoteSpawnPayload {
  return {
    type: "spawn",
    guild_id: input.guildId,
    channel_id: input.channelId,
    author_id: input.authorId,
    title: Array.from(input.title).slice(0, REMOTE_SPAWN_MAX_TITLE).join(""),
    body: Array.from(input.body).slice(0, REMOTE_SPAWN_MAX_BODY).join(""),
    runtime_rules: [...input.runtimeRules].slice(0, 20),
    ts: input.ts,
  };
}

/** 拠点が受け取った payload を解釈する。 知らない形・壊れた形は null (読み捨て)。 */
export function parseSiteEventPayload(payload: unknown): SiteEventPayload | null {
  const type = payload && typeof payload === "object" ? (payload as { type?: unknown }).type : undefined;
  const parsed = type === "spawn" ? spawnSchema.safeParse(payload)
    : type === "ingress" ? ingressSchema.safeParse(payload)
      : null;
  return parsed?.success ? parsed.data : null;
}
