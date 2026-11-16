/**
 * 委託の状態報告 (POST /runs/:id/status) を記録した後の扱い。
 *
 * - 待ち (kind:"wait") だけが残る partial は run を閉じる (completed) が、作業は終わっていない。
 *   親への通知は partial のまま伝え、完了扱いの後続処理 (分解の注入・taskflow 完了処理) は走らせない。
 * - 記録後の後続処理が失敗しても、報告への応答を 500 にしない。500 を返すと報告側は
 *   「記録されていない」と読んで再送し、二重報告や誤った終端を招く (2026-11-17 run 3c61e7ab:
 *   Actio が引けず分解の確認が投げ、partial 報告が 500 なのに completed で記録された)。
 *
 * @implements spec/feature/delegation.md
 */

export function isWaitOnlyPartial(input: { status: string; remainingCount: number; workRemainingCount: number }): boolean {
  return input.status === "partial" && input.workRemainingCount === 0 && input.remainingCount > 0;
}

/** 親へ伝える報告の種類。 */
export function notifiedStatus(input: {
  partialFailure: boolean; workPartial: boolean; waitOnlyPartial: boolean; persisted: "running" | "completed" | "failed";
}): "running" | "completed" | "failed" | "partial" {
  if (input.partialFailure) return "failed";
  return input.workPartial || input.waitOnlyPartial ? "partial" : input.persisted;
}

/** 記録済みの後で走らせる処理。失敗はログに残して飲み込む。 */
export async function runAfterRecorded(
  runId: string, label: string, task: () => Promise<unknown>,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
  try {
    await task();
  } catch (error) {
    warn(`[delegation] run ${runId}: ${label} skipped after status recorded (${error instanceof Error ? error.message : String(error)})`);
  }
}
