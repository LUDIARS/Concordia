/**
 * 実装委託の追跡タスクを Memoria へ起票する — 起動時 (1 通注入) の副作用。
 *
 * 段階注入を廃止した (spec/feature/delegation-implementation-inject.md) ため、 起票は
 * 第 2 段階ではなく **prompt を書く直前** に行う。 link をその場でプロンプトへ載せるため。
 *
 * Memoria が落ちていても委託は止めない (fail-soft)。 作れなかった理由は本文へ書き、
 * 追跡タスクの不在を黙って飲み込まない。
 */

import { createChildLogger } from "../shared/logger.js";
import type { MemoriaTaskDraft, MemoriaTaskLink } from "./implementation-inject.js";

const log = createChildLogger("delegation/memoria-task");

/** Memoria への書き込みで使う契約だけ (既存の公式 API — Memoria 側は変更しない)。 */
export interface DelegationMemoriaPort {
  createTask(input: { title: string; details?: string }): Promise<{ id: string | number }>;
  taskApiUrl(id: string | number): string;
}

export interface MemoriaTaskResult {
  link: MemoriaTaskLink | null;
  /** link=null のときの理由 (プロンプトへそのまま載せる)。 */
  error: string | null;
}

export async function createDelegationMemoriaTask(
  port: DelegationMemoriaPort | null | undefined,
  draft: MemoriaTaskDraft,
  runId: string,
): Promise<MemoriaTaskResult> {
  if (!port) return { link: null, error: "memoria port unavailable" };
  try {
    const created = await port.createTask({ title: draft.title, details: draft.details });
    const id = String(created.id);
    return { link: { id, url: port.taskApiUrl(created.id) }, error: null };
  } catch (error) {
    const message = (error as Error).message;
    log.warn({ run_id: runId, error: message }, "memoria task creation failed (delegation continues)");
    return { link: null, error: message };
  }
}
