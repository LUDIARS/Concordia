---
task: ai-note-discord-intake
project: Concordia
kind: 実装
created: 2026-07-24
memory_links:
  - project-discord-forum-migration.md
  - project-ai-note-opus-articles.md
---
# AIノート完成記事を Discord / Slack に通知・投稿する窓口

## 目的

元依頼は 2026-07-18 neco / Memoria #563。2026-07-24 に Discord フォーラムでの依頼受付案を記録した。
2026-09-11 の neco 指示により、**執筆はセッションで行い、書き上げた時の通知・投稿を窓口が担う**仕様へ変更する。
既存タスク ID を維持し、新しい依頼受付・自動執筆タスクを重複起票しない。

流れ: セッションで Notion 保存確認 → Cc に完成記事を通知 → 設定した Discord チャンネル/フォーラム、
Slack チャンネルへタイトル・紹介・Notion URL を投稿 → 宛先ごとの実送信結果をセッションへ返す。
詳細: [AIノートの記事完成通知](../feature/ai-note-publication.md)。

## 完了条件

- Discord 通常チャンネル、フォーラム、Slack チャンネルを明示設定できる。
- 記事ごとの通知プレビューと投稿ができ、送信後の投稿リンクを返す。
- 同一記事・同一宛先への重複依頼は再送しない。部分失敗は宛先単位で扱う。
- 結果不明の送信は照合または人間の未投稿確認まで再送しない。
- 執筆手順から通知 API への導線と、実宛先設定・Bot 権限の条件を記す。
- 実宛先を neco が指定した後、設定と許可された実投稿を行い到達を確認する。

## スコープ (編集可ディレクトリ)

- `src/ai-notes/`、`src/api/`、`src/db/`、`src/bootstrap/` (Cc 内の通知機能)
- `skills/` (セッションからの利用手順)
- `spec/feature/`、`spec/domains/`、`spec/tasks/`
