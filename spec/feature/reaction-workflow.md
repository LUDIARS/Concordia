# Reaction Workflow — リアクション駆動の処理ディスパッチ

Concordia の chat メッセージ (Discord / Slack にミラーされた bot 投稿) に付けられた**リアクション**を
「指示」として解釈し、 種類に応じた処理を **LLM (headless `claude -p`) / session.inject** で実行する。

リアクションの**記録**は従来通り `chat_message_reactions` に残る (discord-repo.classifyEmoji →
fine/bad/raw)。 本機能はそれと**独立**に、 リアクションを処理トリガに変換する層を足す。

ランナー本体 `src/platform/reaction-workflow.ts` は **platform 非依存**（`{chatId, emoji, userId}`
だけ受ける）。Discord / Slack の各 bot が「reaction イベント → chat_messages.id 逆引き →
絵文字を unicode に正規化」してこのランナーに渡す（§4）。

## 1. 絵文字 → アクション写像

`src/platform/reaction-workflow.ts` の `classifyReactionWorkflow(emoji)`（unicode 文字で照合）。

| 絵文字 | 意味 | WorkflowAction | 実行手段 | model |
|---|---|---|---|---|
| 👍 / 🆗 | 良い → そのまま実装着手 | `start-impl` | authoring session へ `session.inject`<br>(非 active なら headless で着手) | — |
| 🙏 | 残作業を洗い出して報告 (🫡 と対) | `enumerate-remaining` | authoring session へ `session.inject`<br>(非 active なら headless で洗い出し) | sonnet |
| 🫡 | 残作業 (洗い出し結果) を**重複回避で** Memoria に登録 (memoria-record) | `memoria-remaining` | headless (cwd = Memoria) | sonnet |
| 📲 🆙 👆 | 状況どう? → 現在の作業状況を報告 | `status-check` | authoring session へ `session.inject`<br>(非 active なら headless) | sonnet |
| 😄 😀 😃 😊 🙂 😁 | 良い動き | `repo-memory-good` | headless (cwd = 当該リポ) | haiku |
| 👀 👁️ 👈 📓 ✏️ | メッセージをメモに残す | `memoria-note` | headless (cwd = Memoria) | haiku |
| 📝 🗒️ / ✅ ☑️ ✔️ | 残作業 → タスク登録 | `memoria-task` | headless (cwd = Memoria) | sonnet |
| 😡 💢 👿 😠 / 👎 | 良くない → **作業を即中断して反省** (記録はせず、 後続 👍 が来たら記録) | `repo-memory-bad` | active へ `session.inject`<br>(非 active は headless で反省のみ) | haiku |
| ⏭️ 📤 🗂️ | 実装タスクを積んで **別セッションへ委ねる** → Memoria に「別セッション対応」タスク登録 | `defer-impl` | headless (cwd = Memoria) | sonnet |
| 🙄 | **Enter 強制送信** (Lictor が送信を取りこぼした時の救済) | `force-enter` | active へ `session.inject` (`\n` のみ)<br>(非 active はスキップ) | — |
| 🤝 🫱 | タスクあり → delegation template を選んで **委託実行**、委託後の Lictor プロセスを監視 | `delegate-task` | active へ `session.inject` (委託+監視)<br>(非 active は headless haiku で委託のみ) | haiku |

写像外の絵文字は記録のみで何もしない (`null`)。

各アクション (カスタムコマンド) のヘルプは `WORKFLOW_ACTION_HELP` (label / summary / mode) として
持ち、 `GET /v1/admin/reaction-mappings` の `action_help` で配信 → 設定ページ「リアクションWF」の
「コマンドヘルプ」に表示する。 summary は「**投稿内容を <どんな指示> に変換して渡す**」という形で統一。

> 投稿内容の変換: どのアクションも、 トリガとなった投稿内容を action 固有の指示に変換して
> claude に渡す。 headless は `head` に本文を埋め込み、 inject も `msgRef` (対象メッセージ) を
> 付けて必ず投稿内容を渡す (対象セッションが文脈を持っていても「どの発言への指示か」を明示)。

`🙏 → 🫡` は「残作業洗い出し → Memoria 記録」の 2 段リアクションワークフロー。 まず 🙏 で
セッションに残作業を洗い出させ、 その洗い出し結果メッセージに 🫡 を付けると Memoria へ記録する。
🫡 の記録は **memoria-record** フロー (既存タスクと重複チェックしてから登録) で行う。 この「中身」は
環境依存のスラッシュコマンドに頼らず Concordia が `planWorkflow` 内に自前で保持する。

### 1-b. 単発絵文字 (prompt) も同じトリガにする

リアクションだけでなく、**チャットに単発で投稿された同種の絵文字**も同じワークフローに流す
(`src/discord/ingress.ts`)。 メッセージ本文が写像対象の絵文字 1 個だけなら、 inject / chat には
載せず「直前メッセージへのリアクション」と同義に扱う。

