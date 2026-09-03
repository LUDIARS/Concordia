---
task: memoria-to-actio-task-source
project: Concordia
kind: 実装
created: 2026-09-04
memory_links:
  - spec/feature/task-workflow.md
  - spec/feature/reaction-workflow.md
  - spec/feature/teams.md
  - spec/feature/cc-task-fallback.md
---
# タスクの参照先を Memoria から Actio へ差し替える

## 目的

Actio `spec/feature/team-task/spec.md` §10「Cc 側変更 3」。
個人タスク API は Actio へ集約される。Cc の個人タスク操作の 4 経路が今も Memoria を直接向いており、
このままだと Cc だけが旧ハブを参照し続ける (設計では Cc の入口が Actio を直接向くことで
Memoria のハブ化そのものを不要にする)。

対象の 4 経路:

1. task-md reconciler
2. RWF (リアクションワークフロー、📝 ✅ ⏭️ 🫡。現在 cwd=Memoria でタスク登録)
3. spawn の task 選択 (`src/discord/memoria-task-cache.ts` → `actio-task-cache.ts` へ置換)
4. end-session-flow

## 完了条件

- 上記 4 経路が Actio のタスク API を参照し、個人タスク操作から Memoria への直接依存が
  残っていない (Memoria のメモ保存など、タスク以外の経路は本タスクの対象外)。
- `memoria-task-cache.ts` は `actio-task-cache.ts` へ置換され、型名・呼び出し側・テストが
  新モジュールを使う。
- reconciler は既存の `taskflow_task_state.actio_task_id` を正本にし、登録中 claim も
  Actio 用として管理する。移行前の `memoria_task_id` を Actio の ID として解釈せず、
  再起動や通信結果不明時にも同じタスクを二重登録しない。
- spawn が選んだタスクは `metadata.actio_task_id` に保存し、end-session-flow はその ID を
  Actio で完了にする。既存 session の `metadata.memoria_task_id` は誤って Actio へ送らず、
  対応表が無い場合は未完了のまま移行不能を観測可能にする。
- Actio が応答しないとき、無言で Memoria へフォールバックしない
  (二重の正本を作らないため)。RWF / spawn / end-session の各利用者に成功したように
  見せず、再試行可能か結果不明かを区別して失敗を表面化させる。
- 既存の `cc_tasks` outbox を再利用する場合、`pending` / `unknown` を Actio 同期成功として
  表示しない。採用する境界と失敗契約を `cc-task-fallback.md` にも反映し、実装済み仕様との
  矛盾を残さない。
- タスクの参照先 URL / ポートは Excubitor catalog から解決し、ハードコードしない。
- 4 経路それぞれについて、成功 / Actio 停止 / 結果不明 / 再実行の単体テストが green。

## 依存

Actio 側のタスク API が本タスクの対象範囲を満たしていること。
段階移行が必要なら経路単位で PR を分けてよい (1 経路 = 1 PR)。
