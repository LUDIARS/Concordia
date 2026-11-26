/**
 * 管制 (/control、Cc v5)。カード・Actio タスク・動いているセッション (プランと進捗)・スプリント状況の 4 欄。
 * 管理は Web、各セッションへの細かい指示は Discord のセッション用チャンネル (実装メモ 12)。
 */
import { useCallback, useRef, useState } from "react";
import { AiQuotaOverlay } from "./control/AiQuotaOverlay.js";
import { CardsPanel } from "./control/CardsPanel.js";
import { SessionsPanel } from "./control/SessionsPanel.js";
import { SprintsPanel } from "./control/SprintsPanel.js";
import { TasksPanel } from "./control/TasksPanel.js";
import { controlApi } from "./control/controlApi.js";
import { usePolling } from "./control/usePolling.js";

export function Control() {
  const openCards = usePolling(signal => controlApi.cards("open", signal), 15_000);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const quotaButton = useRef<HTMLButtonElement>(null);
  const closeQuota = useCallback(() => {
    setQuotaOpen(false);
    quotaButton.current?.focus();
  }, []);
  return <div className="max-w-6xl mx-auto space-y-6">
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">オーバービュー</h1>
      <button
        ref={quotaButton}
        type="button"
        className="rounded border border-border px-3 py-1.5 text-sm hover:bg-surface"
        aria-haspopup="dialog"
        aria-expanded={quotaOpen}
        onClick={() => setQuotaOpen(true)}
      >
        AI 残量
      </button>
    </div>
    {quotaOpen && <AiQuotaOverlay onClose={closeQuota} />}
    <SessionsPanel cards={openCards.data?.cards ?? []} cardError={openCards.error} cardsReconnecting={openCards.reconnecting} />
    <div className="grid gap-6 lg:grid-cols-2">
      <CardsPanel openCards={openCards} />
      <TasksPanel />
      <SprintsPanel />
    </div>
  </div>;
}
