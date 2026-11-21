/**
 * Opus 振替の判定に使う agy Claude 枠の取得 (I/O)。 判定は opus-agy-route.ts が持つ。
 * 取得は cost と同じ fetchAgyUsage (4 分キャッシュ・single-flight) を使い、 失敗は null (= 従来の Opus)。
 *
 * @implements spec/feature/delegation-model-tiers.md DMT-08
 */
import { fetchAgyUsage } from "../cost/agy-usage-fetch.js";
import { createChildLogger } from "../shared/logger.js";
import { agyClaudeRemainingPct } from "./opus-agy-route.js";

const log = createChildLogger("delegation-opus-agy-usage");

export async function collectAgyClaudeRemainingPct(
  fetch: typeof fetchAgyUsage = fetchAgyUsage,
  now: () => number = Date.now,
): Promise<number | null> {
  try {
    return agyClaudeRemainingPct(await fetch({ log }), Math.floor(now() / 1000));
  } catch (error) {
    log.warn({ err: (error as Error).message }, "agy Claude quota fetch failed; keeping Opus");
    return null;
  }
}
