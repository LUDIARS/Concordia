/** @implements spec/feature/ai-note-publication.md — 状態と境界 */
export interface Article { page_id: string; title: string; summary: string; url: string; }
export type Destination =
  | { kind: "discord-channel"; guild_id: string; channel_id: string }
  | { kind: "discord-forum"; guild_id: string; channel_id: string; applied_tags: string[] }
  | { kind: "slack-channel"; team_id: string; channel_id: string };
export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "unknown";
export interface Receipt { message_id: string; channel_id: string; message_url: string; }
export interface Publication {
  article_id: string;
  target_key: string;
  article: Article;
  target: Destination;
  status: DeliveryStatus;
  attempt_id: string | null;
  receipt: Receipt | null;
  error_code: string | null;
  resolution: string | null;
  updated_at: number;
}
export type SendResult = { status: "sent"; receipt: Receipt }
  | { status: "failed" | "unknown"; error_code: string };

export function destinationKey(target: Destination): string {
  return target.kind === "slack-channel"
    ? `slack:${target.team_id}:${target.channel_id}`
    : `discord:${target.guild_id}:${target.channel_id}`;
}

export function composeNotice(article: Article): string {
  return ["AIノートを公開しました", article.title, article.summary, article.url].filter(Boolean).join("\n\n");
}

export interface PublicationStore {
  targets(): Destination[];
  replaceTargets(targets: Destination[]): void;
  enqueue(article: Article, targets: Destination[], now: number): void;
  list(articleId: string): Publication[];
  find(articleId: string, targetKey: string): Publication | null;
  expireSending(before: number, now: number): void;
  claim(articleId: string, targetKey: string, from: "pending" | "failed", attemptId: string, now: number): boolean;
  finish(articleId: string, targetKey: string, attemptId: string, result: SendResult, now: number): void;
  reconcile(publication: Publication, receipt: Receipt, now: number): boolean;
  confirmAbsent(publication: Publication, reason: string, now: number): boolean;
}

export interface PublicationTransport {
  send(publication: Publication, ownsAttempt: () => boolean): Promise<SendResult>;
  verify(publication: Publication, messageId: string, channelId: string): Promise<Receipt | null>;
}
