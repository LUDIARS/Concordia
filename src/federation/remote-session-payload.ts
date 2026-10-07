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

/**
 * `/spawn site:` が拠点へ渡す起動条件 (任意)。 forum 起動は持たない。
 * 古い拠点は知らないキーを読み捨てるので、 無指定の forum 起動と同じ動きになる。
 */
const spawnOptionsSchema = z.object({
  provider: z.enum(["claude", "codex", "gemini"]).optional(),
  template: z.string().max(100).optional(),
  inject_prompt: z.boolean().optional(),
  model: z.string().max(100).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  project: z.string().max(200).optional(),
  branch: z.string().max(200).optional(),
  cwd: z.string().max(500).optional(),
});
export type RemoteSpawnOptions = z.infer<typeof spawnOptionsSchema>;

const spawnSchema = z.object({
  type: z.literal("spawn"),
  guild_id: snowflake,
  channel_id: snowflake,
  author_id: snowflake.nullable(),
  title: z.string().max(REMOTE_SPAWN_MAX_TITLE),
  body: z.string().max(REMOTE_SPAWN_MAX_BODY),
  runtime_rules: z.array(z.string().max(100)).max(20).default([]),
  options: spawnOptionsSchema.optional(),
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
  options?: RemoteSpawnOptions;
  ts: number;
}): RemoteSpawnPayload {
  const options = input.options ? spawnOptionsSchema.parse(input.options) : undefined;
  return {
    type: "spawn",
    guild_id: input.guildId,
    channel_id: input.channelId,
    author_id: input.authorId,
    title: Array.from(input.title).slice(0, REMOTE_SPAWN_MAX_TITLE).join(""),
    body: Array.from(input.body).slice(0, REMOTE_SPAWN_MAX_BODY).join(""),
    runtime_rules: [...input.runtimeRules].slice(0, 20),
    ...(options && Object.keys(options).length > 0 ? { options } : {}),
    ts: input.ts,
  };
}

/** 拠点の /v1/admin/spawn-session に渡す起動条件。 effort は provider ごとのキーへ寄せる。 */
export function remoteSpawnRequestFields(options: RemoteSpawnOptions | undefined): Record<string, unknown> {
  if (!options) return {};
  const { effort, inject_prompt, ...rest } = options;
  return {
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    ...(inject_prompt !== undefined ? { inject_prompt } : {}),
    ...(effort ? { options: options.provider === "claude" ? { effort } : { model_reasoning_effort: effort } } : {}),
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
