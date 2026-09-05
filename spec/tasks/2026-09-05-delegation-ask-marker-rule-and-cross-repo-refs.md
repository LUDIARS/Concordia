---
task: delegation-ask-marker-rule-and-cross-repo-refs
project: Concordia
kind: 実装
created: 2026-09-05
memory_links:
  - spec/plan/problem_logs/2026-09-05-delegated-claude-session-used-askuserquestion.md
---
# 委託の子セッションへ ask マーカー規則を注入し、別リポの正本参照を同梱する

## 目的
問題ログ 2026-09-05 (委託先 Claude セッションが AskUserQuestion を使った) の修正要件 3・4。
子セッションへの指示に ask マーカー規則が無く、また委託文が cwd 外 (別リポ) の設計書をパスで
示しただけだったため、読めずに picker へ逃げた。

## 完了条件
- `src/taskflow/task-instructions.ts` に「質問は `ask` マーカー (JSON)。AskUserQuestion は使えない」の
  規範文言を 1 本置き、`src/delegation/persona-context.ts` の子への指示 (完了報告 JSON の説明の隣) と
  implementation-inject の本文から参照する。経路ごとに文言を複製しない
- `memory_links` と明示的なファイル参照 input (`design_path` など、対象キーはコード上の allowlist にする)
  に指定された `.md` のうち、spawn cwd (worktree) の外、かつ別の登録済み repo root 内にあるものは、
  prompt 生成時に本文を「同梱正本」節として展開する。自由文の `task` / `context_extra` からパスらしい
  文字列を抽出して自動読込しない
- 読込前に realpath を解決して登録済み repo root 内であることを確認する。未登録ディレクトリ、ユーザー
  プロファイル、repo 外への traversal / symlink は読まず、prompt に理由付きの非同梱注記を出す
- 同梱量は UTF-8 byte 数と行数の両方に上限を設け、超えたら上限内の完全な文字まで + 省略注記とする。
  run に記録する同梱元は絶対パスでなく `<project>:<repo-relative-path>` の形に正規化する
- delegation テンプレ (sol-mid / sonnet-mid / opus-mid / fable-mid 等) の description に
  「別リポの設計書はパスだけでは読めない。登録済み repo の文書を `memory_links` / ファイル参照 input
  で明示して本文を同梱するか、cwd 内コピーが要る」を追記
- 単体テスト: persona-context スナップショットに規則 1 行、別の登録済み repo 内 md の同梱
  (展開あり/上限超過/spawn cwd 内は展開しない)、未登録 repo・traversal は非同梱、自由文内のパスは
  読み込まない
- spec/feature/task-workflow.md §3.2 (追加メモリは外部リンクで渡す) に「別リポ md は同梱する」を追補

## スコープ (編集可ディレクトリ)
- src/delegation
- src/taskflow
- spec/feature
- tests