> **却下ルール**: 「絵文字のみで構成された単発投稿」だが**写像対象のアクションが無い**場合は、
> その投稿を却下し、 通常経路 (inject / chat) にもフォールバックしない (= プロンプトを通さない)。
> 絵文字判定は `isStandaloneEmoji` (Extended_Pictographic / Emoji_Modifier / VS16 / ZWJ のみ)。

対象メッセージの解決順:

1. 返信メッセージ (`message.reference`) なら参照先 → `discord_message_map` で `chat_messages.id`。
2. session channel なら、 そのセッションが書いた直近メッセージ (`chatRepo.latestForSession`)。
3. meta channel (chitchat / consultation / 報告 / system) なら、 その channel の直近メッセージ。

解決できなければ通常経路 (inject / chat) にフォールバック。 安全弁 OFF の間は handle() が即 return
するので単発絵文字も無処理 (= 通常の inject 扱い)。

**Slack も同様** (`src/slack/bot.ts` の message ingress)。 `:name:` 形式は `slackReactionToUnicode`
で unicode 正規化してから写像照合する。 対象メッセージは ① thread 返信ならその session の直近
(`chatRepo.latestForSession`) / ② チャンネル直下なら consultation メタチャットの直近、 で解決する。
**却下ルールも Discord と同じ**: 単発絵文字 (unicode の `isStandaloneEmoji` または `:name:` トークン)
で写像対象アクションが無いものは却下し、 inject / chat に通さない。`isStandaloneEmoji` は両 ingress 共用。

> 注: `ok` は 🆗 (U+1F197)、 `check` は ✅ (U+2705) と区別する。 `classifyEmoji` (記録用) では
> ✅/👍 は `fine`、 👎 は `bad` に潰れるが、 ワークフロールータは別系統で細かく分岐する。

## 2. 実行手段

### headless claude (`claude -p`)
`src/rules/claude-runner.ts` の `runClaude(prompt, opts)` を拡張して使う。
- `--model <haiku|sonnet>` で LLM を選ぶ (env `CONCORDIA_REACTION_MODEL_HAIKU/SONNET` で別名上書き可)。
- `cwd` で作業ディレクトリ (リポ / Memoria) を指定。
- `--dangerously-skip-permissions` 付き — `-p` は非対話で権限プロンプトを出せないため、
  file 書き込み / Memoria 連携 (relay 等) を**実際に実行**させるのに必要。
- prompt は stdin 渡し (Windows ENAMETOOLONG 回避)、 Windows は `CLAUDE_CODE_GIT_BASH_PATH` 自動補完。

起動された claude が「メッセージの解析 + 記録/タスク登録/着手」を 1 ショットで完結する。
Concordia 自身は LLM を呼ばず、 Memoria への到達も起動先 claude (cwd=Memoria) に委ねる
(= `gemma4-12 -p` 的な投げ方)。

### session.inject
`start-impl` で authoring session が active なら、 その session の AI に `session.inject` イベントで
「直前の提案をそのまま実装着手」を流し込む (Lictor が TUI に注入)。 文脈を持つ本人に続行させる。

## 3. フロー

```
MessageReactionAdd (discord.js)
  └─ handleReactionAdd (reactions.ts)
       ├─ chat_message_reactions に記録 (従来通り)
       └─ workflow.handle({chatId, emoji, userId})   ← fire-and-forget
            ├─ classifyReactionWorkflow(emoji) → action (null なら終了)
            ├─ dedup (同 chatId|emoji|userId は 5 分以内スキップ)
            ├─ chat_messages から本文 / session_id を引く
            ├─ session から repo_path / active を引く
            ├─ planWorkflow(action, ctx) → {mode, model, cwd, prompt}
            ├─ onAccept(action)  ← 発火確定の即時フック (slow 処理の前)
            └─ mode=inject ? eventBus.emit(session.inject) : runClaude(prompt, opts)
```

### 3-b. 発火の可視化 — 「受付」リプライ

リアクションWF は発火しても結果が見えづらい (inject はセッション側、 headless は 1〜2 分かかる)。
そこで `handle(input, onAccept?)` に **発火確定フック** `onAccept(action)` を足し、 各 platform が
**トリガー元メッセージへ「受付」リプライ**を返す (発生の可視化)。

- 文言は共通ヘルパー `reactionAckText(action, emoji)` = 「`<emoji> <WORKFLOW_ACTION_HELP[action].label>`を受け付けました」。
  例: 🙏 → 「🙏 残作業の洗い出しを受け付けました」。
- `onAccept` は dedup 通過後・slow な inject/headless の**前**に一度だけ呼ばれるので、 通知は即時。
  dedup skip / 無効 / 写像外では呼ばれない (= 余計な通知を出さない)。
- 投稿は best-effort (失敗してもログのみ、 WF 本体は止めない)。 真の ephemeral は interaction 専用で
  リアクションには使えないため、 通常リプライ (`repliedUser: false` で pingしない) とする。
- 全トリガー経路で出す: Discord リアクション (`reactions.ts`) / Discord 単発絵文字 (`ingress.ts`) /
  Slack リアクション・単発絵文字 (`slack/bot.ts`、 `chat.postMessage` の thread 返信)。

