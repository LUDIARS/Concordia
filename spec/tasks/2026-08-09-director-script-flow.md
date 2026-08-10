---
task: director-script-flow
project: Concordia
kind: 実装
status: done
created: 2026-08-09
memory_links:
  - spec/feature/task-workflow.md
  - spec/feature/inquiry.md
---
# Director の原稿フローと Genius 判断代理

## 目的

ユーザー依頼を原稿フロー（分解、委託、実装、レビュー、確認、完了）として管理し、
実装の進行管理と判断を明確に分離する。Concordia Director は工程・成果物・
引継ぎを管理し、設計や優先順位の判断は Genius に代理させる。

## 完了条件

- Director case と工程 step を SQLite に永続化し、task md / delegation run /
  Revisor local PR を参照としてリンクできる。
- 判断依頼は Genius に渡す文脈と選択肢を保持し、返った判断・根拠・人間判断への
  escalation を Director decision として監査できる。
- Cc は判断内容を自作せず、Genius が不在または判断不能なら `self_judge` / `ask_human`
  を明示する。
- API は原稿フローの read model と、判断依頼・決定の作成だけを提供する。
  委託の自動起動、テスト開始、push、merge、停止は含めない。
- unit/API テストで状態遷移、参照リンク、Genius 不在、人間 escalation を担保する。

## スコープ (編集可ディレクトリ)

- src/director/
- src/api/
- src/db/
- spec/feature/
- spec/tasks/
