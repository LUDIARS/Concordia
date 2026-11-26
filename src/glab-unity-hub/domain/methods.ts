/**
 * Hub のメソッド名と payload の形 (契約 v1 §2 メソッド / §4)。
 *
 * メソッド名は Unity 側と共有するので変えない。 payload は zod で検査し、
 * 形が違えば `invalid_request` にする。
 *
 * @implements spec/feature/glab-unity-hub.md §3 (GUH-METHODS)
 */

import { z } from "zod";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:a6bffb0d */
import augurContract_43afc42c from './payload-limits.contract.js'; /* augur-inject:contract-predicate:f9689725 */

const id = z.string().trim().min(1).max(128);
const snowflake = z.string().regex(/^\d{5,25}$/);
const projectCode = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);

export const HUB_METHOD_SCHEMAS = {
  "hub.whoami": z.object({}).passthrough(),
  "hub.capabilities": z.object({}).passthrough(),
  "discord.channels.list": z.object({}).passthrough(),
  "discord.messages.list": z.object({
    channelId: snowflake,
    before: snowflake.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }).strict(),
  "discord.messages.post": z.object({
    channelId: snowflake,
    content: z.string().min(1).max(2000),
    replyTo: snowflake.optional(),
  }).strict(),
  "discord.reactions.add": z.object({
    channelId: snowflake,
    messageId: snowflake,
    emoji: z.string().trim().min(1).max(100),
  }).strict(),
  "discord.subscribe": z.object({ channelId: snowflake }).strict(),
  "discord.unsubscribe": z.object({ channelId: snowflake }).strict(),
  "breviarium.snapshot": z.object({ project: projectCode.optional() }).strict(),
  "notion.board.query": z.object({ boardId: id, cursor: z.string().min(1).max(512).optional() }).strict(),
  "notion.board.update": z.object({
    boardId: id,
    pageId: id,
    title: z.string().min(1).max(2000).optional(),
    status: z.string().min(1).max(100).optional(),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/).nullable().optional(),
  }).strict(),
  "notion.board.create": z.object({
    boardId: id,
    title: z.string().min(1).max(2000),
    status: z.string().min(1).max(100).optional(),
  }).strict(),
  "melpomene.report": z.object({
    title: z.string().trim().min(1).max(256),
    body: z.string().max(60_000),
    category: z.string().trim().max(64).optional(),
    priority: z.string().trim().max(32).optional(),
    labels: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
    repo: z.string().trim().min(3).max(140),
  }).strict(),
  "sprint.current": z.object({ project: projectCode }).strict(),
  "sprint.tasks.update": z.object({
    taskId: id,
    status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]),
  }).strict(),
  "calliope.product": z.object({ project: projectCode }).strict(),
  "calliope.refresh": z.object({ project: projectCode }).strict(),
  "spec.list": z.object({ project: projectCode }).strict(),
  "spec.get": z.object({ id }).strict(),
  "spec.review": z.object({
    id,
    decision: z.enum(["accept", "reject"]),
    comment: z.string().max(2000).optional(),
  }).strict(),
} as const;

export type HubMethod = keyof typeof HUB_METHOD_SCHEMAS;
export type HubPayload<M extends HubMethod> = z.infer<(typeof HUB_METHOD_SCHEMAS)[M]>;

export const HUB_METHODS = Object.keys(HUB_METHOD_SCHEMAS) as HubMethod[];

export function isHubMethod(name: string): name is HubMethod {
  return Object.prototype.hasOwnProperty.call(HUB_METHOD_SCHEMAS, name);
}

/** 投稿として数えるメソッド (1 ユーザー毎分 10 件の対象)。 */
export const POSTING_METHODS: ReadonlySet<HubMethod> = new Set<HubMethod>(["discord.messages.post", "melpomene.report"]);

export type PayloadCheck<M extends HubMethod> =
  | { readonly ok: true; readonly payload: HubPayload<M> }
  | { readonly ok: false; readonly message: string };

export function checkPayload<M extends HubMethod>(method: M, payload: unknown): PayloadCheck<M> {
  const parsed = HUB_METHOD_SCHEMAS[method].safeParse(payload);
  if (parsed.success) return { ok: true, payload: parsed.data as HubPayload<M> };
  const first = parsed.error.issues[0];
  const where = first?.path.join(".") || "payload";
  return { ok: false, message: `${where}: ${first?.message ?? "invalid"}` };
}
// @ts-expect-error augur-inject
checkPayload = contract(checkPayload, { ...augurContract_43afc42c, contractId: 'guh-C-5', mode: 'observe', sample: 1, where: 'src/glab-unity-hub/domain/methods.ts:93', rule: 'contract-wrap', id: '43afc42c' }); /* augur-inject:contract-wrap:43afc42c */
