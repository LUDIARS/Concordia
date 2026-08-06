---
task: ai-note-discord-intake
project: Concordia
kind: 実装
status: pending
created: 2026-07-24
source_session: lictor-fe4563c3-c143-4720-a108-e6be40ff2526
memoria_task_id: 563
actio_task_id: null
memory_links:
  - project-discord-forum-migration.md
  - project-ai-note-opus-articles.md
---
# Discord に AIノート専用窓口(専用フォーラムチャンネル)を作る

## 目的

neco 指示 (2026-07-18, Memoria #563)。Discord 側に Notion AIノートへの記事依頼を受け付ける
専用窓口を作りたい。2026-07-24 の朝タスク処理で実装方式を確認し、以下で決定した:

- **専用フォーラムチャンネルを新設**し、既存の Discord フォーラム移行 (spec Cc#326, 決定 1b/2a/3a/4a)
  と統一する。フォーラムの新規スレ = 1依頼として扱う。
- 実装は Lictor 側の新規サービスではなく **Concordia の既存 Discord フォーラム基盤
  (`src/discord/forum-project-code.ts`, `channel-directory.ts` 等) の拡張** で完結させる方針。

設計フローは: Discord フォーラム新規スレ (窓口チャンネル) 投稿 → Concordia が検知 →
Memoria タスク化 (category: AIノート) → 別セッションが `/mmtask` 等で拾って
Notion AIノートに記事作成 → 完了報告をスレへ返信。

## 完了条件

- [ ] 専用フォーラムチャンネルの作成方針を確定 (チャンネル名・カテゴリ、既存フォーラム移行の
      チャンネル一覧との整合)。実チャンネル作成が必要な場合は人間 (neco) の Discord 操作が要るため、
      その手順を明記して引き継ぐ。
- [ ] 新規スレ (依頼) 検知 → Memoria タスク起票 の経路を実装する
      (`src/discord/` 側で新規スレのメッセージイベントを拾い、`src/memoria/client.ts` の
      `createTask` 経路で category=AIノート のタスクを作る)。
- [ ] タスク完了時、元スレへ完了報告 (Notion ページリンク等) を返信する経路を実装する。
- [ ] 手動で新規スレを立てても、担当外のフォーラムへ投稿しても誤作動しないことを確認する
      (§2.3 相当の「タスク無し」判定に近い安全側動作)。
- [ ] spec/feature/ 配下 (Discord フォーラム移行 spec の近く) に本機能の仕様を追記する。

## スコープ (編集可ディレクトリ)

- `src/discord/` (forum-project-code.ts, channel-directory.ts, commands/ 等)
- `src/memoria/` (タスク起票経路)
- `spec/feature/` (フォーラム移行 spec への追記)
- `spec/tasks/` (この md)
