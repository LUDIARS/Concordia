/**
 * 実行中セッションの effort を途中で変える (application use case)。
 *
 * - 人間 (Discord の /co-effort 等) とセッション自身 (movable テンプレートで起動した Opus / Fable が
 *   作業の難しさに合わせて変える) の両方から呼ばれる。 契約には人間なら human、セッションなら
 *   llm の決定として残し、既存の runtime 反映 (Lictor /v1/runtime/model-effort) で適用する。
 * - 適用に成功した時だけ、セッションの Discord スレッドへ変更を通知する。 失敗は呼び出し元へ返し、
 *   契約は書き換えない (契約と runtime を食い違わせない)。
 * - 同じ値への変更は何もしない (通知もしない)。
 *
 * Claude API では会話途中の effort 変更が履歴キャッシュを作り直す場合がある。 実際の挙動は
 * runtime (Claude Code / Codex) 次第なので、通知ではその可能性だけを伝える。
 *
 * @implements spec/feature/effort-movable.md
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import { normalizeProviderEffort } from "../control/provider-preset.js";
import type { ApplyModelEffortFn } from "./runtime-apply.js";
import { parseContractMetadata } from "./schema.js";
import { readRuntimeEffort, readRuntimeModel } from "./seed-rules.js";
import { saveContract } from "./store.js";

export type EffortChangeActor = "human" | "session";

export interface EffortChangeInput {
  sessionId: string;
  effort: string;
  actor: EffortChangeActor;
  reason: string;
  /** 人間が変えた場合の platform 上の利用者 (通知の表示用)。 */
  requestedBy?: string | null;
}

export type EffortChangeResult =
  | { ok: true; changed: boolean; effort: string; previous: string | null; model: string }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string; message?: string };

export interface EffortChangeDeps {
  sessions: Pick<SessionsRepo, "findSession" | "mergeMetadata" | "appendEvent">;
  apply: ApplyModelEffortFn;
  notify: (input: { sessionId: string; text: string }) => void;
  now?: () => number;
}

/** session.provider (claude-code / codex-cli 等) を effort 語彙の provider に写す。 */
export function effortProviderOf(sessionProvider: string): "claude" | "codex" | null {
  const value = sessionProvider.trim().toLowerCase();
  if (value.startsWith("claude")) return "claude";
  if (value.startsWith("codex")) return "codex";
  return null;
}

export function buildEffortChangeNotice(input: {
  previous: string | null;
  effort: string;
  actor: EffortChangeActor;
  reason: string;
  requestedBy?: string | null;
}): string {
  const who = input.actor === "human"
    ? `人間${input.requestedBy ? ` (${input.requestedBy})` : ""}`
    : "セッション自身";
  return [
    `🎚️ effort を ${input.previous ?? "(不明)"} → ${input.effort} に変更しました (変更者: ${who})`,
    `理由: ${input.reason}`,
    "※ runtime によっては会話キャッシュが作り直され、直後の応答で入力費用が増える場合があります。",
  ].join("\n");
}

export async function changeSessionEffort(deps: EffortChangeDeps, input: EffortChangeInput): Promise<EffortChangeResult> {
  const row = deps.sessions.findSession(input.sessionId);
  if (!row) return { ok: false, status: 404, error: "session_not_found" };
  if (row.status !== "active") return { ok: false, status: 409, error: "session_not_active" };
  const reason = input.reason.trim();
  if (!reason) return { ok: false, status: 400, error: "reason_required" };
  const provider = effortProviderOf(row.provider);
  if (!provider) return { ok: false, status: 400, error: "effort_not_supported_for_provider" };
  const effort = normalizeProviderEffort(provider, input.effort);
  if (!effort) return { ok: false, status: 400, error: "invalid_effort", message: `${provider} では使えない effort です: ${input.effort}` };

  const contract = parseContractMetadata(row.metadata);
  const model = contract?.model?.value ?? readRuntimeModel(row.metadata);
  if (!model) return { ok: false, status: 409, error: "model_unknown", message: "現在のモデルが分からないため effort だけを切り替えられません" };
  const previous = readRuntimeEffort(row.metadata) ?? contract?.effort?.value ?? null;
  if (previous === effort) return { ok: true, changed: false, effort, previous, model };

  const applied = await applyEffort(deps, input.sessionId, model, effort);
  if (!applied.ok) return { ok: false, status: 502, error: "runtime_apply_failed", message: applied.message };

  // 適用できた後で契約を更新する (runtime と契約を食い違わせない)。
  if (contract) {
    saveContract(deps.sessions as SessionsRepo, input.sessionId, {
      ...contract,
      effort: {
        value: effort,
        decided_by: input.actor === "human" ? "human" : "llm",
        rationale: reason.slice(0, 500),
        genius_card_ids: [],
      },
    }, input.actor === "human" ? "effort-change-human" : "effort-change-session", Math.floor((deps.now?.() ?? Date.now()) / 1000));
  }
  deps.sessions.mergeMetadata(input.sessionId, { effort });
  deps.notify({
    sessionId: input.sessionId,
    text: buildEffortChangeNotice({ previous, effort, actor: input.actor, reason, requestedBy: input.requestedBy ?? null }),
  });
  return { ok: true, changed: true, effort, previous, model };
}

async function applyEffort(deps: EffortChangeDeps, sessionId: string, model: string, effort: string): Promise<{ ok: boolean; message: string }> {
  try {
    return await deps.apply({ sessionId, model, effort });
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
