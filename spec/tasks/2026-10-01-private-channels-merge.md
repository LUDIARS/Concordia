---
task: 2026-10-01-private-channels-merge
project: Concordia
kind: 実装
created: 2026-10-01
memory_links: []
---
# プライベートチャンネルの統合 (#2187 の用途をプライベート相談の実装に取り込む)

設計正本: `spec/feature/private-channels.md`。director case `dir_2a273424` plan v1 承認済み (2026-10-01 neco)。
neco 判断「プライベート相談に統合」。#2187 (Actio `e83728cc`) は closed。

## 目的

閉じた Discord チャンネルを作る実装を 1 本にし、AI セッションや人が「指定した人だけが見られるチャンネル」を作って
秘匿性のある報告や個人宛ての成果物を流せるようにする。

## 完了条件

- [ ] 閉じたチャンネルの作成・閲覧者の付け外し・書き込み停止を `src/discord/private-channel-discord.ts` に寄せ、`/consult` もそれを使う。
- [ ] カテゴリを「プライベート」1 つにまとめる (保存済みの旧相談カテゴリは引き継いで改名する)。
- [ ] `POST /v1/discord/private-channels` (閲覧者省略時は管理者、冪等キー、初回投稿) と `GET /:id`。Bot がイベントと起動時に pending を作る。
- [ ] `POST /v1/chat` の `discord_channel_id` に ready のプライベートチャンネルを指定して投稿できる。
- [ ] migration 119 `private_channels`、policy / repo / API / Discord 面 / egress のテストを同じ変更で書き、`cc.acceptance.json` に対応付ける。

## スコープ (編集可ディレクトリ)

- `src/discord/`、`src/platform/`、`src/api/`、`src/db/`、`src/bootstrap/`、`src/events.ts`、`src/shared/`、`spec/`、`tests/`
