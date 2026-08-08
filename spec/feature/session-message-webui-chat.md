---
type: feature
title: "Session message layer — later phases (WebUI chat, Lictor capture, delegation links)"
description: "Design for the phases that build on the session message layer: the Discord-style WebUI work chat with Web Push, the log-inspection view, Lictor-side event capture fixes, and bidirectional delegation links."
service: concordia
domain: session-message-layer
owner: Concordia
tags:
  - session-coordination
  - webui
  - web-push
  - discord
status: partially-implemented
related:
  - ./session-message-layer.md
updated: 2026-08-08
---

# セッションメッセージ層 — 後続フェーズ設計

`spec/feature/session-message-layer.md` が第 1 フェーズ (D1: `session_messages` の
永続化・projector・REST/WS) の実装契約を定める。本書はその上に載る後続フェーズ
(D3–D6) の設計を持つ。タスク定義は `spec/tasks/2026-08-07-session-message-layer-d*.md`。

## 進捗

| 節 | 対応タスク | 状態 |
|---|---|---|
| §1 WebUI | D4 (チャット) / D5 (ログ確認) | 未実装 |
| §2 イベント取得の修正 | — | **実装済み** (Lictor #284 でマージ・build 済み) |
| §3 Delegation の双方向リンク | D3 | 未実装 |
| §4 互換と移行 | D6 | 未実装 |

## 1. WebUI

### 1.1 ルーティング (確定)

| パス | 役割 |
|---|---|
| `/sessions` | セッション一覧のみ (モバイルの入口) |
| `/sessions/:id` | **作業チャット** (既定) |
| `/sessions/:id/logs` | **ログ確認** — raw transcript / event log / stat / fork |

### 1.2 チャット画面 (Discord 型)

- **PC**: 左カラム = セッションリスト (プロジェクトコード / 状態ドット / 未読バッジ /
  最終発言プレビュー)、右カラム = メッセージ + 下部固定の入力欄。
- **モバイル**: 左カラムは非表示。ヘッダ左のメニューボタンでドロワー表示 (Discord と同じ)。
- **状態カード**: PC / モバイルとも**右上のボタン**。既定は非表示、押した時だけ
  オーバーレイ表示 (現在の repo / branch / task / stat / cost / active repos)。
- **入力欄は下部固定**。Enter=送信 / Shift+Enter=改行 (既存 InjectForm 準拠)。
- **セッション停止はチャット本文のコマンド**で行う。`/stop` `/rename <text>` `/enter`
  `/stat` を本文パーサで解釈し、対応する API を叩く。未知の `/xxx` は
  そのまま inject せず「未知のコマンド」を返す (誤爆防止)。停止は確認ダイアログを 1 枚挟む。
- **メッセージ描画**は `author_type` ごと:
  - `thinking` は既定折りたたみ (`▶ 思考 …`)、クリックで展開
  - `task` は Task カード (実行中はスピナー、完了で結果要約に更新)
  - `delegation` は親子リンクチップ (クリックで相手セッションへ遷移)
  - `question` / `permission` はボタン付き (既存モーダルの処理を再利用)

### 1.3 ログ確認画面

現行 `SessionDetail` の raw 系をここへ集約する: transcript 全フレーム、event log、
最新 stat、fork ボタン、permission 履歴。チャットとは相互リンク。

### 1.4 通知 (Web Push・確定)

- `web/public/sw.js` (Service Worker) を追加。`push` イベントで `showNotification`、
  `notificationclick` で該当セッションのチャットを開く。
- VAPID 鍵は Cc 起動時に無ければ生成し、config (`concordia.config.json` と同じ置き場) に保存。
  公開鍵は `/v1/push/vapid-public-key` で配る。
- サーバ側は `web-push` パッケージで送信。送信対象イベント:
  - 自分が開いていないセッションの `assistant` / `question` / `permission` メッセージ
  - セッション終了・失敗
  - `thinking` / `tool` は通知しない
- 送信失敗 (410/404) は購読を削除。連続失敗 `fail_count >= 5` で無効化。
- 通知はまとめる: 同一セッションは 1 通知に集約 (`tag = session:<id>`、`renotify`)。
- **資格情報の扱い**: VAPID 秘密鍵と購読値 (`endpoint` / `p256dh` / `auth`) は資格情報である。
  ローカル DB または untracked なローカル設定にのみ保存し、REST/WS 応答・イベント・
  transcript・ログへ出力しない。API が露出してよいのは VAPID 公開鍵だけ。
- 未読は**ブラウザごと**に持つ。`client_id` (ブラウザが 1 度だけ生成して local storage に
  保持する UUID。利用者の識別子ではない) を購読・既読・WS 接続に渡し、既読位置は
  D1 の `session_message_reads` に `client_id` 単位で保存する。

## 2. イベント取得の修正 (Lictor)

### 2.1 `lineToFrame` の構造バグ

`Lictor/src/transcript-tail.ts` の `lineToFrame` は message content 配列を回して
**最初にマッチした 1 ブロックで return** している。結果:

- `[thinking, text]` → thinking だけ返り **assistant 本文が消える**
- `[text, tool_use]` → text だけ返り **Task 起動 (tool_use) が消える**
- thinking は 400 字で切られる

**修正**: `lineToFrames(line: string): Frame[]` に変え、content 配列の
**全ブロックを順に frame 化**する。`lineToFrame` は互換のため
`lineToFrames(line)[0] ?? null` として残してよい。

- seq は呼び出し側 (poll ループ / `transcriptSink`) が 1 frame ごとに採番する。
  1 行から複数 frame が出ても seq は連番で単調増加すること。
- thinking の切り詰めは 400 → 4000 字。
- `readRecentFromFile` も複数 frame 化に追従する。

### 2.2 Task イベント

- **Claude**: `tool_use` の `name === "Task"` を Task として扱えるよう、frame payload に
  `tool_use_id` と `input` の必要フィールド (`subagent_type` / `description` /
  `prompt` 先頭 200 字) を載せる。現状 `input_preview` は 200 字の JSON 文字列で
  構造が失われているため、`input_preview` は残しつつ
  `task: {subagent_type, description, prompt_head}` を追加する。
- `tool-result` frame に `tool_use_id` は既にある。Task の完了判定はこれで行う。
- **Codex**: 現在 `raw` に落ちている `event_msg` の
  `task_started` / `task_complete` / `exec_command_begin` / `exec_command_end` を
  frame 化する (`kind: "task"` / `kind: "tool-use"` / `kind: "tool-result"`)。

### 2.3 thinking の配送 (確定)

Discord にも **既定で出す**。`src/discord/egress-frame-filter.ts` の
`isRelayCandidateFrame` に `thinking` を追加し、`egress.ts` は thinking を
引用ブロック (`-# ` または `> `) で投稿する。設定で off にできること
(`message_optimization` が ON のときは従来どおり落とす)。

## 3. Delegation の双方向リンク

現状 `delegation.mirror` は**親セッションにしか出ない**。

- run 生成時 (`child_session_id` が確定した時点) に、**子セッションにも**
  「親: `<session>` / run: `<run_id>`」のリンクメッセージを投稿する
  (`author_type=delegation`, `dedupe_key=delegation:<run_id>:child`)。
- 親側にも同様に「子: `<session>`」を投稿する
  (`dedupe_key=delegation:<run_id>:parent`)。
- `metadata` に `run_id` / `parent_session_id` / `child_session_id` を入れる。
- WebUI は チャットヘッダに「親 [Cc] xxxxxxx」「子 3」チップを出し、クリックで
  相手セッションのチャットへ遷移する。一覧 (左カラム) では子セッションを親の下に
  インデント表示する。
- Discord も同じリンクを子チャンネルへ投稿する。

これは TaskWorkflow / TestWorkflow から張られる委託にもそのまま適用される。

## 4. 互換と移行

- `transcript_logs` / `transcript.frame` は**残す**。ログ確認画面と既存の
  cost 集計 (`listUsagePayloads`) がこれに依存している。
- Discord egress の `session_messages` への切替は最後 (D6)。切替まで Discord は
  現行経路のまま動く。切替時は `session_message_delivery` に外部 ID を記録し、
  Task カードの `op=update` を Discord の message edit にマップする。
- 既存セッションの過去メッセージは移行しない (`transcript_logs` から遡及生成しない)。
  新規メッセージから積む。ログ確認画面で過去は読める。
