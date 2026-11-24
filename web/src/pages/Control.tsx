/**
 * 管制 (/control、Cc v5)。カード・Actio タスク・動いているセッション (プランと進捗)・スプリント状況の 4 欄。
 * 管理は Web、各セッションへの細かい指示は Discord のセッション用チャンネル (実装メモ 12)。
 */
import { CardsPanel } from "./control/CardsPanel.js";
import { SessionsPanel } from "./control/SessionsPanel.js";
import { SprintsPanel } from "./control/SprintsPanel.js";
import { TasksPanel } from "./control/TasksPanel.js";

export function Control() {
  return <div className="max-w-6xl mx-auto space-y-6">
    <div>
      <h1 className="text-xl font-semibold">オーバービュー</h1>
    </div>
    <SessionsPanel />
    <div className="grid gap-6 lg:grid-cols-2">
      <CardsPanel />
      <TasksPanel />
      <SprintsPanel />
    </div>
  </div>;
}
