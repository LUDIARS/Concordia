---
spec: spec/feature/session-message-layer.md
repos:
  - E:/Document/Ars/Concordia
  - E:/Document/Ars/Lictor
status: delegating
created: 2026-08-07
---

# 実装タスク — セッションメッセージ層と WebUI チャット分割

設計正本: `spec/feature/session-message-layer.md` (同 worktree)

依存: **D1 / D2 は独立して先行**。D3・D4・D5 は D1 完了後。D6 は D1+D2 後。

---

## D1 — Cc: `session_messages` 基盤 (repo=Concordia)

1. `src/db/schema.ts` に `session_messages` / `session_message_delivery` /
   `session_message_reads` を追加 (spec §3.1 / §3.2 / §3.4 のとおり。列追加ではなく
   新規 CREATE TABLE)。
2. `src/db/session-messages-repo.ts`
   - `upsert(input)` — `UNIQUE(session_id, dedupe_key)` で create/update を判定。
     update は `edited_ts` を打つ。戻り値は行 (id 含む)。
   - `list(session_id, {before, after, limit})` — id カーソル。既定 50 / 上限 200。
   - `countAfter(session_id, id)` / `latest(session_id)`
   - `purgeOlderThan(cutoffTs)`
3. `src/db/session-message-reads-repo.ts`
   - `upsert(client_id, session_id, last_read_id)` — client/session ごとに既読位置を保存。
   - `get(client_id, session_id)` — 未読件数計算用の既読位置を返す。
4. `src/messages/project.ts` — 純関数 projector (spec §4 の対応表を全て実装)。
   DB も `Date.now()` も触らない。`ProjectContext` は `tool_use_id → dedupe_key` の
   セッションごと LRU (上限 200)。
5. `src/messages/service.ts` — eventBus 購読 → projector → repo → `session.message`
   イベント emit。起動時に直近の `task:` dedupe_key を読み込んで context を復元。
6. `src/events.ts` に `session.message` / `session.message.summary` を追加し、
   `src/shared/event-schema.ts` と `src/discord/projection.ts` の
   `eventSessionId` にも配線する。
7. `src/api/` に messages ルート (spec §5 の 3 本。`client_id` ごとの read state を
   `session_message_reads` に保存) を追加し、
   `register-*.ts` に登録。
8. 単体テスト: projector の対応表 (イベント種別ごと)、repo の upsert 冪等性、
   Task の create→update が同一行になること、client ごとの read state が独立すること。

**やらないこと**: Discord egress の切替 (D6)、WebUI (D4/D5)、Web Push (D4)。

---

## D2 — Li: frame 取りこぼしの修正と Task/thinking (repo=Lictor)

1. `src/transcript-tail.ts` の `lineToFrame` を `lineToFrames(line): Frame[]` にする。
   content 配列の**全ブロック**を順に frame 化 (spec §7.1)。
   `lineToFrame` は `lineToFrames(line)[0] ?? null` として互換のため残す。
2. poll ループと `readRecentFromFile` を複数 frame に追従させる。
   **seq は 1 frame ごとに採番**し、1 行から複数出ても連番・単調増加を保つこと。
   既存の Codex dedupe (`extractCodexAssistantDedupeKey`) は assistant text frame に
   対してのみ従来どおり効かせる。
3. thinking の切り詰めを 400 → 4000 字。
4. Task: `tool_use` frame の payload に `tool_use_id` と
   `task: {subagent_type, description, prompt_head}` を追加 (spec §7.2)。
   `input_preview` は互換のため残す。
5. Codex: `event_msg` の `task_started` / `task_complete` /
   `exec_command_begin` / `exec_command_end` を raw から昇格して frame 化。
6. テスト (`node:test` via tsx — vitest/jest は使わない):
   - `[thinking, text]` の 1 行から **2 frame** 出ること (本文が消えない)
   - `[text, tool_use]` の 1 行から 2 frame 出ること
   - Task の tool_use frame に `tool_use_id` と `task` が載ること
   - Codex `task_started` が raw にならないこと
   - 複数 frame でも seq が連番であること

**注意**: `dist` 実行のリポなので、マージ後に `npm run build` が必要 (PR 説明に明記)。

---

## D3 — Cc: Delegation 親子双方向リンク (repo=Concordia, 依存 D1)

1. `child_session_id` 確定時に**子セッションにも**親へのリンクメッセージを投稿する
   (spec §8)。既存は親側 mirror のみ。
