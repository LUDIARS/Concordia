---
type: feature
title: "Discord セクションチャンネル → Notion 取り込みスキル"
description: "チームの相談・職種チャンネルで Cc が収集した投稿を、セッションが手動で Notion データベースへ重複なく追記・整理する手順の根拠。"
service: concordia
domain: chat-platforms
tags:
  - discord
  - notion
  - skill
status: implemented
related:
  - ./teams.md
updated: 2026-11-26
---

# Discord セクションチャンネル → Notion 取り込みスキル

> 所属ドメイン: [`chat-platforms`](../domains/chat-platforms.domain.json)
> Actio: actio:ac4a7d9d-8154-4937-babb-c69f72e14953

## 目的

チームの Discord セクションチャンネルに書かれた仕様・決定事項を、Notion をタスクボードとして使う
チーム (最初は Clicker-A / Clicker-B / Clicker-Test) の Notion にも残す。
提供物は `skills/discord-notion-sync/SKILL.md` の手順だけで、人の依頼で実行する。
自動起動・定期実行・Bot の常駐配線は含めない。画像・添付の取り込みに必要な Cc 側の収集と
読み取り API は 2026-11-26 に追加した (neco 指示「Cc変えていいよ」「画像だけの投稿を無視しないようにして」)。

## 対象チャンネル

[teams.md](./teams.md) の CC-TEAM-DISCUSSION-01 で Cc が収集する面だけを対象にする。

- チーム相談フォーラム (公開スレッド)、企画相談、プログラマー、デザイナー、サウンド、プランナー
  (`src/discord/team-discussion.ts` の `DISCUSSIONS`)。
- 目標・タスクボード・AI通知・管理・個人用スレッド・別チーム・Bot 投稿は収集されないので対象外。
- 面はチームの `team_surfaces` で引く。チームの Discord 面が未プロビジョニングなら取り込めない。

## 読み取り元

Cc には収集済み投稿の一覧を返す HTTP API が無い。スキルは Cc 本体の `concordia.db` を
`better-sqlite3` の readonly で開き、`team_discussion_messages` と `team_surfaces` を読む。
書き込み・スキーマ変更・Discord API の直接呼び出し・Bot トークンの利用はしない。

| 列 | 用途 |
|---|---|
| channel_id / message_id | 照合キー `discord:<channel_id>/<message_id>`、投稿日時 (snowflake から算出) |
| content | 原文 (画像・添付だけの投稿は空文字) |
| attachments_json | 添付の情報 `[{id,name,content_type,size,kind}]`。`kind` は `image` / `file`。URL は持たない |
| revision | 編集の検出 (編集時刻、未編集なら投稿時刻) |
| author_id | 読まない・Notion に書かない |

## 画像・添付

`attachments_json` が空でない投稿は、Cc の読み取り専用 API で実物を得る。

```
GET /v1/teams/:team_id/discussion/messages/:message_id/attachments
→ { ref: "discord:<channel_id>/<message_id>", channel_id, message_id,
    attachments: [{ kind: "image" | "file", name, size, path, url }] }
```

- Cc が bot で投稿を取り直し (CDN の URL は約 24 時間で切れるため記録しない)、既存の受信箱
  (`image-inbox` / `attachment-inbox`) で `<一時フォルダ>/concordia-team-discussion-attachments/<team_id>/` へ保存する。
  取得先は Discord の CDN だけ、画像は 1 投稿 4 枚・20MiB、その他は 10 件・25MiB、7 日で掃除。
- `path` は Cc と同じ機械のローカルパス、`url` はその場でだけ使える期限付き URL。どちらも Notion の原文欄には書かない。
- 記録された投稿だけを返す (別チームの `team_id` では 404)。Discord 未設定は 503、取得失敗は 502、保存失敗は 502 (`detail` に理由)。
- token は Cc が持ち、スキルには渡らない。

## 書き込み先と照合

- 書き込みは claude.ai の Notion コネクタで行う。Cc の Notion トークンは使わない。
- 取り込み先は人が指定した Notion データベース。未指定なら作らずに聞く。
- 1 投稿 1 ページ。`Source` (url 型) の完全一致で照合する (`src/taskflow/notion-work-pages.ts` と同じ方式)。
  同じ `版` は何もしない。新しい `版` は既存本文へ「編集後」として追記し、以前の原文を残す。
- 整理は「種類」 select とグループ表示のビューで行い、既存ページの原文を消さない。

## 前回の位置

取り込み記録ページに、実行ごとに `{ channel_id: 最後の message_id }` を追記する。
読み取り量を減らす補助であり、重複防止の正本は `Source` 照合とする。記録が壊れても全件読み直しで復旧できる。

## 秘匿語・個人情報

- トークンらしき文字列は `[伏字]`、メールアドレス・電話番号などは `[個人情報]` に伏せる。
- 投稿者 ID・投稿者名を Notion に追加しない。

## 未対応

- **過去の画像**: この変更より前に記録された投稿の `attachments_json` は `[]` のまま。bot の再接続時の履歴読み戻し
  (`team-discussion-history.ts`) で同じ投稿が記録し直され、添付の情報が埋まる。
- **ジャンプ URL**: Cc はチームの guild ID を保存しないため、Discord への直リンクは作らない。
- **自動実行**: 対象外。定期実行にする場合は Cc の機能として別途設計する。
