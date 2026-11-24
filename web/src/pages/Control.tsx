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
      <h1 className="text-xl font-semibold">管制</h1>
      <p className="text-sm text-subtle mt-1">人間のアクション・判断 (カード)、Actio タスク、動いているセッション、スプリントを 1 画面で見ます。カードの捌きは dots と人間が変えられます。</p>
    </div>
    <div className="grid gap-6 lg:grid-cols-2">
      <CardsPanel />
      <SessionsPanel />
      <TasksPanel />
      <SprintsPanel />
    </div>
  </div>;
}
