---
type: feature
title: "Concordia Discord-UI PR-B — 実装指示 (codex 向け)"
description: "Concordia Discord-UI の PR-B として、スラッシュコマンド 9 個・AskUserQuestion の Button/Select ブリッジ・Embed 整形を codex 向けに仕様化した実装指示書。DB に discord_pending_questions テーブルを追加し、質問投稿→Discord ボタン回答→セッションフィードバックの一連フローを構築する。"
service: concordia
domain: chat-platforms
tags:
  - typescript
  - discord
  - sqlite
  - slash-command
  - webhook
  - embed
  - event-driven
  - spawn
status: planned
related:
  - discord-ui.md
updated: 2026-06-30
---


# Concordia Discord-UI PR-B — 実装指示 (codex 向け)

## 前提

PR-A (PR #50, branch `feat/discord-ui`) は bot 常駐 / session channel CRUD / chat egress / reaction 評価まで完成済。 [spec/discord-ui.md](discord-ui.md) を先に読むこと。

この PR-B は **同じ branch `feat/discord-ui` に積み増し** して 1 PR にまとめる。 codex は branch checkout 後 → 実装 → typecheck/test → commit して push まで一気通貫で進める。

## スコープ

- Slash command 9 個 + autocomplete + Modal
- Embed 化 (chat/transcript/report の rich 表現)
- AskUserQuestion → Discord Button/Select bridge (Concordia 側のみ、 Lictor 側は別 PR)

## 1. DB schema 追加 (1 table)

`src/db/schema.ts` の `STATEMENTS` 末尾 (chat_message_reactions の直後) に追記:

```sql
CREATE TABLE IF NOT EXISTS discord_pending_questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  question        TEXT NOT NULL,
  options_json    TEXT NOT NULL,            -- ["option1", "option2"] の JSON
  discord_message_id TEXT,                  -- button 付き Discord message id (post 後に set)
  answered_at     INTEGER,                  -- 回答済なら Unix sec
  answer_index    INTEGER,                  -- 押された button の index (0-based)
  answer_text     TEXT,                     -- 回答テキスト (= options[answer_index])
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discord_pending_questions_session
  ON discord_pending_questions(session_id, answered_at);
```

## 2. Repo 追加 (`src/db/discord-repo.ts` に追記)

```ts
export interface DiscordPendingQuestionRow {
  id: number;
  session_id: string;
  question: string;
  options_json: string;
  discord_message_id: string | null;
  answered_at: number | null;
  answer_index: number | null;
  answer_text: string | null;
  ts: number;
}

export interface DiscordPendingQuestionsRepo {
  insert(input: { session_id: string; question: string; options: string[] }): DiscordPendingQuestionRow;
  setDiscordMessageId(id: number, discordMessageId: string): void;
  markAnswered(id: number, answerIndex: number, answerText: string): void;
  findById(id: number): DiscordPendingQuestionRow | null;
  /** 未回答の最新 1 件 (button が押された時 / /answer のフォールバック用). */
  findLatestUnanswered(sessionId: string): DiscordPendingQuestionRow | null;
}

export function makeDiscordPendingQuestionsRepo(db: Database): DiscordPendingQuestionsRepo { ... }
```

## 3. Event 追加 (`src/events.ts`)

`ConcordiaEvent` union に追加:

```ts
| { type: "question.posted";   target_session_id: string; question_id: number; question: string; options: string[]; ts: number }
| { type: "question.answered"; target_session_id: string; question_id: number; answer_index: number; answer_text: string; ts: number }
```

## 4. API 追加 (`src/api/sessions.ts`)

既存の `app.post("/:id/inject", ...)` の近くに 2 endpoint 追加:

### `POST /v1/sessions/:id/pending-question`

Body schema:
```ts
{ question: string (1-2000), options: string[] (1-25 items, each 1-80 chars) }
```

動作:
1. session 存在チェック (404 if not found)
2. `repo.insert({ session_id, question, options })` で row 作成
3. `eventBus.emit({ type: "question.posted", target_session_id, question_id, question, options, ts })`
4. `appendEvent` (session_events) に kind="pending_question" で記録
5. Returns `{ ok: true, question_id, ts }`

### `POST /v1/sessions/:id/answer-question`

Body schema:
```ts
{ question_id: number, answer_index: number }
```

動作:
1. session 存在チェック
2. row 取得、 既に answered_at がセットされていたら 409 conflict
3. `options[answer_index]` を `answer_text` に
4. `repo.markAnswered(...)`
5. `eventBus.emit({ type: "question.answered", ... })`
6. Returns `{ ok: true, answer_text }`

(Lictor 側の AskUserQuestion 捕捉は別 PR。 Concordia 側はこの 2 endpoint を提供するところまで)

## 5. Slash command 実装 (`src/discord/commands/*.ts`)

各 file に builder + execute を default export する形式。 `src/discord/commands.ts` で集約。

### 共通 utility (`src/discord/commands/_util.ts`)

```ts
/** session channel での実行のみ許可。 違うなら ephemeral でエラー reply */
export async function requireSessionChannel(
  interaction: ChatInputCommandInteraction,
  sessionChannelsRepo: DiscordSessionChannelsRepo,
): Promise<{ sessionId: string; channelId: string } | null> { ... }

/** Loopback Concordia API を叩く. */
export async function callConcordia<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T | { error: string }> { ... }
```

### 9 個の command (まとめて指示)

| File | name | options | autocomplete | 動作 |
|---|---|---|---|---|
| `inject.ts` | `inject` | `text` (string, required, max 4000) | - | session channel 内のみ。 `POST /v1/sessions/:id/inject` で text 流入 |
| `spawn.ts` | `spawn` | `provider` (string choice: claude/codex/gemini), `cwd` (string, autocomplete), `no_cernere` (bool, optional) | cwd: 直近 30 日の `sessions.repo_path` distinct 上位 25 件 | spawn token を `.spawn.token` から読み、 `POST /v1/spawn` |
| `cc-skill.ts` | `cc-skill` | `name` (string, autocomplete) | Session の `repo_path` (= 現在の branch/worktree) 内 `.claude/.agents/.codex/skills` と Cc の `src/skills/*.md` を列挙 | session channel 内、 `POST /v1/sessions/:id/skill` で選択した branch 上の本文を Lictor へ注入 |
| `keys.ts` | `keys` | `seq` (string, max 200) | - | session channel 内、 Lictor `/v1/keys` proxy |
| `answer.ts` | `answer` | `choice` (integer 0-24) | - | 直近未回答の pending question を `POST /v1/sessions/:id/answer-question { question_id, answer_index }` |
| `stat.ts` | `stat` | (なし) | - | `GET /v1/stat` の JSON を embed で整形 (active sessions 一覧 + branch + last_event) |
| `chitchat.ts` | `chitchat` | `text` (string, max 2000) | - | `POST /v1/chat { channel: "chitchat", text, author_label: <discord user> }` |
| `consultation.ts` | `consultation` | `text` | - | 同上 channel=consultation |
| `end_session.ts` | `end-session` | (なし) | - | session channel 内のみ。 `DELETE /v1/sessions/:id`。 session-channel.ts の onSessionEnded が channel を archive へ移動 |

### Modal の使い所

`inject` は text が長文 (4000 文字) のことが多いので、 slash command 直で `text` を取らず、 **Modal を開いて** TextInputStyle.Paragraph で入力させるパターンも追加検討。 v1 では slash option string で十分。 Modal は 4000 文字制限がある (Discord API)。

実装方式:
- `/inject` を **option なし** で受け、 `interaction.showModal(builder)` で Modal を出す
- Modal の submit を `Events.InteractionCreate` 側の `interaction.isModalSubmit()` で受け取り、 値を pull して `/v1/sessions/:id/inject` に流す
- v1.0 は option を残しつつ、 option が無ければ Modal flow に分岐、 でも OK

codex は両対応で良い (option 指定があれば直接、 無ければ Modal)。

### `src/discord/commands.ts`

```ts
import { Routes, REST, SlashCommandBuilder } from "discord.js";
// 9 command を import
import injectCommand from "./commands/inject.js";
// ...

const COMMANDS = [injectCommand, spawnCommand, ...];

export async function registerGuildCommands(token: string, applicationId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const body = COMMANDS.map((c) => c.builder.toJSON());
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
}

export async function dispatchInteraction(interaction: Interaction, deps: { ... }): Promise<void> {
  if (interaction.isChatInputCommand()) {
    const cmd = COMMANDS.find((c) => c.builder.name === interaction.commandName);
    if (!cmd) return;
    await cmd.execute(interaction, deps);
  } else if (interaction.isAutocomplete()) {
    const cmd = COMMANDS.find((c) => c.builder.name === interaction.commandName);
    if (cmd?.autocomplete) await cmd.autocomplete(interaction, deps);
  } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
    // question.ts の handler に dispatch (custom_id で識別)
    await dispatchQuestionInteraction(interaction, deps);
  } else if (interaction.isModalSubmit()) {
    // inject modal 等の dispatch
    await dispatchModalSubmit(interaction, deps);
  }
}
```

### bot.ts の修正

`bot.ts` の ready 内で `await registerGuildCommands(token, c.application.id, env.guildId)`。
`client.on(Events.InteractionCreate, (i) => void dispatchInteraction(i, { ...deps }))`。

## 6. Button / Select bridge (`src/discord/question.ts`)

### question.posted 受信 → session channel に Button 付き embed 投稿

`bot.ts` の `routeEvent` で `question.posted` を捕捉:

```ts
if (ev.type === "question.posted") {
  void postQuestion({ ..., guild, sessionChannelsRepo, pendingQuestionsRepo, log }, ev);
  return;
}
```

`postQuestion`:
1. session channel を repo で解決
2. embed を builder で作成 (`title: "AskUserQuestion"`, `description: question`)
3. `ActionRowBuilder<ButtonBuilder>` で options.length 個の Button を組み立て。 `custom_id` は `q:<question_id>:<index>` 形式。 5 個超なら複数 ActionRow に分割 (Discord 上限 5 個/row、 5 row まで)
4. `channel.send({ embeds, components })` で投稿
5. 返ってきた `message.id` を `pendingQuestionsRepo.setDiscordMessageId(question_id, message.id)`

### Button 押下

`dispatchQuestionInteraction(interaction, deps)`:
1. `custom_id` を parse → `q:<question_id>:<index>`
2. `pendingQuestionsRepo.findById(question_id)` で row 取得 (既に answered なら "回答済" を ephemeral で返す)
3. `POST /v1/sessions/:id/answer-question` を loopback で叩く (= 実は直接 `markAnswered` + `eventBus.emit` でも OK だが、 API 経由が DRY)
4. interaction に `update({ components: [] })` で button を消す & embed footer に `回答: <answer_text> by @<user>` を追加
5. log

### Select Menu

options が 5 個超のとき (= ActionRow 5 個=25 button まで届くが UI 的に冗長) は **StringSelectMenu に切り替え**。 例: 25 を超えたら error、 6-25 は SelectMenu、 1-5 は Button。

実装の閾値: `options.length >= 6 → SelectMenuBuilder`、 `options.length <= 5 → ButtonBuilder`。

## 7. Embed 整形 (`src/discord/formatter.ts` に追加)

既存 `chunkForDiscord` の隣に embed builder ヘルパー追加:

```ts
import { EmbedBuilder } from "discord.js";

export function chatEmbed(input: {
  channel: string;          // 'chitchat' / 'consultation' / '報告' / 'system'
  text: string;
  authorName: string;
  ts: number;
}): EmbedBuilder { ... }

export function transcriptEmbed(input: {
  sessionId: string;
  text: string;
  authorName: string;
  kind: "text" | "thinking" | "summary";
  ts: number;
}): EmbedBuilder { ... }

export function statusEmbed(input: {
  sessionId: string;
  role: string | null;
  branch: string | null;
  lastEvent: { kind: string; ts: number } | null;
  conflicts: number;
}): EmbedBuilder { ... }

export function reportEmbed(input: {
  sessionId: string;
  summary: string;
  highlights: string[];
}): EmbedBuilder { ... }

export function questionEmbed(input: {
  question: string;
  options: string[];
  questionId: number;
}): EmbedBuilder { ... }
```

色は channel 別:
- chitchat: 0x7AA0FF
- consultation: 0xFFB347
- 報告: 0xFFD700
- system: 0x808080
- transcript: 0x5865F2 (Discord blurple)
- status active: 0x57F287 (green)
- status lost: 0xED4245 (red)
- question: 0xF1C40F (yellow)

### egress を embed 化

`egress.ts` の `handleChatPosted` / `handleTranscriptFrame` を、 chunked plain text 投稿から **embed 投稿** に切替える。 username/avatarURL は webhook send option で引き続き設定可。

注意: webhook の `embeds` 配列は 10 個まで、 1 embed の合計文字数は 6000 まで (description は 4096 まで)。 chunkForDiscord は description 用に 4000 で割る形に変える。

## 8. 削除しない原則の徹底

button interaction の `update()` は **編集** であって削除ではない。 OK。
失敗時の error reply は `interaction.reply({ ephemeral: true, content: "..." })` で本人のみに見せる (チャンネルにゴミ残らない)。

## 9. テスト追加

vitest で:

- `commands/inject.test.ts`: requireSessionChannel の通過/拒否
- `commands/spawn.test.ts`: spawn payload 構築
- `question.test.ts`: button custom_id の parse + 5 個まで Button / 6 個以上 SelectMenu の分岐
- `formatter.test.ts` に embed builder のスナップショット (color / field 数)
- `db/discord-repo.test.ts` に pending_questions repo のテスト追加 (insert / markAnswered / findLatestUnanswered)

discord.js 本体の Interaction は mock 困難なので、 純関数化できる範囲だけテスト。

## 10. spec/discord-ui.md 反映

実装が固まったら spec/discord-ui.md の「PR-B (続編)」 セクションを実装済セクションに移動し、 commands テーブルや button フロー図を追記。

## 11. Polls (Discord 2024 新機能) — 将来検討

Discord は 2024 に native poll を追加。 discord.js v14 では `Message.poll` + `channel.send({ poll: { question, answers, duration, allowMultiselect } })` で送れる。

**用途**: AI に方針投票 (例: 「この PR をマージする?」 を YES/NO ボタン的に)。 button bridge より UX 良い。

実装は本 PR スコープ外だが、 `question.posted` の options が 2-10 程度なら **Button より Poll の方が UX 良い** ケースがあるので、 将来 `pending_question` で `kind: 'poll' | 'buttons' | 'select'` を選べる拡張余地を残す (今は kind 列を追加せず、 後で ALTER で足す)。

## 12. branch / commit / PR

- branch: `feat/discord-ui` (既存、 PR #50)
- commit 単位: 自由だが「DB+repo」「commands」「question bridge」「embed」「tests」 等で分割推奨
- typecheck: `npm run lint`
- test: `npm test`
- push 後 PR #50 の body を更新 (新 commit list を反映)

## 13. Lictor 側 (本 PR の対象外)

AskUserQuestion 捕捉は **LUDIARS/Lictor の別 PR** で対応:
- AskUserQuestion tool 呼出を Lictor の event-reactor.ts で捕捉
- `POST /v1/sessions/:id/pending-question { question, options }` で Concordia に投げる
- Concordia から `question.answered` event を受けたら answer text を pty に inject (= 既存 `onInject` 経路)

Lictor 側仕様は別ファイル (`LUDIARS/Lictor/spec/askuserquestion-bridge.md`) で書く予定。 codex は **Concordia 側のみ実装**、 Lictor 側はスタブ (= テスト用に手動で `/v1/sessions/:id/pending-question` を curl で叩く程度) で動作確認する。

## 14. 環境

`CONCORDIA_DISCORD_ENABLED=1` + `_TOKEN` + `_GUILD_ID` + `_APPLICATION_ID` (slash command 登録に必要、 .env.example に追加)。 Application ID は Discord Developer Portal の Application 詳細にある。

## 完了基準

- [ ] DB schema + repo 追加 (5 fixture テストパス)
- [ ] `POST /pending-question` + `POST /answer-question` 動作 + 既存 sessions-api.test.ts に 4 ケース追加
- [ ] 9 slash command が test guild で reply を返す (手動確認 OK)
- [ ] Button 押下で `chat.posted` が出ない (silent answer)
- [ ] embed 整形で色 / footer / fields が想定通り
- [ ] npm test 全 pass + npm run lint clean
- [ ] PR #50 body 更新
