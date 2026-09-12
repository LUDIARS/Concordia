# 新規プロジェクトの本社通知

新しいプロジェクトを作って最初に push した時点で、本社チャンネルへ 1 回だけ知らせる。
「作った」だけでは鳴らさない。空のリポジトリを本社へ流しても読む側が確認できないため、
実体が push された時刻を通知の時刻とする。

## 契機は 2 段

登録が控えを作り、push が発火させる。1 つの API では表せないので 2 点に分かれる。

1. `POST /v1/project-codes` が GitHub origin つきの**新規**登録を受理したとき、
   `project_notice_ledger` に `notified_at = NULL` の控えを作る (arm)。
   既に同じ repository の控えがあれば作らない。登録だけでは何も送らない。
2. `POST /v1/sessions/:id/push-check` が `allowed: true` を返す push で、
   その repository の未通知の控えを 1 つだけ確定させて送る (claim → 配送)。

controlled されるのは repository (`owner/name` に正規化した GitHub 識別子) 単位であり、
branch や session ではない。control されていない既存リポには控えが無いので鳴らない。

## 宛先と本文

宛先は `discord.release_notify_channel_id`、公開リリース通知と同じ**本社専用**チャンネル。
本社内は公開・非公開を問わず全件通知する。公開リポの外部向け通知は従来どおり明示指定のままで、
この経路では扱わない。

```text
【<repository> 新規プロジェクト】 <code> <project>
<GitHub URL>
```

Bot 投稿は `allowed_mentions: { parse: [] }` を使い、プロジェクト名を mention として解釈させない。
チャンネル未設定なら配送を試みず、控えは確定済みのまま `unconfigured` を返す。

## 不変条件

- **CC-INV-P1** 1 つの repository が本社通知を受けるのは高々 1 回。控えの確定 (`notified_at`) は
  配送の前に行い、配送に失敗しても戻さない。二重投稿より欠落を選ぶ。
- **CC-INV-P2** 通知は push の可否に影響しない。配送の失敗・遅延・チャンネル未設定のいずれも
  `push-check` の `allowed` を変えない。
- **CC-INV-P3** 控えの無い repository では配送処理に入らない。既存リポの日常の push で
  本社チャンネルが鳴ることはない。

## 観測

`project-created` logger が `delivered` / `unconfigured` / `failed` を記録する。
`skipped` (控え無し) は通常の push で常に起きるのでログに残さない。
