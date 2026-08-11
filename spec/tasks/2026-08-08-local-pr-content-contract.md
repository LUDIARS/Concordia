---
task: local-pr-content-contract
project: Concordia
kind: 実装
status: pending
created: 2026-08-08
source_session: lictor-b500f710-748b-446e-9850-6eb2b4f35293
memoria_task_id: null
actio_task_id: null
memory_links: []
---
# Local PR 内容の構造化契約

## 目的

Cc が Revisor へ自動提出する local PR について、コミット件名だけではなく、作業時に設計した task md の内容を日本語の PR タイトルと本文として渡す。

## 完了条件

- 提出 session と `source_session` が一致する task md のタイトル、目的、完了条件を、`## 実装内容` と `## 受け入れ条件` に分けて提出する。
- task md が不足・不完全・過大なときは、Revisor の内容契約を満たすコミット件名ベースの本文へフォールバックし、空セクションや途中で切れた本文を送らない。
- Cc / Delegation が起動する LLM に、task md のタイトル・目的・完了条件を日本語かつ空欄なく記録するよう伝える。

## スコープ

- `src/pr/` の local PR 提出内容
- Cc workflow / Delegation の起動コンテキスト
- local PR 提出仕様と問題記録
