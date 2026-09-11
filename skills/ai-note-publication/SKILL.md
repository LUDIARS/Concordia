---
name: ai-note-publication
description: セッションで保存を確認した AIノートの記事を、設定済みの Discord チャンネル/フォーラムや Slack チャンネルへ通知する。執筆は既存の ai-note-writing 手順で行う。
---

# AIノートの完成通知

執筆を終えたセッションが Cc に記事のタイトル・短い紹介・Notion URL を渡す。
外部投稿の許可と宛先の指定はユーザーの依頼に従う。許可済みの同じ運用を毎回再確認しない。

1. Notion への保存・本文・配置を fetch で確認する。読者に必要な共有範囲も確認する。
2. Cc の現行 `excubitor.catalog.yaml` から backend endpoint を解決し、`GET /v1/ai-notes/targets` を読む。
   未設定なら投稿先の指定を求め、タイトル・紹介・URL のプレビューを残す。404 は未導入であり通知成功ではない。
3. 必要なら `POST /v1/ai-notes/preview` で見た目と宛先を確認する。
4. `POST /v1/ai-notes/publications` に以下を JSON で送る。日本語の body は UTF-8 ファイルから送信する。

```json
{
  "page_id": "保存済みページの UUID",
  "title": "記事のタイトル",
  "summary": "記事の読みどころを短く紹介する文",
  "url": "保存済みページの Notion HTTPS URL"
}
```

`publications[].status` と `receipt.message_url` を確認し、実際に送信できた投稿先だけを完了として報告する。
同じページ ID での再依頼は送信済み宛先への重複投稿を防ぐ。記事の修正だけでは再通知しない。
失敗時は `GET /v1/ai-notes/publications/PAGE_ID` を読んでから対応する。
`failed` は原因を直して当該宛先だけ `/retry`。`sending` / `unknown` は再送しない。
unknown は `/reconcile` に投稿 ID を渡して照合する。未投稿として解消する場合は、人間が投稿先を
確認した旨と理由を得てから `/confirm-absent` を使う。応答のタイムアウトだけを未投稿の証拠にしない。

宛先設定・復旧 body・必要な権限は [仕様](../../spec/feature/ai-note-publication.md) を必要時に読む。
トークンの貼り付けや、新しい Bot/接続の自動起動はこの手順では行わない。
