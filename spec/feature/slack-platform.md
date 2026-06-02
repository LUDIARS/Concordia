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

## v0.1 の非対象（フォローアップ）
- slash コマンド（spawn/stat/end/skill/prs）: Slack の slash は app 設定 + request
  URL or Socket Mode commands が要るため次段。当面 spawn/stat 等は Discord / Web から。
- per-session チャンネル自動作成 / cost・monitor・pr-queue・status-card 等の
  ダッシュボード: Discord 固有の付加価値として Slack 未実装。
- 回答済みボタンの「ローカル回答時」自動失効（Discord と共通の既知エッジ）。

## テスト
純粋ロジック（`render` / `types` / `session-threads-repo`）を単体テスト（17 ケース）。
Socket Mode の live 接続は薄い shell に隔離し、best-effort（接続失敗で本体運用に
影響しない）。
