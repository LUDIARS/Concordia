import { z } from "zod";
import { destinationKey } from "./model.js";

export const PageIdSchema = z.string().regex(/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i)
  .transform(value => value.replace(/-/g, "").toLowerCase());
const Snowflake = z.string().regex(/^[1-9]\d{16,19}$/);
const PlainText = z.string().trim().refine(value => !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value), "control characters are not allowed");
export const DestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("discord-channel"), guild_id: Snowflake, channel_id: Snowflake }).strict(),
  z.object({ kind: z.literal("discord-forum"), guild_id: Snowflake, channel_id: Snowflake,
    applied_tags: z.array(Snowflake).max(5).default([]) }).strict(),
  z.object({ kind: z.literal("slack-channel"), team_id: z.string().regex(/^T[A-Z0-9]{8,}$/),
    channel_id: z.string().regex(/^[CG][A-Z0-9]{8,}$/) }).strict(),
]);
export const TargetsSchema = z.object({ targets: z.array(DestinationSchema).max(10).refine(
  targets => new Set(targets.map(destinationKey)).size === targets.length, "duplicate destination",
) }).strict();
export const ArticleSchema = z.object({
  page_id: PageIdSchema,
  title: z.string().trim().min(1).max(200).pipe(PlainText).refine(value => !/[\r\n]/u.test(value), "title must be one line"),
  url: z.string().max(400).url(),
}).strict().refine(article => {
  const url = new URL(article.url);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return false;
  if (!(url.hostname === "app.notion.com" || url.hostname === "notion.so" || url.hostname.endsWith(".notion.so")
    || url.hostname.endsWith(".notion.site"))) return false;
  const last = url.pathname.replace(/\/$/, "").split("/").pop() ?? "";
  const suffix = last.match(/([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i)?.[1];
  return suffix?.replace(/-/g, "").toLowerCase() === article.page_id;
}, "Notion HTTPS URL must identify the same page without query or fragment")
  .transform(article => ({ ...article, url: new URL(article.url).href }));

export const TargetKeySchema = z.object({ target_key: z.string().min(1).max(120) }).strict();
export const ReconcileSchema = TargetKeySchema.extend({
  message_id: z.string().regex(/^(?:[1-9]\d{16,19}|\d{10,}\.\d{6})$/),
  channel_id: z.string().regex(/^(?:[1-9]\d{16,19}|[CG][A-Z0-9]{8,})$/),
}).strict();
export const ConfirmAbsentSchema = TargetKeySchema.extend({
  confirmed_by_human: z.literal(true), reason: z.string().trim().min(10).max(1_000).pipe(PlainText),
}).strict();
