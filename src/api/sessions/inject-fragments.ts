import { parseInjectSource } from "../../shared/inject-source.js";
import { syncHumanInjectFragments } from "../../work/inject-instruction-fragments.js";
import type { SessionsApiDeps } from "./deps.js";
import { log } from "./runtime.js";

/**
 * 人間の inject を Pf フラグメントへ記録する (SPEC-CC-WORKPLACE 受入条件 14)。
 * inject の応答は待たせない。 Pf / Anatomia の停止や結果不明は記録失敗としてログに残すだけで、
 * inject 自体は成功のまま返す。 公開可否の照会 port が未接続なら送らない (受入条件 7 と同じ)。
 */
export function recordHumanInjectFragments(deps: Pick<SessionsApiDeps, "repo" | "syncInstructionFragments" | "isPrivateConsultation">,
  sessionId: string, input: { source: string | null; ts: number; authorLabel: string | null; text: string }): void {
  const sync = deps.syncInstructionFragments;
  const isPrivateConsultation = deps.isPrivateConsultation;
  const source = parseInjectSource(input.source);
  if (!sync || !isPrivateConsultation || !source.platform || !source.userId || !input.authorLabel) return;
  const session = deps.repo.findSession(sessionId);
  if (!session) return;
  void syncHumanInjectFragments({ isPrivateConsultation, sync }, {
    sessionId, repoPath: session.repo_path, repoOrigin: session.repo_origin,
    source: source.raw, ts: input.ts, authorLabel: input.authorLabel, text: input.text,
  }).then((result) => {
    if (result.state === "unavailable") log.warn({ session_id: sessionId }, "[inject-fragments] Pf への記録を確認できませんでした");
  }, (error: unknown) => {
    log.warn({ session_id: sessionId, err: String(error) }, "[inject-fragments] Pf への記録に失敗しました");
  });
}
