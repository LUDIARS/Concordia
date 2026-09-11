# AIノートの記事完成通知

## 目的と範囲

2026-09-11 neco 指示。Memoria #563 / `ai-note-discord-intake` の仕様を更新する。
執筆・校正・Notion 保存はセッションで行い、保存を確認したセッションが Cc に通知を依頼する。
通知はタイトル・短い紹介・記事リンク。Discord 通常チャンネル、Discord フォーラムの新規投稿、
Slack チャンネルを複数登録できる。フォーラムへの執筆依頼受付や自動執筆は今回の範囲外。

UX: UX-CC-W3/W4/W5、シナリオ S4/S5。不変条件: CC-INV-03/04/06。
Pf 登録 Concordia (`01M1XZZMEXWTFCN4HKW8K7TJKM`) は UX revision 0。
2026-09-11 An context と `src/platform/chat-platform.ts`、Discord/Slack 接続設定、
deployment 通知を照合。session 宛て送信は固定チャンネル/フォーラムを扱わないため流用せず、
既存の暗号化済み Bot 接続設定を共有する REST adapter を追加する。

## 状態と境界

- Article: Notion page ID が同一性。URL の表記揺れ・タイトル変更で別記事にしない。
- Destination: platform + server/workspace + channel が同一性。名前やタグの変更で二重投稿しない。
- Publication: 記事と宛先の組が集約。記事と宛先の snapshot を外部 I/O より前に永続化する。
- Cc が宛先設定・配送台帳を所有する。Notion の記事保存と Discord/Slack の受理を推測で代用しない。
- domain は型と純粋な同一性/本文ポリシー、application は手順、SQLite と REST は adapter。

`pending → sending → sent | failed | unknown`。SQLite の条件付き UPDATE で送信権を取得し、
attempt ID の一致する完了だけを反映する。同時呼び出し・再起動後も sent を再送しない。
外部宛先の検証後、POST の直前に送信権が残っていることも確認する。
設定変更は次回依頼から有効。既存の配送 snapshot は変更しない。
failed は送信前の検証失敗または明確な拒否。再送 API の明示呼び出しでのみ再試行する。
タイムアウト・5xx・受理後の応答不正は unknown。120 秒を過ぎた sending も unknown にする。
HTTP は各 15 秒、リダイレクト・自動再送なし。全 I/O は await し、DB transaction 内では送信しない。
unknown を再送しない。投稿 ID を指定して Bot の投稿・本文・宛先を照合するか、人間が宛先で
未投稿を確認した理由を記録して failed に戻す。遅れた旧 attempt の完了は反映しない。

## API と運用

Cc の既存 loopback 管理境界で `/v1/ai-notes` を提供する。外部 webhook 受付ではない。
宛先未設定の公開依頼は 409。暗黙の Cc チャンネルへの fallback はしない。

- `GET /targets`: 設定済み宛先。
- `PUT /targets`: `{ "targets": [...] }` で全置換。0〜10 件、同一物理宛先の重複禁止。
- `POST /preview`: Article を検証し本文と宛先を返す。投稿も台帳更新もしない。
- `POST /publications`: Article を受け取り今回設定された宛先ごとの結果を返す。全件 sent の時だけ `ok: true`。
- `GET /publications/:page_id`: 永続化された宛先ごとの snapshot と結果。
- `POST /publications/:page_id/retry`: `{ "target_key": "..." }`。failed のみ再試行。
- `POST /publications/:page_id/reconcile`: `{ "target_key": "...", "message_id": "...", "channel_id": "..." }`。
  unknown の投稿を読み取り照合する。フォーラムの channel_id は作成された thread ID。
- `POST /publications/:page_id/confirm-absent`: `{ "target_key": "...", "confirmed_by_human": true, "reason": "..." }`。
  宛先を人間が確認した記録を残す。unknown を failed に戻すだけで投稿はしない。

Article は `{ "page_id": "Notion UUID", "title": "記事タイトル", "summary": "短い紹介", "url": "https://app.notion.com/p/PAGE_ID" }`。
Notion の HTTPS URL と同じ page ID が必要。title 200、summary 600、URL 400 文字まで。
同じ記事を再度依頼しても既存通知を編集・再送しない。新しい宛先だけ追加通知できる。

宛先形式:

```json
{
  "targets": [
    { "kind": "discord-channel", "guild_id": "SERVER_ID", "channel_id": "CHANNEL_ID" },
    { "kind": "discord-forum", "guild_id": "SERVER_ID", "channel_id": "FORUM_ID", "applied_tags": [] },
    { "kind": "slack-channel", "team_id": "T_WORKSPACE_ID", "channel_id": "C_CHANNEL_ID" }
  ]
}
```

実 ID を指定する。Discord は既存 Bot が対象 guild に参加している必要がある。
送信直前に guild/channel の種類とフォーラムタグを照合する。Slack は auth.test の team と
conversations.info のチャンネル/所属を確認する。DM・アーカイブ済みチャンネルは拒否する。
既存接続の enabled と Bot token を尊重する。Slack の送信自体に Socket Mode 接続は不要。
トークンは API/台帳/ログに出さない。本文からの全体メンション・ユーザーメンションは無効。
Slack は送信に `chat:write` とチャンネル参照に `channels:read`（非公開なら `groups:read`）が必要。
照合時は `channels:history` / `groups:history` も必要。Discord の既存 forum-spawn は Bot 自身の
投稿を owner ID で除外するため、この通知から執筆セッションは起動しない。
URL のアクセス権は Notion の共有設定に従うため、執筆セッションが読者の共有範囲を確認する。

## 検証と導入

重複依頼/並行 claim、宛先追加、部分失敗、unknown の再送拒否、照合、誤った宛先、メンションを検証対象とする。
サービス起動・テスト実行・実チャンネルへの投稿は、その操作の許可と実宛先が揃った時に行う。
現時点で実宛先は未指定。記事執筆を終えただけで「通知済み」と報告しない。
セッションの利用手順: [ai-note-publication](../../skills/ai-note-publication/SKILL.md)。

レビュー時の確認記録 (2026-09-11): バックエンドとテストコードを含む TypeScript 型チェック、
dependency-cruiser の依存境界検査、domain 所属/参照先、2 本のスキルの形式検査、差分の空白検査を実施。
ユニット/API テストは追加済みだが未実行。サービス起動・再起動・実投稿も未実施。
SQLite migration 102 の導入が必要。既存接続が無効/未設定なら通知は失敗結果を返す。
Castra の既存執筆スキルへの導線は別リポジトリの 5 行変更で、直接 main commit の自動審査に拒否され未コミット。

参照: [Discord forum API](https://docs.discord.com/developers/resources/channel#start-thread-in-forum-or-media-channel)、
[Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)、
[Slack conversations.info](https://docs.slack.dev/reference/methods/conversations.info/)。
