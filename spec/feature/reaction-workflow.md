# Reaction Workflow — リアクション駆動の処理ディスパッチ

Concordia の chat メッセージ (Discord にミラーされた bot 投稿) に付けられた**リアクション**を
「指示」として解釈し、 種類に応じた処理を **LLM (headless `claude -p`) / session.inject** で実行する。

リアクションの**記録**は従来通り `chat_message_reactions` に残る (discord-repo.classifyEmoji →
fine/bad/raw)。 本機能はそれと**独立**に、 リアクションを処理トリガに変換する層を足す。

## 1. 絵文字 → アクション写像

`src/discord/reaction-workflow.ts` の `classifyReactionWorkflow(emoji)`。

| 絵文字 | 意味 | WorkflowAction | 実行手段 | model |
|---|---|---|---|---|
| 👍 / 🆗 | 良い → そのまま実装着手 | `start-impl` | authoring session へ `session.inject`<br>(非 active なら headless で着手) | — |
| 😄 😀 😃 😊 🙂 😁 | 良い動き | `repo-memory-good` | headless (cwd = 当該リポ) | haiku |
| 👀 👁️ | 気になる結果 | `memoria-note` | headless (cwd = Memoria) | haiku |
| 📝 📓 🗒️ ✏️ / ✅ ☑️ ✔️ | 残作業 | `memoria-task` | headless (cwd = Memoria) | sonnet |
| 😡 💢 👿 😠 / 👎 | 良くない | `repo-memory-bad` | headless (cwd = 当該リポ) | haiku |

写像外の絵文字は記録のみで何もしない (`null`)。

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
(= `gamma -p` 的な投げ方)。

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
            └─ mode=inject ? eventBus.emit(session.inject) : runClaude(prompt, opts)
```

## 4. 安全弁 / 設定

| env | 既定 | 意味 |
|---|---|---|
| `CONCORDIA_REACTION_WORKFLOW` | `0` (OFF) | `1` で実処理を起動。 OFF の間は記録のみ。 |
| `CONCORDIA_REACTION_MODEL_HAIKU` | `haiku` | memoria-note / repo-memory に使うモデル別名。 |
| `CONCORDIA_REACTION_MODEL_SONNET` | `sonnet` | memoria-task に使うモデル別名。 |
| `CONCORDIA_CLAUDE_TIMEOUT_MS` | `120000` | headless 1 回の timeout。 |

error-autofix と同じく既定 OFF。 dedup + fire-and-forget で記録経路を壊さない。

## 5. 実装ファイル

- `src/discord/reaction-workflow.ts` — 写像 + planWorkflow (純粋) + `ReactionWorkflowRunner`。
- `src/rules/claude-runner.ts` — `runClaude(prompt, opts)` に model/cwd/権限/timeout を追加。
- `src/discord/reactions.ts` — 記録後に `workflow.handle()` を呼ぶ (任意注入)。
- `src/discord/bot.ts` — `reactionWorkflowEnabled` のとき runner を構築して注入。
- `src/server.ts` — `workspaceRoot` / `reactionWorkflowEnabled` を deps に渡す。
- `src/discord/reaction-workflow.test.ts` — 写像 / plan の単体テスト。

## 6. 既知の制約 / TODO

- start-impl の headless fallback (非 active session) は自律実装になるため重い。 安全弁 ON 前提。
- Memoria への記録は起動先 claude の判断 (Memoria の skill / relay 経路) に依存する。
  Concordia から叩く専用エンドポイントは持たない (Memoria 書込は relay-only の方針に整合)。
- 「リポの作業メモリ」の場所は起動先 claude が当該リポの慣習を見て決める (パスを固定しない)。
