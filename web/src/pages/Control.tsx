/**
 * 管制 (/control、Cc v5)。カード・Actio タスク・動いているセッション (プランと進捗)・スプリント状況の 4 欄。
 * 管理は Web、各セッションへの細かい指示は Discord のセッション用チャンネル (実装メモ 12)。
 */
import { CardsPanel } from "./control/CardsPanel.js";
import { SessionsPanel } from "./control/SessionsPanel.js";
import { SprintsPanel } from "./control/SprintsPanel.js";
import { TasksPanel } from "./control/TasksPanel.js";
import { controlApi } from "./control/controlApi.js";
import { usePolling } from "./control/usePolling.js";

export function Control() {
  const openCards = usePolling(signal => controlApi.cards("open", signal), 15_000);
  return <div className="max-w-6xl mx-auto space-y-6">
    <div>
      <h1 className="text-xl font-semibold">オーバービュー</h1>
    </div>
    <SessionsPanel cards={openCards.data?.cards ?? []} cardError={openCards.error} cardsReconnecting={openCards.reconnecting} />
    <div className="grid gap-6 lg:grid-cols-2">
      <CardsPanel openCards={openCards} />
      <TasksPanel />
      <SprintsPanel />
    </div>
  </div>;
}