## 4. 安全弁 / 設定

| env | 既定 | 意味 |
|---|---|---|
| `CONCORDIA_REACTION_WORKFLOW` | `0` (OFF) | `1` で実処理を起動。 OFF の間は記録のみ。 |
| `CONCORDIA_REACTION_MODEL_HAIKU` | `haiku` | memoria-note / repo-memory に使うモデル別名。 |
| `CONCORDIA_REACTION_MODEL_SONNET` | `sonnet` | memoria-task / enumerate-remaining / memoria-remaining / status-check に使うモデル別名。 |
| `CONCORDIA_CLAUDE_TIMEOUT_MS` | `120000` | headless 1 回の timeout。 |

error-autofix と同じく既定 OFF。 dedup + fire-and-forget で記録経路を壊さない。

**安全弁・写像は設定 GUI から編集可 (再起動なしで反映)**:
- 安全弁 ON/OFF は AdminState (`schema_meta`) に永続化され、 runner が handle() ごとに live 評価する。
  `GET/PUT /v1/admin/reaction-workflow` / 設定ページ「リアクションWF」。 env はあくまで初期既定。
- 絵文字→アクション写像はユーザが追加・上書きできる (既定は組み込み構成)。
  `GET /v1/admin/reaction-mappings` (defaults + overrides + actions)、 `PUT` (emoji/action upsert)、
  `DELETE /v1/admin/reaction-mappings/:emoji` (上書き解除)。 上書きは `classifyReactionWorkflow` で
  既定より優先される。

`workspaceRoots` (Memoria 解決の基点、 複数可) と `github_org` は設定 GUI (Rules ページ / `/v1/admin/*`)
からも編集できる。 AdminState (`schema_meta` 永続化) が source of truth で、 未設定なら config
(`CONCORDIA_WORKSPACE_ROOT` / `CONCORDIA_WORKSPACE_ROOTS` / `CONCORDIA_GITHUB_ORG`) 既定にフォールバック。
複数ルートを設定した場合、 Memoria は実在する `<root>/Memoria` を採用する (先頭ルートを優先)。 変更は次の
Discord/Slack bot start (= restart) で実効値に反映される。 詳細は `spec/setup/config-reference.md`。

## 4-b. platform 別 ingress（chat 逆引き + 絵文字正規化）

ランナーは `{chatId, emoji, userId}` だけ受ける。各 platform が以下を担う。

| | Discord | Slack |
|---|---|---|
| reaction イベント | `messageReactionAdd` (discord.js) | `reaction_added` (Socket Mode) |
| msg → chat 逆引き | `discord_message_map` (egress で put) | `slack_message_map` (egress で put、`(channel_id, ts)` → `chat_messages.id`) |
| 絵文字 → unicode | discord.js は unicode 文字をそのまま渡す | Slack は**絵文字名**(`+1` / `thumbsup` / `white_check_mark` 等)。`slackReactionToUnicode()` で写像してからランナーへ。skin-tone 接尾 (`::skin-tone-N`) は除去 |
| bot 自身の除外 | `user.bot` | `event.user === botUserId` |

逆引きできない (= Concordia 投稿でない) リアクション、写像外の絵文字は無処理。

## 5. 実装ファイル

- `src/platform/reaction-workflow.ts` — 写像 + planWorkflow (純粋) + `ReactionWorkflowRunner`（platform 非依存）+ `reactionAckText()` (受付文言) + `handle(input, onAccept?)` の発火確定フック。
- `src/rules/claude-runner.ts` — `runClaude(prompt, opts)` に model/cwd/権限/timeout を追加。
- `src/discord/reactions.ts` / `src/discord/bot.ts` — Discord 側 ingress（記録後に `workflow.handle()`）。
- `src/discord/ingress.ts` / `src/slack/bot.ts` — 単発絵文字メッセージ → `workflow.handle()`（対象 chat_messages 解決込み）。
- `src/db/chat-repo.ts` — `latestForSession(sessionId)`（単発絵文字の対象解決に使う）。
- `src/slack/bot.ts` — Slack 側 ingress（`reaction_added` → `slackReactionToUnicode` → `workflow.handle()`）。
- `src/slack/message-map-repo.ts` — `slack_message_map` の put / findChatId。
- `src/slack/render.ts` — `slackReactionToUnicode()`（絵文字名 → unicode）。
- `src/server.ts` — `workspaceRoot` / `reactionWorkflowEnabled` を Discord/Slack 双方の deps に渡す。
- `src/platform/reaction-workflow.test.ts` — 写像 / plan の単体テスト。

## 6. 既知の制約 / TODO

- start-impl の headless fallback (非 active session) は自律実装になるため重い。 安全弁 ON 前提。
- Memoria への記録は起動先 claude の判断 (Memoria の skill / relay 経路) に依存する。
  Concordia から叩く専用エンドポイントは持たない (Memoria 書込は relay-only の方針に整合)。
- 「リポの作業メモリ」の場所は起動先 claude が当該リポの慣習を見て決める (パスを固定しない)。
