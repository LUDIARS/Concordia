import webpush from "web-push";
import { eventBus, type ConcordiaEvent } from "../events.js";
import type { WebPushRepo } from "../db/web-push-repo.js";

const VAPID_SUBJECT = "mailto:concordia@localhost";

/** @implements spec/feature/session-message-webui-chat.md §1.4 */
export class WebPushService {
  private readonly publicKey: string;

  constructor(private readonly repo: WebPushRepo) {
    const storedPublic = repo.getConfig("vapid_public_key");
    const storedPrivate = repo.getConfig("vapid_private_key");
    const keys = storedPublic && storedPrivate ? { publicKey: storedPublic, privateKey: storedPrivate } : webpush.generateVAPIDKeys();
    if (!storedPublic || !storedPrivate) {
      repo.setConfig("vapid_public_key", keys.publicKey);
      repo.setConfig("vapid_private_key", keys.privateKey);
    }
    this.publicKey = keys.publicKey;
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
  }

  getPublicKey(): string { return this.publicKey; }

  start(): () => void {
    return eventBus.subscribe((event) => {
      void this.notifyFor(event).catch(() => {
        // Subscription credentials are intentionally omitted from this event.
        eventBus.emit({
          type: "error.reported",
          source: "web-push",
          message: "web push delivery loop failed",
          ts: Math.floor(Date.now() / 1000),
        });
      });
    });
  }

  private async notifyFor(event: ConcordiaEvent): Promise<void> {
    const notification = notificationFor(event);
    if (!notification) return;
    await Promise.all(this.repo.listActive().map(async (subscription) => {
      try {
        await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(notification));
        this.repo.recordSuccess(subscription.endpoint);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) this.repo.delete(subscription.endpoint);
        else this.repo.recordFailure(subscription.endpoint, Math.floor(Date.now() / 1000));
      }
    }));
  }
}

/** @implements spec/feature/session-message-webui-chat.md §1.4 notification selection */
function notificationFor(event: ConcordiaEvent): { title: string; body: string; sessionId: string; tag: string } | null {
  if (event.type === "session.message") {
    if (!["assistant", "question", "permission"].includes(event.message.author_type)) return null;
    return { title: event.message.author_label, body: event.message.content.slice(0, 180), sessionId: event.target_session_id, tag: `session:${event.target_session_id}` };
  }
  if (event.type === "session.ended") return { title: "セッション終了", body: event.session_id, sessionId: event.session_id, tag: `session:${event.session_id}` };
  if (event.type === "session.lost") return { title: "セッション異常終了", body: event.session_id, sessionId: event.session_id, tag: `session:${event.session_id}` };
  return null;
}
