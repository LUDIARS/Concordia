import { destinationKey, type Article, type Publication, type PublicationStore, type PublicationTransport } from "./model.js";

export class PublicationError extends Error {
  constructor(readonly code: "no_targets" | "not_found" | "not_failed" | "not_unknown" | "receipt_not_verified" | "state_changed") { super(code); }
}

/** Explicit requests only: no background writer or automatic retry loop. */
export class PublicationService {
  constructor(readonly store: PublicationStore, private readonly transport: PublicationTransport,
    private readonly now: () => number, private readonly newAttemptId: () => string) {}

  list(articleId: string): Publication[] {
    this.store.expireSending(this.now() - 120_000, this.now());
    return this.store.list(articleId);
  }

  async publish(article: Article): Promise<Publication[]> {
    const targets = this.store.targets();
    if (!targets.length) throw new PublicationError("no_targets");
    this.store.enqueue(article, targets, this.now());
    const results = await Promise.allSettled(targets.map(target => this.deliver(article.page_id, destinationKey(target), "pending")));
    if (results.some(result => result.status === "rejected")) throw new Error("publication_storage_unavailable");
    const requested = new Set(targets.map(destinationKey));
    return this.list(article.page_id).filter(row => requested.has(row.target_key));
  }

  async retry(articleId: string, targetKey: string): Promise<Publication> {
    this.list(articleId);
    const row = this.require(articleId, targetKey);
    if (row.status !== "failed") throw new PublicationError("not_failed");
    await this.deliver(articleId, targetKey, "failed");
    return this.require(articleId, targetKey);
  }

  async reconcile(articleId: string, targetKey: string, messageId: string, channelId: string): Promise<Publication> {
    const row = this.requireUnknown(articleId, targetKey);
    const receipt = await this.transport.verify(row, messageId, channelId);
    if (!receipt) throw new PublicationError("receipt_not_verified");
    if (!this.store.reconcile(row, receipt, this.now())) throw new PublicationError("state_changed");
    return this.require(articleId, targetKey);
  }

  confirmAbsent(articleId: string, targetKey: string, reason: string): Publication {
    const row = this.requireUnknown(articleId, targetKey);
    if (!this.store.confirmAbsent(row, reason, this.now())) throw new PublicationError("state_changed");
    return this.require(articleId, targetKey);
  }

  private async deliver(articleId: string, targetKey: string, from: "pending" | "failed"): Promise<void> {
    const attemptId = this.newAttemptId();
    if (!this.store.claim(articleId, targetKey, from, attemptId, this.now())) return;
    const row = this.require(articleId, targetKey);
    // The adapter classifies known rejections. An unexpected exception is never proof of no delivery.
    const result = await this.transport.send(row, () => {
      const current = this.store.find(articleId, targetKey);
      return current?.status === "sending" && current.attempt_id === attemptId;
    }).catch(() => ({ status: "unknown" as const, error_code: "unexpected_delivery_error" }));
    this.store.finish(articleId, targetKey, attemptId, result, this.now());
  }

  private require(articleId: string, targetKey: string): Publication {
    const row = this.store.find(articleId, targetKey);
    if (!row) throw new PublicationError("not_found");
    return row;
  }

  private requireUnknown(articleId: string, targetKey: string): Publication {
    this.list(articleId);
    const row = this.require(articleId, targetKey);
    if (row.status !== "unknown") throw new PublicationError("not_unknown");
    return row;
  }
}
