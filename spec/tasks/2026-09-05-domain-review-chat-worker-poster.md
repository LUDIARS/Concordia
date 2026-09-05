---
task: domain-review-chat-worker-poster
project: Concordia
kind: 実装
created: 2026-09-05
memory_links: []
---
# ドメインレビュー投稿を chat worker 構成でも成立させる

設計正本: `spec/feature/domain-review-discord.md` §5 (既知の制約)。
実装は PR #1405 (`feat/domain-review-discord`) で入った `src/domain-review/` と
`src/discord/domain-review-post.ts`。

## 目的

ドメインレビュー投稿が **chat を backend 内で動かしている構成でしか成立しない**状態を解消する。

投稿には Discord の guild ハンドルが要るため、Bot が ready した後に
`setDomainReviewPoster` で backend 側の参照へ投稿口を late-bind している
(federation egress と同型)。この参照は同一プロセス内でしか埋まらないので、
`CONCORDIA_CHAT_MODE=worker` で chat を別プロセスに出すと backend 側は null のままになり、
3 契機すべてが `post_failed` で無言に見送られる。

backend と chat worker は SQLite (WAL) を共有し、イベントは backend → worker の一方向 WS で
流れる。一方 `DomainReviewService.request()` は投稿した message id を
`domain_review_posts` に残す必要があり (C-6 の返信取り込みの同定キー)、
「投げっぱなしのイベント」では成立しない。ここが設計上の要点。

## 完了条件

- [ ] `CONCORDIA_CHAT_MODE=worker` の構成で、3 契機 (plan / local-pr / manual) いずれからでも
      Discord へ投稿され、`domain_review_posts` に message id が残ること。
- [ ] 投稿先解決 (明示指定 → active なセッション面 → houkoku) が embedded 構成と同じ結果になること。
- [ ] worker 側が落ちている / 未起動のときは、embedded 構成と同じく**理由付きで見送る**こと
      (`post_failed` を無言にしない)。PR 提出や plan 生成を巻き込んで失敗させない。
- [ ] `spec/feature/domain-review-discord.md` §5 の「既知の制約」を、解消後の実際の挙動に書き換える。
- [ ] 追加・変更したテストのみ実行して緑 (フルスイートは session 終了テストが実 CLI を呼ぶため走らせない)。

## 検討の入口 (決め打ちしない)

- worker へ「投稿してほしい」を届ける口を作り、結果 (platform / channel_id / message_id) を
  backend へ返す往復にする。既存の chat mutation outbox (`src/db/chat-mutation-outbox-repo.ts` /
  `src/platform/chat-mutation-outbox.ts`) が同じ形の問題を解いているので、まずそれに載るか調べる。
- あるいは `DomainReviewService` ごと chat 側で動かし、backend の API はそこへ委譲する。
  この場合 `domain_review_posts` の書き込み主体が変わるので、embedded 構成との二重書きに注意。
- どちらでも「投稿口が無い」を表す専用の skip 理由を足すか検討する
  (現状は `post_failed` に畳んでおり、送信失敗と配線欠如が区別できない)。

## スコープ (編集可ディレクトリ)

- `src/domain-review/`
- `src/discord/domain-review-post.ts`
- `src/bootstrap/core.ts` / `src/chat-worker.ts` (配線のみ)
- `spec/feature/domain-review-discord.md`
- `src/platform/` (chat mutation outbox に載せる場合のみ)
