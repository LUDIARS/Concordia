# Slack platform（Discord と並ぶ ChatPlatform / v0.1）

## 目的
Concordia を Discord だけでなく Slack でも「運用」できるようにする。運用の中核
＝**セッション出力の監視 / スレッド返信での inject / 質問へのボタン回答**。

## 抽象（[`../../src/platform/chat-platform.ts`](../../src/platform/chat-platform.ts)）
`ChatPlatform` は「Concordia を運用できるチャット基盤」の共通契約（name / stop）。
abstraction の本体は既に platform 非依存な 2 つ:
- **出力の共通源** = `eventBus`（複数購読対応）
- **入力の共通宛先** = Concordia HTTP API（`/v1/sessions/:id/inject` `/v1/chat`
  `/v1/sessions/:id/answer-question`）

Discord (`src/discord/bot.ts`) と Slack (`src/slack/bot.ts`) はこの契約を満たす
coequal な実装で、どちらも eventBus を独立に購読する。server.ts が両者を対称に
起動/停止する（`CONCORDIA_DISCORD_ENABLED` / `CONCORDIA_SLACK_ENABLED`）。

## 接続方式: Socket Mode
Concordia は loopback-only（17330）で inbound URL を持てないため、Events API では
なく **Socket Mode**（outbound WebSocket）で接続する。必要 token:
- `CONCORDIA_SLACK_BOT_TOKEN`（xoxb-, Web API）
- `CONCORDIA_SLACK_APP_TOKEN`（xapp-, Socket Mode, `connections:write`）
- `CONCORDIA_SLACK_CHANNEL_ID`（運用チャンネル C…）

必要スコープ（目安）: `chat:write` `channels:history`（or groups）`channels:read`。
Socket Mode + Interactivity + Event Subscriptions（`message.channels`）を ON。

## 多重化: thread-per-session（v0.1）
per-session チャンネルは作らず、設定した 1 チャンネル内で session ごとに thread を
切る。マッピングは `slack_session_threads`（[`../../src/slack/session-threads-repo.ts`](../../src/slack/session-threads-repo.ts)、
schema.ts が table の正本）。

- **egress**: `chat.posted` / `transcript.frame`（中継条件は Discord egress と同義＝
  assistant text / summary のみ、guardian JSON は drop）を、その session の thread に
  投稿。thread が無ければ root メッセージを 1 つ立てて作る（in-flight ロックで二重
  作成を防止）。session 非紐付けの chat はチャンネル直下へ。
- **ingress**: thread への返信 = その session への inject。チャンネル直下の発言 =
  `consultation` メタチャットへ。bot 自身の投稿・編集・subtype 付きは無視。
- **question**: `question.posted` を Block Kit ボタンで thread に投稿。`action_id` は
  `cc_answer:<questionId>:<index>`。クリック → `/v1/sessions/:id/answer-question`
  → 回答済み表示に update（ボタン除去）。

## 自己ループ防止
Slack ingress 由来の chat は `metadata.source="slack"` を刻む。egress はこれを見て
Slack 由来 chat を Slack に再投稿しない（Discord egress の `source="discord"` と同型）。

## v0.2 追加（2026-06-02）
- **作業中インジケータ**: session thread の最下部に「🔄 作業中…」を出し、進捗で消して
  落ち着いたら出し直し、idle で除去。Discord と同じ platform 非依存コントローラ
  ([`../../src/platform/working-indicator.ts`](../../src/platform/working-indicator.ts)) を
  流用し post/remove を Slack thread 用に差すだけ。idle は `CONCORDIA_SLACK_WORKING_IDLE_SEC`（既定60s）。
- **slash コマンド（読み取り系）**: Socket Mode の `slash_commands` で `/concordia stat|prs|help`
  ([`../../src/slack/slash.ts`](../../src/slack/slash.ts))。Slack app の Slash Commands に
  `/concordia` を 1 個登録（Socket Mode なので request URL 不要、`commands` scope）。応答は
  ephemeral。宛先は Discord コマンドと同じ Concordia HTTP（`/v1/stat`・`/v1/prs/digest`）。

## v0.3 追加（2026-06-02）
- **slash 副作用系**: `/concordia spawn <claude|codex> [cwd]`（→ `/v1/admin/spawn-session`）/
  `/concordia end <session_id 先頭8桁>`（`GET /v1/sessions?status=active` で先頭一致 1 件に解決 →
  `DELETE /v1/sessions/:id`、複数一致はより長い prefix を要求）。`skill` は Lictor sidecar の
  port proxy が要るため対象外（Discord 同様）。
- **質問ボタンのローカル失効**: `question_id → 投稿 ts` を in-memory 保持し、`question.answered` /
  `question.resolved`（ローカル回答 → Lictor 通知）受信時に `chat.update` でボタン除去。
  再起動で map が消えても Concordia 側 `markResolvedLocally` で再クリックは弾かれる。

## 非対象（設計上やらない / 必要時に別途）
- **per-session チャンネル自動作成**: thread-per-session で routing 要件は充足済。Slack に
  channel を乱立させると workspace を汚し `conversations.create`/招待スコープも要るため見送り。
- **cost / monitor / pr-queue / status-card ダッシュボード全移植**: Discord 固有の作り込み。
  Slack では `/concordia stat`・`/concordia prs`（slash）+ thread root で実用上代替できるため、
  Block Kit 定期更新の全移植はコスト大・価値中につき見送り（必要になれば monitor 1 枚から検討）。

## テスト
純粋ロジック（`render` / `types` / `slash` / `session-threads-repo` / `working-indicator`）を
単体テスト。Socket Mode の live 接続・Web API 呼び出しは薄い shell に隔離し、best-effort
（接続失敗で本体運用に影響しない）。
