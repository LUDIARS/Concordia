---
type: plan
title: "Slack session-per-channel 移行タスク"
description: "Slack の thread-per-session を廃止し、Bot のみ在籍する公開 session channel と Hub Canvas 索引へ移行する実装指示。通知ノイズを抑えながら閲覧性・inject・質問回答・完了履歴を維持する。"
service: concordia
domain: chat-platforms
tags:
  - slack
  - task-instructions
  - notification
  - channel-lifecycle
  - codex
status: planned
related:
  - ../../feature/slack-platform.md
  - ../../setup/slack.md
  - ../../../src/slack/bot.ts
updated: 2026-07-16
---

# Slack session-per-channel 移行タスク

タスク記録: Memoria #512。
承認済み方針: **公開・Bot のみ在籍・1 session = 1 channel・中央 Canvas で索引・終了後 archive**。

## 1. 背景と目的

現行 Slack 実装は 1 運用チャンネル内の `thread-per-session` である。Slack は、
スレッドを開始した・返信した・mention されたユーザーへ以後の返信通知を送るため、
Concordia の高頻度 relay が通知ノイズになる。

旧 Concordia の channel-per-session に近い構造へ戻し、以下を同時に満たす。

- 通常時は各 session channel に Bot だけが在籍し、人間へ通知しない。
- workspace member は公開チャンネルとして検索・閲覧できる。
- 人間が明示的に参加してトップレベル投稿した場合だけ、その session へ inject する。
- session 一覧は Hub channel の Canvas へ集約し、チャンネル乱立による探索性低下を防ぐ。
- 終了済み channel は猶予後に archive し、履歴を残しつつ active 一覧から外す。

## 2. スコープ

このタスクは **Slack platform の session surface とその永続化・索引・ライフサイクルのみ**を変更する。

対象:

- `src/slack/**`
- Slack 用 DB schema / migration / repository
- Slack bootstrap 配線に必要な最小限の read-model 契約
- `spec/feature/slack-platform.md`, `spec/setup/slack.md`, spec index
- 関連 unit/integration tests

対象外:

- Discord の Forum / channel 実装
- Slack の User Group / shared sidebar section 自動管理
- private channel や人間の自動招待
- per-user notification 設定の変更
- Slack live 接続を worktree から起動して試験すること
- 隣接する chat-worker / delegation / Discord refactor

## 3. Hub と session channel

### 3.1 Hub channel

既存 `CONCORDIA_SLACK_CHANNEL_ID` は削除・rename せず、Cc の Hub channel ID として使う。

Hub の責務:

- session 非紐付け chat / consultation の既存経路
- slash command / delegation modal の既存経路
- Cost Canvas の既存経路
- 新規 Sessions Canvas の配置先

Hub に session の全文 relay を投稿してはならない。

### 3.2 session channel

session surface が必要になったら Bot token で public channel を作る。

- `conversations.create({ is_private: false })`
- Bot は作成者として member になる。
- 人間を invite しない。
- 通常 relay で user mention / `@channel` / `@here` を生成しない。
- channel ID を routing の正本とし、channel name は表示用とする。

命名:

```text
cc-run-<session-id先頭8文字>-<slug>
```

- Slack 制約に合わせ lowercase ASCII / digit / hyphen のみ、80文字以内。
- `slug` は current task / title から作り、空なら `session`。
- `name_taken` 時は session ID を12文字へ延長し、それでも衝突する場合は決定的 suffix で再試行する。
- session 終了時に channel を rename しない。完了表現はヘッダーと Canvas、整理は archive で行う。

topic / purpose:

- topic: short session ID、persona/provider、current task、状態を250文字以内で表示。
- purpose: Concordia が管理する session channel であることと、完全な session ID を保持。
- title/task/persona 更新時は topic とヘッダーカードを best-effort 更新する。

## 4. 永続化とライフサイクル

`slack_session_channels` を新設し、少なくとも次を永続化する。

- `session_id` (primary key)
- `channel_id` (unique)
- `channel_name`
- `header_ts`
- `created_at`
- `archive_due_at` (nullable)
- `archived_at` (nullable)

要件:

- schema migration は冪等。
- 既存 `slack_session_threads` をこのタスクで drop しない。rollback / 履歴保全のため残すが、新規 routing には使わない。
- 同一 session の channel 二重作成を in-flight lock と DB unique constraint の両方で防ぐ。
- API 成功後の DB 永続化に失敗した場合を観測可能にし、黙って別 channel を量産しない。

`session.started` または `ChatPlatform.ensureSessionSurface` で channel とヘッダーカードを保証する。

`session.ended`:

1. ヘッダーカードを `Done` に更新する。
2. `archive_due_at` を設定する。
3. Sessions Canvas を更新する。
4. archive sweeper が期限到来後に `conversations.archive` を呼び、成功後 `archived_at` を記録する。

設定:

```text
CONCORDIA_SLACK_ARCHIVE_DELAY_MIN
```

- 既定30分。
- 非負の有限数だけ受理する。`0` は即時 archive を許可する。
- 無効値は警告して既定値へ戻す。
- archive sweeper は単一 timer とし、`stop()` で必ず解放する。
- 起動時にも期限超過行を掃除し、再起動で archive が永久に失われないようにする。

archive が権限・一時障害で失敗した場合は `archived_at` を書かず、次回 sweep で再試行する。

## 5. Slack ingress / egress

### 5.1 egress

session 紐付け出力は対応する session channel のトップレベルへ投稿する。

- `chat.posted`
- relay 対象の `transcript.frame`
- `question.posted` の Block Kit
- working indicator
- reaction workflow の ack / result
- completion / report card 更新

これらの `chat.postMessage` に `thread_ts` を渡してはならない。

