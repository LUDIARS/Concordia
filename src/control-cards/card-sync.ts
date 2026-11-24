/**
 * 巡回 (1 分) から呼ぶカード同期の use case。出所を読み、無ければ作り、解決したら閉じる。
 * 判定は card-sync-policy.ts。カードの開閉は受け手 (依頼窓口のスレッド) へ知らせる。
 *
 * @implements spec/feature/control-cards.md — 同期 (CC-V5-INV-03)
 */
import type { ControlCard } from "./card-domain.js";
import { planCardSync, type CardSyncPlan } from "./card-sync-policy.js";
import type { ControlCardsRepository } from "./repository.js";
import type { CardSources } from "./sources.js";

export type CardChange = { kind: "opened" | "closed"; card: ControlCard };

export interface CardSyncPorts {
  repo: ControlCardsRepository;
  sources: Pick<CardSources, "read">;
  sessionEnded: (sessionId: string) => boolean | null;
  now: () => number;
  id: () => string;
  onChange?: (change: CardChange) => void;
  log: { warn(message: string): void };
}

export function syncControlCards(ports: CardSyncPorts): CardSyncPlan {
  const readings = ports.sources.read();
  const plan = planCardSync({ readings, openCards: ports.repo.listOpen(), sessionEnded: ports.sessionEnded });
  for (const kind of plan.unreadable) ports.log.warn(`control card source unreadable: ${kind}; its cards stay open`);
  const now = ports.now();
  const changes: CardChange[] = [];
  ports.repo.transaction(() => {
    for (const item of plan.create) changes.push({ kind: "opened", card: ports.repo.open(ports.id(), item, now) });
    for (const row of plan.refresh) ports.repo.refresh(row.id, row.summary, row.link, now);
    for (const row of plan.close) {
      if (ports.repo.close(row.id, row.reason, now)) changes.push({ kind: "closed", card: ports.repo.find(row.id)! });
    }
  });
  for (const change of changes) notify(ports, change);
  return plan;
}

export function notify(ports: Pick<CardSyncPorts, "onChange" | "log">, change: CardChange): void {
  try { ports.onChange?.(change); } catch (error) { ports.log.warn(`control card notice failed: ${String(error)}`); }
}
