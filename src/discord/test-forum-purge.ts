/**
 * Test フォーラムの閉じたスレッドを一括で削除する (2026-10-06 neco 指示)。
 *
 * 子会社の関連プロジェクトに Concordia を足した直後の同期で、過去の PR のスレッドが 167 件作られて
 * その場で閉じられた。閉じたスレッドは案内として役に立たないので、運用者の依頼で消せるようにする。
 *
 * 記録 (discord_test_surfaces) は書き換えない。既に無いスレッドは「削除済み」として数えるので、
 * 何度実行しても同じ結果になる。開いているスレッドには触らない。
 *
 * @implements spec/feature/revisor-test-forum-sync.md §閉じたスレッドの一括削除
 */
import { DiscordAPIError, type Guild } from "discord.js";
import type { DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";

/** Discord の Unknown Channel。 */
const UNKNOWN_CHANNEL = 10003;

export interface TestForumPurgeResult {
  deleted: number;
  missing: number;
  failed: number;
}

export async function purgeClosedTestThreads(deps: {
  guild: Guild;
  surfaces: Pick<DiscordTestSurfacesRepo, "listClosed">;
  log: { info(message: string): void; warn(message: string): void };
}): Promise<TestForumPurgeResult> {
  const result: TestForumPurgeResult = { deleted: 0, missing: 0, failed: 0 };
  for (const surface of deps.surfaces.listClosed()) {
    try {
      const thread = await deps.guild.channels.fetch(surface.thread_id).catch((error: unknown) => {
        if (error instanceof DiscordAPIError && error.code === UNKNOWN_CHANNEL) return null;
        throw error;
      });
      if (!thread) {
        result.missing += 1;
        continue;
      }
      await thread.delete("closed test forum thread purged");
      result.deleted += 1;
    } catch (error) {
      result.failed += 1;
      deps.log.warn(`test forum purge failed surface=${surface.id}: ${(error as Error).message}`);
    }
  }
  deps.log.info(`test forum closed threads purged deleted=${result.deleted} missing=${result.missing} failed=${result.failed}`);
  return result;
}
