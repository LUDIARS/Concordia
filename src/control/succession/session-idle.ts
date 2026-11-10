/**
 * セッションが「待機中」か (自動依頼を割り込ませてよいか) の判定 (純関数)。
 *
 * 作業中の turn に依頼を割り込ませると、 依頼への応答ではなく作業中の出力を捕捉してしまう。
 * 最後の transcript frame が完了境界で、 そこから quiet 秒が経っているときだけ待機中とみなす。
 *
 * @implements spec/feature/session-auto-succession.md INV-3
 */

import { isTranscriptCompletion } from "../../platform/transcript-completion.js";

export interface LastTranscriptFrame {
  /** epoch 秒。 */
  ts: number;
  kind: string;
  payload: unknown;
}

export function isSessionIdle(last: LastTranscriptFrame | null, nowSec: number, quietSec: number): boolean {
  if (!last) return false;
  if (!isTranscriptCompletion(last.kind, last.payload)) return false;
  return nowSec - last.ts >= quietSec;
}
