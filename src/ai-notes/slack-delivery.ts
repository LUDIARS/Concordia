import { z } from "zod";
import { composeNotice, type Destination, type Publication, type Receipt, type SendResult } from "./model.js";
import { deliveryJson, DeliveryFault, failedDelivery } from "./http-delivery.js";

type SlackDestination = Extract<Destination, { kind: "slack-channel" }>;
export interface SlackPublicationDeps { config: () => { enabled: boolean; botToken: string | null }; fetcher: typeof fetch; }
const AuthSchema = z.object({ team_id: z.string(), user_id: z.string() });
const EnvelopeSchema = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough();

/** Plain Slack text: escape special sequences before disabling mrkdwn/link_names. */
export function slackNotice(row: Publication): string {
  return composeNotice(row.article).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function request(deps: SlackPublicationDeps) {
  const config = deps.config();
  if (!config.enabled || !config.botToken) throw new DeliveryFault("slack_not_configured");
  return async (method: string, query?: Record<string, string>, body?: unknown): Promise<unknown> => {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const raw = await deliveryJson({ url: url.toString(), authorization: `Bearer ${config.botToken}`, body, fetcher: deps.fetcher });
    const result = EnvelopeSchema.parse(raw);
    if (!result.ok) {
      const known = new Set(["channel_not_found", "not_in_channel", "is_archived", "missing_scope", "invalid_auth", "account_inactive",
        "token_revoked", "no_permission", "restricted_action", "msg_too_long", "ratelimited"]);
      const code = result.error && known.has(result.error) ? `slack_${result.error}` : "slack_request_failed";
      throw new DeliveryFault(code, body !== undefined && !known.has(result.error ?? ""));
    }
    return raw;
  };
}

function receipt(target: SlackDestination, messageId: string): Receipt {
  return { message_id: messageId, channel_id: target.channel_id,
    message_url: `https://app.slack.com/client/${target.team_id}/${target.channel_id}?message_ts=${messageId}` };
}

export async function sendSlackPublication(deps: SlackPublicationDeps, row: Publication & { target: SlackDestination }, ownsAttempt: () => boolean): Promise<SendResult> {
  let writing = false;
  try {
    const get = request(deps);
    const auth = AuthSchema.parse(await get("auth.test"));
    if (auth.team_id !== row.target.team_id) throw new DeliveryFault("slack_workspace_mismatch");
    const { channel } = z.object({ channel: z.object({ id: z.string(), is_archived: z.boolean(), is_member: z.boolean(),
      is_im: z.boolean().optional(), is_mpim: z.boolean().optional() }) }).parse(await get("conversations.info", { channel: row.target.channel_id }));
    if (channel.id !== row.target.channel_id || channel.is_im || channel.is_mpim) throw new DeliveryFault("slack_channel_required");
    if (!channel.is_member || channel.is_archived) throw new DeliveryFault("slack_channel_unavailable");
    if (!ownsAttempt()) throw new DeliveryFault("delivery_claim_lost");
    writing = true;
    const result = z.object({ channel: z.string(), ts: z.string().regex(/^\d{10,}\.\d{6}$/) }).parse(await get("chat.postMessage", undefined, {
      channel: row.target.channel_id, text: slackNotice(row), mrkdwn: false, parse: "none", link_names: false,
      unfurl_links: false, unfurl_media: false,
      blocks: [
        { type: "section", text: { type: "plain_text", text: ["AIノートを公開しました", row.article.title, row.article.summary].filter(Boolean).join("\n\n") } },
        { type: "section", text: { type: "mrkdwn", text: `<${new URL(row.article.url).href}|記事を読む>` } },
      ],
    }));
    if (result.channel !== row.target.channel_id) throw new DeliveryFault("slack_receipt_mismatch", true);
    return { status: "sent", receipt: receipt(row.target, result.ts) };
  } catch (error) { return failedDelivery(error, writing); }
}

export async function verifySlackPublication(deps: SlackPublicationDeps, row: Publication & { target: SlackDestination }, messageId: string, channelId: string): Promise<Receipt | null> {
  if (channelId !== row.target.channel_id || !/^\d{10,}\.\d{6}$/.test(messageId)) return null;
  try {
    const get = request(deps);
    const auth = AuthSchema.parse(await get("auth.test"));
    if (auth.team_id !== row.target.team_id) return null;
    const result = z.object({ messages: z.array(z.object({ ts: z.string(), user: z.string().optional(), text: z.string() })) })
      .parse(await get("conversations.history", { channel: channelId, latest: messageId, inclusive: "true", limit: "1" }));
    const message = result.messages.find(item => item.ts === messageId);
    if (message?.user !== auth.user_id || message.text !== slackNotice(row)) return null;
    return receipt(row.target, messageId);
  } catch { return null; }
}
