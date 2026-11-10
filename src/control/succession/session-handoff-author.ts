/**
 * 次セッションへ渡す handoff を、 旧セッション自身に書かせる。
 *
 * 実作業を行った当人がフルコンテキストで書くため、 計画と実状の乖離が起きにくい。
 * 捕捉に失敗したら切り離し生成へフォールバックし、 handoff を空にしない。
 * (ここで言うフォールバックは「セッションが応答しなかった」capability 劣化で、 設定不備の隠蔽ではない。
 * 劣化したことは warn ログで観測できる。)
 *
 * @implements spec/feature/session-auto-succession.md §1.2
 */

import type { SessionRow } from "../../shared/types.js";
import { buildSessionHandoverPrompt } from "../compaction.js";
import { ENTER_KEY_TEXT } from "../enter-key.js";

export const HANDOVER_REQUEST_SOURCE = "handover-handoff-request";
export const HANDOVER_REQUEST_ENTER_SOURCE = "handover-handoff-request-enter";

export interface SessionHandoffAuthorPorts {
  /** inject 前の transcript 最大 id (watermark)。 */
  transcriptMaxId(sessionId: string): number;
  inject(sessionId: string, text: string, source: string): Promise<boolean>;
  /** watermark 以降の assistant 地の文を捕捉する。 得られなければ null。 */
  elicit(sessionId: string, watermark: number): Promise<string | null>;
  /** 切り離し生成 (フォールバック)。 */
  generateDetached(session: SessionRow): Promise<string>;
  log: { warn(message: string): void };
}

export async function authorHandoffBySession(ports: SessionHandoffAuthorPorts, session: SessionRow): Promise<string> {
  let watermark = 0;
  try {
    watermark = ports.transcriptMaxId(session.id);
  } catch (error) {
    // watermark 0 は「全 frame を対象に捕捉」になるだけで、 誤った handoff にはならない。
    ports.log.warn(`handover: watermark 取得失敗 session=${session.id}: ${(error as Error).message}`);
  }
  const asked = await ports.inject(session.id, buildSessionHandoverPrompt(session.current_task ?? ""), HANDOVER_REQUEST_SOURCE);
  await ports.inject(session.id, ENTER_KEY_TEXT, HANDOVER_REQUEST_ENTER_SOURCE);
  const captured = asked ? await ports.elicit(session.id, watermark) : null;
  if (captured) return captured;
  ports.log.warn(`handover: セッション自筆 handoff の捕捉失敗 → 切り離し生成にフォールバック session=${session.id}`);
  return ports.generateDetached(session);
}
