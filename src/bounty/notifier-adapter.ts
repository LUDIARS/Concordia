/**
 * 報告者・権限者への通知の adapter (spec/feature/bug-bounty.md §5 §7)。
 *
 * - Discord: 受付のチャンネルへ。 本人への mention は構造化フィールド (allowed_mentions.users) だけで許し、
 *   本文の文字列から mention を発火させない。
 * - セッション: 生きていれば inject。
 * - Cocoiru: 通知の形が未確認 (§14) なので届けず、false を返す (呼び出し側が「届かなかった」と記録する)。
 * 届かなくても状態は戻さない (CC-INV-06)。
 *
 * @implements SPEC-BOUNTY-CLOSE
 * @implements SPEC-BOUNTY-TRIAGE
 */

import type { BountyReportRow } from "../db/bounty-reports-repo.js";
import type { BountyReporterRow } from "../db/bounty-reporters-repo.js";
import type { BountyNotifierPort } from "./ports.js";

const SNOWFLAKE = /^\d{5,32}$/u;

export interface BountyNotifierDeps {
  reporters: { find(id: string): BountyReporterRow | null };
  /** Discord のチャンネルへ投稿する。 `mentionUserId` だけを mention として許す。 */
  postDiscord(input: { channelId: string; subsidiaryId: string | null; content: string; mentionUserId: string | null }): Promise<void>;
  /** 生きているセッションへ inject する。 届けたら true。 */
  injectSession(sessionId: string, text: string): boolean;
  /** 権限者へ知らせる本社のチャンネル。 未設定なら null。 */
  authorityChannel(): string | null;
  log?: { warn: (message: string) => void };
}

function replyChannel(report: BountyReportRow): string | null {
  try {
    const ref = JSON.parse(report.intake_ref_json) as { channel_id?: unknown };
    return typeof ref.channel_id === "string" && SNOWFLAKE.test(ref.channel_id) ? ref.channel_id : null;
  } catch {
    return null;
  }
}

export function createBountyNotifier(deps: BountyNotifierDeps): BountyNotifierPort {
  return {
    async replyToReporter(report, message) {
      try {
        if (report.intake_platform === "session") {
          return report.reporter_session_id ? deps.injectSession(report.reporter_session_id, message) : false;
        }
        if (report.intake_platform !== "discord") return false;
        const channelId = replyChannel(report);
        if (!channelId) return false;
        const reporter = report.reporter_id ? deps.reporters.find(report.reporter_id) : null;
        const mentionUserId = reporter && reporter.platform === "discord" && SNOWFLAKE.test(reporter.platform_user_id)
          ? reporter.platform_user_id
          : null;
        const content = mentionUserId ? `<@${mentionUserId}>\n${message}` : message;
        await deps.postDiscord({ channelId, subsidiaryId: report.subsidiary_id, content, mentionUserId });
        return true;
      } catch (error) {
        deps.log?.warn(`bounty reply failed report=${report.id}: ${(error as Error).message}`);
        return false;
      }
    },
    async notifyAuthority(message) {
      const channelId = deps.authorityChannel();
      if (!channelId) return false;
      try {
        await deps.postDiscord({ channelId, subsidiaryId: null, content: message, mentionUserId: null });
        return true;
      } catch (error) {
        deps.log?.warn(`bounty authority notice failed: ${(error as Error).message}`);
        return false;
      }
    },
  };
}
