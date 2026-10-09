import type { FragmentSyncResult } from "./instruction-fragments.js";

/**
 * Discord / Slack から人間がセッションへ送った指示を Pf の仕様フラグメントへ記録する
 * (SPEC-CC-WORKPLACE 受入条件 14、2026-10-09 neco「全部入れる」)。
 * task link 経由の記録 (受入条件 7) とは独立に、指示が届いた時点で記録する。
 */
export interface HumanInject {
  sessionId: string;
  repoPath: string;
  repoOrigin: string | null;
  /** inject の source (`discord:<uid>:...` / `slack:<uid>:...`)。 */
  source: string;
  ts: number;
  authorLabel: string;
  text: string;
}

export interface InjectFragmentPorts {
  isPrivateConsultation(sessionId: string): boolean;
  sync(input: { repo: string; origin: string | null; reference: string; title: string; body: string; privateConsultation?: boolean }): Promise<FragmentSyncResult>;
}

/**
 * 同じ配送を再送しても同じ参照になるようにする。 source にメッセージ ID まで入っている経路
 * (`<platform>:<uid>:<...>:<messageId>`) は source だけで決まり、 ID の無い経路は時刻で区別する。
 */
export function injectReference(input: Pick<HumanInject, "sessionId" | "source" | "ts">): string {
  const carriesMessage = input.source.split(":").length >= 3;
  return carriesMessage ? `inject:${input.sessionId}:${input.source}` : `inject:${input.sessionId}:${input.source}:${input.ts}`;
}

export async function syncHumanInjectFragments(ports: InjectFragmentPorts, input: HumanInject): Promise<FragmentSyncResult> {
  if (!input.repoPath.trim() || !input.text.trim()) return { state: "not_registered" };
  return ports.sync({
    repo: input.repoPath,
    origin: input.repoOrigin,
    reference: injectReference(input),
    title: `「${input.authorLabel}」さんの指示`,
    body: input.text,
    privateConsultation: ports.isPrivateConsultation(input.sessionId),
  });
}
