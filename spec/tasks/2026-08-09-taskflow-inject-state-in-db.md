---
task: taskflow-inject-state-in-db
project: Concordia
kind: 実装
created: 2026-08-09
memory_links: []
---
# 分解 inject の文言を「状態は Cc DB 正本」へ切り替える

## 目的

task md に進行状態 (status / 担当 / PR 番号 / 外部タスク ID) を書き戻す運用は、 タスクが進むたびに
md の更新差分を作り、 実装 PR に無関係な diff を載せる (2026-08-09 neco 指示)。 進行状態は
`taskflow_task_state` (Cc DB) が正本なので、 セッションへ配る指示文言をすべてそれに合わせる。

タスク本体を DB へ移す改修は影響範囲が大きいため今回は行わない。 inject 側の指示だけを切り替える。

## 完了条件

- 分解 inject (`DECOMPOSE_PROMPT`)、 ハーネス builtin ルール、 kind 別 inject マニュアルが
  「md は新規保存のみ / 状態は Cc DB 正本 / 書き戻さない」を述べている。
- 文言が 1 モジュール (`src/taskflow/task-instructions.ts`) に集約され、 経路ごとにずれない。
- seed は既存行を上書きしないため、 稼働中 DB の既定文言を差し替える migration がある
  (ユーザが WebUI で編集した行は触らない)。
- spec (`spec/feature/task-workflow.md` §1/§2.1/§2.3/§4.2) と `docs/manual/01-main-features.md`
  が同じ規範を書いている。

## スコープ (編集可ディレクトリ)

- `src/taskflow/`, `src/subsidiary/harness-seed.ts`, `src/control/inject-manual-seed.ts`, `src/db/schema.ts`
- `spec/feature/task-workflow.md`, `docs/manual/01-main-features.md`