session 非紐付け chat は従来どおり Hub channel へ投稿する。

### 5.2 ingress

`message.channels` を channel ID で分類する。

- mapped session channel の **トップレベル human message**: 対応 session へ inject。
- Hub channel のトップレベル human message: 従来どおり consultation chat。
- 未知の channel: ignore。
- Bot 自身、編集 subtype、system subtype: ignore。
- `thread_ts` を持つ reply: session routing に利用せず ignore し、debug/info で理由を観測可能にする。

通常 relay は user mention を生成しない。ユーザー入力中の mention は既存 sanitizer の契約を維持する。

### 5.3 質問とインタラクション

質問は session channel のトップレベルに投稿する。回答ボタン更新時は質問 message 自身の `ts` を使う。
interaction から session を引く際は `channel_id -> session_id` mapping を使い、`thread_ts` に依存しない。

## 6. ライブカードと working indicator

- channel 最初のメッセージを session header card とし、`header_ts` を保存する。
- persona / task / title / ended / report 更新は同じ message を `chat.update` する。
- card 文言から「スレッドへ返信」を除き、「このチャンネルへ投稿すると session に送信」に変更する。
- working indicator は session channel のトップレベルに出す。既存 controller を再利用できる場合も、Slack I/O adapter は channel-per-session 用に分離する。

`src/slack/bot.ts` に channel provisioning、archive sweep、Canvas rendering を詰め込まない。
SRP に従い、最低でも repository / channel naming+provisioning / archive lifecycle / Sessions Canvas を別モジュールに分ける。

## 7. Sessions Canvas

Hub channel に `Cc Sessions` Canvas を1つ作り、`slack_config` の `sessions_canvas_id` に保存する。
Cost Canvas と同じ create/edit/recreate パターンを再利用するが、責務は別モジュールにする。

表示セクション:

- Active
- Waiting
- Recently completed
- Failed / abandoned

各行に可能な範囲で以下を出す。

- Slack channel link
- short session ID
- persona / provider
- current task
- updated time

分類は既存 DB / read-model の権威状態だけから行う。推測で failure や waiting を作らない。
既存状態で判別不能な section は空表示とし、そのためだけに新しい core 状態機械を作らない。

更新契機:

- session started / ended
- persona assigned
- task / title update
- question posted / answered / resolved
- report generated
- archive success

イベント burst は debounce し、同時 edit を直列化する。Canvas が削除・失効していたら保存 ID を消し、次回更新で再作成する。
Canvas 更新のために Hub へ新規 chat message を連投してはならない。

## 8. 権限・設定・ドキュメント

Slack App manifest / setup に public channel 管理用 scope を追加する。

- `channels:manage`
- 既存の `chat:write`, `channels:read`, `channels:history`, `reactions:read`, `commands` 等は維持。

起動時または最初の provisioning 失敗時、`missing_scope` / `restricted_action` を明示ログに出す。
設定不足を thread-per-session へ silently fallback してはならない。

`spec/feature/slack-platform.md` は次を正本化する。

- thread-per-session 廃止
- Hub channel + session-per-channel
- public / Bot-only membership
- top-level ingress / egress
- Sessions Canvas
- archive lifecycle
- 旧 `slack_session_threads` は互換用に残ること

## 9. テスト

最低限、以下を自動テストする。

- channel name sanitize / truncate / collision retry
- `slack_session_channels` repository の upsert / reverse lookup / archive due query
- 同一 session の concurrent ensure が channel を1つだけ作る
- session egress に `thread_ts` が無い
- Hub message と session channel message の routing
- thread reply を inject しない
- question interaction が channel mapping で session を解決する
- session end -> due -> archive success / failure retry
- restart 後に期限超過 channel を sweep する
- Sessions Canvas の分類・描画・debounce/recreate
- stop で timer/listener を解放する
- 既存 Discord tests と Slack slash/delegation/reaction behavior が退行しない

検証コマンド:

```bash
npm run lint
npm test -- --reporter=dot
npm run build
npm run depcruise
```

サービスを起動・再起動する live test はこの worktree から行わない。
必要になった場合は作業を止め、Concordia testing claim を取得してから Excubitor 経由で
`E:/Document/Ars/Concordia` 本体だけを起動する。unit/lint/build は worktree で実行してよい。

## 10. 受け入れ条件

- [ ] Slack session routing が `thread_ts` に依存しない。
- [ ] 1 active session に public Bot-only channel が1つだけ作られる。
- [ ] 人間を自動 invite しない。
- [ ] mapped channel のトップレベル投稿だけが session inject される。
- [ ] Hub Canvas から active / waiting / recent / failed channel を辿れる。
- [ ] session end 後に設定した猶予で archive され、失敗時は再試行される。
- [ ] 必須 scope 不足を fail-visible にし、旧 thread 方式へ自動退避しない。
- [ ] migration は冪等、旧 thread table は保持される。
- [ ] Slack setup/spec と `spec-index.jsonl` が更新される。
- [ ] lint / full test / build / depcruise が green。
- [ ] `feat/slack-session-channels` から1 PRを作り、PR本文に検証結果と live test 未実施理由を記載する。

## 11. ブランチとDelegation条件

- worktree: `E:/Document/Ars/.wt-Concordia-slack-session-channels`
- branch: `feat/slack-session-channels`
- branch は最新 `origin/main` から作成済み。別 branch / worktree を作らない。
- この設計ファイル自体を含む既存 commit は保持し、その上へ実装 commit を積む。
- 隣接タスクを実装しない。
- model は GPT 系。reasoning effort は `auto` とし、Cc の成長型選択に委ねる。
- Codex fast mode は起動環境の `service_tier=fast` を使用する。
- PRは1件、squash merge可能にする。レビュー・merge・worktree削除は委託runでは行わない。
