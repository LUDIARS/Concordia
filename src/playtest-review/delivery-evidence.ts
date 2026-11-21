import type Database from "better-sqlite3";
import type { PlaytestReviewOutcome } from "./handle-playtest-review.js";

/** Latest observed delivery success and failure, independent of the recent run dedupe cache. */
export class PlaytestDeliveryEvidence {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  record(outcome: PlaytestReviewOutcome): void {
    if (outcome.duplicate || outcome.unconfigured) return;
    const success = outcome.delivered.length > 0 || (outcome.tabula !== null && "url" in outcome.tabula);
    const failures = [
      ...(outcome.failed.length ? ["チャット配送失敗"] : []),
      ...(outcome.video?.failed.length ? ["動画添付失敗"] : []),
      ...(outcome.tabula && "error" in outcome.tabula ? ["Tabula 投稿失敗"] : []),
    ];
    const at = this.now().toISOString();
    this.db.prepare(`UPDATE playtest_delivery_evidence SET
      last_success_at = COALESCE(?, last_success_at),
      last_failure_at = COALESCE(?, last_failure_at),
      last_failure_reason = COALESCE(?, last_failure_reason)
      WHERE id = 1`).run(success ? at : null, failures.length ? at : null, failures.join(" / ") || null);
  }

  read(): { last_success_at: string | null; last_failure_at: string | null; last_failure_reason: string | null } {
    return this.db.prepare("SELECT last_success_at, last_failure_at, last_failure_reason FROM playtest_delivery_evidence WHERE id = 1").get() as ReturnType<PlaytestDeliveryEvidence["read"]>;
  }
}