2. 親側にも子リンクメッセージを投稿。`dedupe_key` は
   `delegation:<run_id>:parent` / `delegation:<run_id>:child`。
3. `metadata` に `run_id` / `parent_session_id` / `child_session_id` を入れる。
4. `GET /v1/sessions/:id/links` — そのセッションの親・子一覧を返す
   (`delegation_runs` を parent/child 両方向で引く)。
5. テスト: 親子双方に 1 通ずつ出ること、同じ run で二重投稿されないこと。

---

## D4 — Cc web: 作業チャット画面 + Web Push (repo=Concordia, 依存 D1)

1. `/sessions/:id` を**チャット**にする (spec §6.1)。既存の raw 表示は D5 が
   `/sessions/:id/logs` へ移すので、D4 では暫定的に残しておいてよい。
2. レイアウト: PC は 左カラム(セッションリスト) + 右カラム(メッセージ+下部固定入力)。
   モバイルはメニューボタン → ドロワー (spec §6.2)。
3. メッセージは `GET /v1/sessions/:id/messages` + WS `session.message` で描く。
   **`transcript.frame` から再構成しない**。
4. `author_type` ごとの描画 (thinking は既定折りたたみ、task はカード、
   delegation はリンクチップ、question/permission はボタン)。
5. 状態カードは右上ボタン → オーバーレイ (PC/モバイル共通)。既定非表示。
6. 本文コマンド: `/stop` (確認ダイアログ 1 枚) / `/rename <text>` / `/enter` / `/stat`。
   未知の `/xxx` は inject せずエラー表示。
7. Web Push (spec §6.4):
   - `web/public/sw.js` (push / notificationclick)
   - 購読 UI (設定 or チャットヘッダのベルボタン)。ブラウザで一度生成した `client_id`
     を購読・read API・WS 接続に渡す
   - Cc 側: VAPID 鍵の生成・保存、`web_push_subscriptions` テーブル、
     `web-push` で送信、410/404 で購読削除、`tag=session:<id>` で集約
   - VAPID private key と購読値は untracked local configuration / DB のみに保存し、
     API・WS・イベント・transcript・ログへ出力しない
8. 未読: `client_id` ごとの `last_read_id` をサーバ保存 + 左カラムにバッジ。

**SRP**: 1 ファイルに詰め込まない。最低限
`pages/session-chat/` 配下に `SessionList` / `MessageList` / `MessageItem` /
`ChatInput` / `StatusOverlay` / `commands.ts` / `push.ts` を分ける。

---

## D5 — Cc web: ログ確認画面へ再編 (repo=Concordia, 依存 D1)

1. `/sessions/:id/logs` を新設し、現行 `SessionDetail` の raw 系
   (transcript 全フレーム / event log / 最新 stat / fork / permission 履歴) を移す。
2. `/sessions` (一覧のみ) を追加。
3. チャットとログの相互リンク、Monitor からのリンク先を確認。
4. 移設で不要になったコード (旧 ConversationPanel 等) は**削除**する。
   リネームやコメントアウトで残さない。

---

## D6 — Cc: Discord egress を `session_messages` 経由へ (repo=Concordia, 依存 D1+D2)

1. `src/discord/egress.ts` の transcript.frame ハンドラを
   `session.message` 購読へ置き換える。
2. 送信結果の Discord message id を `session_message_delivery` に記録し、
   `op=update` のメッセージは **edit** で反映する (Task の完了など)。
3. `session.message` の `author_type=thinking` を既定で引用ブロックとして投稿し、
   `message_optimization` ON のときは落とす (spec §7.3)。切替後に使われない
   `egress-frame-filter.ts` でこの判断を実装しない。
4. 既存の dedupe (`shouldSkipCodexDuplicate`) は `dedupe_key` に一本化できるか
   確認し、できるなら置き換える。
5. 切替後、実セッションで Discord と WebUI の表示が一致することを確認する。

---

## 共通ルール (全委託)

- 対象リポの `CLAUDE.md` / `dev-process.md` / `/coding-conventions` に従う。
- **ローカル main 起点**で feat ブランチを切る (origin/main 起点にしない)。
- 1 タスク = 1 PR。他タスクの範囲に踏み込まない。
- 既存コードを「リネームして残す」のではなく、置き換えるべきものは削除する。
- 無言フォールバック禁止。設定不備・未接続は 4xx/5xx とログで表面化させる。
- 1 行圧縮コードを書かない。既存ファイルのスタイルに合わせる。
