/**
 * vibes モード契約の人間 [OK] (vibes.ok) を終了連鎖へ接続する。
 *
 * 連鎖: vibes-human-ok event → local PR 提出 → (受理時のみ) testing claim release
 * → vibes-completed event → セッション終了。 提出が受理されなければ vibes-pr-failed を
 * 記録して連鎖を打ち切る (セッションは生かしたまま人間の介入を待つ)。
 *
 * bootstrap/core.ts のインライン実装から抽出 (挙動は同一、 依存注入のみ追加)。
 * @implements spec/tasks/2026-08-13-vibes-mode.md
 */

import { parseContractMetadata } from "../contract/schema.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import type { SessionRow } from "../shared/types.js";
import { releaseTestingClaims } from "../testing/claim-lifecycle.js";

const defaultLog = createChildLogger("vibes-completion");

/** 提出結果 (SessionLocalPrSubmission 互換)。 submitted / resubmitted どちらかが true なら受理。 */
export interface VibesCompletionSubmission {
  submitted: boolean;
  resubmitted?: boolean;
  [key: string]: unknown;
}

export interface VibesCompletionDeps {
  sessions: SessionsRepo;
  claims: TestingClaimsRepo;
  /** local PR 提出 (core は fastLane: false で束ねた closure を渡す)。 */
  submitLocalPr: (sessionId: string) => Promise<VibesCompletionSubmission>;
  endSession: (session: SessionRow, reason: string) => Promise<unknown>;
  nowSec?: () => number;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

export function startVibesCompletion(deps: VibesCompletionDeps): { stop(): void } {
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? defaultLog;
  const unsubscribe = eventBus.subscribe((event) => {
    if (event.type !== "vibes.ok") return;
    const session = deps.sessions.findSession(event.session_id);
    const contract = session ? parseContractMetadata(session.metadata) : null;
    if (!session || session.status !== "active" || contract?.mode?.value !== "vibes") return;
    void (async () => {
      deps.sessions.appendEvent({ session_id: session.id, ts: event.ts, kind: "vibes-human-ok", payload: { source: event.source } });
      const submitted = await deps.submitLocalPr(session.id);
      const accepted = submitted.submitted === true || submitted.resubmitted === true;
      if (!accepted) {
        deps.sessions.appendEvent({ session_id: session.id, ts: nowSec(), kind: "vibes-pr-failed", payload: submitted });
        return;
      }
      releaseTestingClaims(deps.claims, { sessionId: session.id, now: nowSec() });
      deps.sessions.appendEvent({ session_id: session.id, ts: nowSec(), kind: "vibes-completed", payload: { source: event.source } });
      await deps.endSession(session, "vibes-human-ok");
    })().catch((error) => log.warn({ error, session_id: event.session_id }, "vibes completion failed"));
  });
  return { stop: unsubscribe };
}
