/**
 * 巡回 (1 分) から呼ぶカード同期の use case。出所を読み、無ければ作り、解決したら閉じる。
 * 持ち主のセッションが active でない判断カードは破棄する (実装メモ 14)。
 * 判定は card-sync-policy.ts / card-discard-policy.ts。カードの開閉は受け手 (依頼窓口のスレッド) へ知らせる (破棄は知らせない)。
 *
 * @implements spec/feature/control-cards.md — 同期 (CC-V5-INV-03) / 破棄 (CC-V5-INV-08)
 */
import type { ControlCard } from "./card-domain.js";
import { planCardDiscards, type CardDiscardPlan, type CardOwnership } from "./card-discard-policy.js";
import { planCardSync, type CardSyncPlan } from "./card-sync-policy.js";
import type { ControlCardsRepository } from "./repository.js";
import type { CardSources } from "./sources.js";

export type CardChange = { kind: "opened" | "closed"; card: ControlCard };

export interface CardSyncPorts {
  repo: ControlCardsRepository;
  sources: Pick<CardSources, "read">;
  sessionEnded: (sessionId: string) => boolean | null;
  /** 持ち主の判定材料 (card-owner-sessions.ts)。throw したらその巡回は何も捨てない。無ければ破棄しない。 */
  ownership?: () => CardOwnership;
  now: () => number;
  id: () => string;
  onChange?: (change: CardChange) => void;
  log: { warn(message: string): void };
}

export type CardSyncResult = CardSyncPlan & { discard: CardDiscardPlan };

const identity = (kind: string, key: string) => `${kind}\u0000${key}`;

function readOwnership(ports: CardSyncPorts): CardOwnership | null {
  if (!ports.ownership) return null;
  try {
    return ports.ownership();
  } catch (error) {
    ports.log.warn(`control card ownership unreadable; nothing discarded this round: ${String(error)}`);
    return null;
  }
}

export function syncControlCards(ports: CardSyncPorts): CardSyncResult {
  const readings = ports.sources.read();
  const openCards = ports.repo.listOpen();
  const synced = planCardSync({ readings, openCards, sessionEnded: ports.sessionEnded });
  for (const kind of synced.unreadable) ports.log.warn(`control card source unreadable: ${kind}; its cards stay open`);
  // 破棄したカードは出所がまだ開いていても作り直さない (CC-V5-INV-08)。
  const discarded = new Set(ports.repo.discardedSources().map((row) => identity(row.source_kind, row.source_key)));
  const plan: CardSyncPlan = { ...synced, create: synced.create.filter((item) => !discarded.has(identity(item.source_kind, item.source_key))) };
  const discard = planCardDiscards({
    openCards, create: plan.create, closing: new Set(plan.close.map((row) => row.id)), ownership: readOwnership(ports),
  });
  const now = ports.now();
  const changes: CardChange[] = [];
  ports.repo.transaction(() => {
    for (const item of discard.createOpen) {
      const card = ports.repo.open(ports.id(), item, now);
      if (card.state === "open") changes.push({ kind: "opened", card });
    }
    for (const { item, reason } of discard.createDiscarded) ports.repo.openDiscarded(ports.id(), item, reason, now);
    for (const row of plan.refresh) ports.repo.refresh(row.id, row.summary, row.link, now);
    for (const row of plan.close) {
      if (ports.repo.close(row.id, row.reason, now)) changes.push({ kind: "closed", card: ports.repo.find(row.id)! });
    }
    for (const row of discard.discard) ports.repo.discard(row.id, row.reason, now);
  });
  for (const change of changes) notify(ports, change);
  return { ...plan, discard };
}

export function notify(ports: Pick<CardSyncPorts, "onChange" | "log">, change: CardChange): void {
  try { ports.onChange?.(change); } catch (error) { ports.log.warn(`control card notice failed: ${String(error)}`); }
}
