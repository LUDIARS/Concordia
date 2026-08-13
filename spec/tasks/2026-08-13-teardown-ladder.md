---
task: teardown-ladder
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/deterministic-teardown.md
  - spec/feature/session-shutdown.md
---
# 決定論終了 ladder (inject 再送 → 強制終了)

## 目的
completed + residual none、再キューを起案済みの partial、または ask detach で blocked 化した
run のセッションを、LLM の従順さに依存せず終了させる (deterministic-teardown §2)。

## 完了条件
- session-end inject が run 単位 exactly-once になり、5 分後・10 分後に最大 2 回再送される。
- 15 分 (`CONCORDIA_TEARDOWN_FORCE_SEC`) 経過で `endSession` による強制終了 +
  `teardown_forced` 監査イベントが記録される。
- 完了お伺い文言から「終了は自分で判断してください」が消え、お伺い応答を根拠にした
  確定指示になる。
- config 2 種 (`CONCORDIA_TEARDOWN_RETRY_SEC` / `_FORCE_SEC`) が settings 定義に載る。
- ladder 全分岐の単体テストが green。

## スコープ (編集可ディレクトリ)
- src/taskflow/
- src/control/
- src/config/settings/
