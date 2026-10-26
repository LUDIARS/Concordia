/**
 * AI プレイテストの run 動画を感想と同じ投稿に添付する transport。
 *
 * - Discord: 「AI プレイテスト通知チャンネル」へ Cc Bot で、 投稿文と動画を 1 メッセージ (multipart) で出す。
 * - Slack: incoming webhook はファイルを運べないため、 Slack Bot (設定の Bot トークン) で
 *   「AI プレイテスト通知 Slack チャンネル」へ動画を上げ、 投稿文をその最初のコメントにする
 *   (files.getUploadURLExternal → upload → files.completeUploadExternal)。
 * 宛先と秘密は Cc の設定だけが持つ (CC-PLAYTEST-INV-01)。 token は配送時にだけ読み、 エラーに出さない。
 *
 * @implements spec/feature/playtest-review-notify.md — 動画
 */

import { DISCORD_ATTACH_MAX_BYTES } from "../discord/attachment-files.js";
import { sanitizeSlackMentions } from "../deploy/service-deployed-runtime.js";

/** 受け付ける動画の上限 (Discord Bot の添付と同じ)。 */
export const PLAYTEST_VIDEO_MAX_BYTES = DISCORD_ATTACH_MAX_BYTES;

export interface PlaytestReviewVideo {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface PlaytestVideoDelivery {
  /** 投稿文と動画を Discord の通知チャンネルへ 1 メッセージで出す。 */
  discord(content: string, video: PlaytestReviewVideo): Promise<void>;
  /** Slack で動画を投稿できる設定 (Bot トークンと通知チャンネル) があるか。 */
  slackReady(): boolean;
  /** 動画を Slack の通知チャンネルへ上げ、 投稿文を最初のコメントにする。 */
  slack(content: string, video: PlaytestReviewVideo): Promise<void>;
}

const SLACK_API = "https://slack.com/api";

async function slackCall(fetchImpl: typeof fetch, token: string, method: string, body: URLSearchParams | string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": typeof body === "string" ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded" },
    body,
  });
  const answer = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || answer.ok !== true) throw new Error(`slack ${method} failed (${typeof answer.error === "string" ? answer.error : response.status})`);
  return answer;
}

export function createPlaytestVideoDelivery(input: {
  fetchImpl?: typeof fetch;
  /** 通知チャンネルと Cc Bot のトークン。 未設定なら理由つきで throw する。 */
  discord: () => { channelId: string; token: string };
  /** Slack Bot のトークンと通知チャンネル。 どちらか欠ければ null。 */
  slack: () => { channelId: string; token: string } | null;
}): PlaytestVideoDelivery {
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async discord(content, video) {
      const { channelId, token } = input.discord();
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ content, allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: video.name }] }));
      form.append("files[0]", new Blob([video.bytes], { type: "video/mp4" }), video.name);
      const response = await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${token}` },
        body: form,
      });
      if (!response.ok) throw new Error(`playtest Discord channel rejected the video (${response.status})`);
    },
    slackReady: () => input.slack() !== null,
    async slack(content, video) {
      const target = input.slack();
      if (!target) throw new Error("playtest Slack video channel is not configured");
      const ticket = await slackCall(fetchImpl, target.token, "files.getUploadURLExternal", new URLSearchParams({ filename: video.name, length: String(video.bytes.length) }));
      if (typeof ticket.upload_url !== "string" || typeof ticket.file_id !== "string") throw new Error("slack files.getUploadURLExternal answered without an upload URL");
      const upload = await fetchImpl(ticket.upload_url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Blob([video.bytes]) });
      if (!upload.ok) throw new Error(`slack upload failed (${upload.status})`);
      await slackCall(fetchImpl, target.token, "files.completeUploadExternal", JSON.stringify({
        files: [{ id: ticket.file_id, title: video.name }],
        channel_id: target.channelId,
        initial_comment: sanitizeSlackMentions(content),
      }));
    },
  };
}
