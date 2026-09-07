---
task: discord-expandable-text-attachments
project: Cc
kind: feature
created: 2026-09-08
memory_links: []
---

# Discordのテキスト添付を展開可能にする

## 目的
添付資料を外部アプリへ移動せずDiscord内で読む。UX-CC-W3、CC-INV-06。

## 対応範囲
chat-platformsの添付表示ポリシーを分離し、検査済みUTF-8テキストを.txt名で送る。
仕様: spec/feature/discord-ui.md#テキスト添付の展開。

## 受け入れ条件
- Markdown/JSON/ログなどの添付にDiscord標準のテキストプレビューを利用する。
- 全文と元ファイルを保持し、バイナリや不正UTF-8を変換しない。
- 既存の送信先・パス検査・配達判定を維持する。

## 検証
文字種、拡張子、長文、バイナリの契約を確認する。テスト・起動の実行は人間の明示許可に従う。
