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
updated: 2026-09-10
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

- 2026-09-10: Chat メニューは `status=ended` のセッションを除外し、終了イベントで即時更新する。
  一覧の未読取得も表示対象に限定する。終了履歴は削除せず、直接 URL から引き続き閲覧できる。
  `lost` 等は終了確定ではないため表示を維持する（CC-INV-01、CC-INV-04）。
- Chat ルートのみ画面を動的 viewport 高さに固定し、ページ全体はスクロールさせない。
  本文、セッションメニュー（PC / モバイル）、メインメニューを独立して縦スクロールさせ、
  ヘッダと入力欄を固定する。他のルートは既存のページスクロールを維持する。
  表示状態の所有者は session-message-webui、外枠は http-interface。UX-CC-W3 の会話・成果への到達を支える。
- **PC**: 左カラム = セッションリスト (プロジェクトコード / 状態ドット / 未読バッジ /
  最終発言プレビュー)、右カラム = メッセージ + 下部固定の入力欄。
- **モバイル**: 左カラムは非表示。ヘッダ左のメニューボタンでドロワー表示 (Discord と同じ)。
- **状態カード**: PC / モバイルとも**右上のボタン**。既定は非表示、押した時だけ
  オーバーレイ表示 (現在の repo / branch / task / stat / cost / active repos)。
- **入力欄は下部固定**。2026-09-10 neco 指示: Enter / Shift+Enter は改行だけに使い、送信は送信ボタンで行う。
  入力枠の右横に送信・RWF絵文字ボタンを縦に並べ、モバイルでも横配置を維持する。
  RWFリストはボタンの上へ右端を揃えて開き、幅をviewport内に制限する。
  session-message-webui が入力状態を所有し、UX-CC-W1 の意図した依頼と CC-INV-02 の操作境界を支える。
  改行・IME確定で送信APIを呼ばず、送信失敗時の本文保持と送信中の重複抑止を維持する。
- **セッション停止はチャット本文のコマンド**で行う。`/stop` `/rename <text>` `/enter`
  `/stat` を本文パーサで解釈し、対応する API を叩く。未知の `/xxx` は
  そのまま inject せず「未知のコマンド」を返す (誤爆防止)。停止は確認ダイアログを 1 枚挟む。
- **メッセージ描画**は `author_type` ごと:
  - `thinking` は既定折りたたみ (`▶ 思考 …`)、クリックで展開
  - `task` は Task カード (実行中はスピナー、完了で結果要約に更新)
  - `delegation` は親子リンクチップ (クリックで相手セッションへ遷移)
  - `question` / `permission` はボタン付き (既存モーダルの処理を再利用)
  - `tool` は 1 行。 ただし **失敗した呼び出しは折りたたみカード**にし、 開くと
    「実行した内容」(Bash ならコマンド行) と「エラー」を出す (2026-09-01 neco 指示:
    「Bash 失敗時に Cc の WebUI で何が失敗したか見れるようにしよう」)。
    出典は `metadata.failure` (session-message-layer §4.1)。 成功した呼び出しには
    内訳が無く、 従来どおり 1 行のまま。
    **Requirement ID: `SPEC-SESSION-TOOL-FAILURE-RENDERING`**
- cleanup を返さない **useEffect の本体はブロックにして、値を返さない**。式の戻り値は
  cleanup として保存され、関数でなければアンマウント時に落ちる。2026-09-01 に
  `useEffect(() => bottom.current?.scrollIntoView(...), [...])` が原因で
  「モニターからセッションを開くと真っ黒 + `TypeError: q is not a function`」が発生した
  (障害が起きた Chromium 環境では `scrollIntoView` が Promise を返した)。回帰は
  `MessageList.test.tsx` が固定している。

### 1.2.1 応答の進行と関連作業（2026-09-10）

**Requirement ID: `SPEC-SESSION-CHAT-RESPONSE-WORK`**

UX-CC-W2/W3/W4、CC-INV-01/04/05/08。TypeScript/React の既存構成を維持する。
表示状態は session-message-webui、phase の保存は session-message-layer が所有する。

- user 入力・assistant の途中報告・thinking/tool/task の後は会話末尾に「作業中...」を表示する。
  最終回答、質問・許可待ち、session の終了・lost では止める。active というだけで作業中とは推定しない。
- Codex の assistant `metadata.phase=final_answer` と Claude の `summary` を最終報告として表示する。
  最終報告までの同一応答内の作業表示を既定で閉じた「作業内容」へまとめ、原文を再展開できる。
  user の入力、質問・許可、成果添付は隠さない。phase のない旧 assistant を最終報告と推定しない。
  正本のメッセージを削除・書換えせず、再読込後も保存済みの区切りから再構成する。
- 右上の「タスク・テスト/PR」トグルで関連作業を開く。session tasks、Taskflow の明示的 session 関連、
  現在の testing claim、Revisor PR の審査状態を区別する。PR は Revisor の `sessionId`（author session）または同じ repository と
  専用 branch の一致で結ぶ。main/master/develop の共有だけでは関連付けない。
  各取得失敗・未設定を空一覧と区別して示し、再取得可能にする。開いている間だけ取得し、セッション移動時は閉じる。
- セッション一覧の末尾に「新規セッション」ボタンを置き、Monitor の DelegationSpawnForm を再利用する。
  開いただけでは spawn せず、フォームの送信で既存 API を呼ぶ。PC とモバイルの両方から利用可能。
- Discord は Codex final_answer と Claude summary の本文先頭へ `***FINAL ANSWER***` を付ける。
  この装飾は Discord adapter が所有し、WebUI の保存本文へ混入させない。通常の途中報告には付けない。

検証計画: phase 投影、複数応答の折りたたみ、質問待ち・最終報告・停止時の進行表示、関連対象の分離、
spawn UI の再利用、Discord の最終報告装飾を既存テストと同じ境界で確認する。実行結果は PR に別記する。
復旧は本変更の revert。DB migration は不要。過去の phase 欠落行を推測補完しない。

表示の実装対応（すべて `web/src/pages/session-chat/`）:

| ファイル | 所有する表示・操作 |
|---|---|
| `SessionChat.tsx` | セッション更新、入力後の待機、関連一覧トグルの開閉 |
| `response-turns.ts` | 保存済み最終報告を根拠にした応答区切りと作業中判定 |
| `MessageList.tsx` | 作業内容の details、最終報告・添付・末尾の進行表示 |
| `SessionWorkPanel.tsx` | 正本 API の読取、取得状態・失敗・再取得と関連一覧 |
| `related-work.ts` | タスクの明示 session 関係と PR の repo/専用 branch 照合 |
| `SessionList.tsx` | 一覧末尾の新規セッション入口 |
| `SessionSpawnDialog.tsx` | Monitor 共通フォームを載せるダイアログと focus/close の寿命 |

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

## 5. 添付の閲覧とモバイル入力

2026-09-08 neco 指示。価値は UX-CC-W3（成果へ到達）、不変条件は CC-INV-01（対象の同一性）、
CC-INV-02（権限境界）、CC-INV-04（根拠）。人間が Cc のセッションチャットから成果資料を読み、
登録済みの絵文字を入力するシナリオを対象とする。Discord モバイルの添付 UI は対象外。

### 添付の閲覧

- `session_messages.attachments` のラスター画像を本文に添えて既定で表示し、必要なら折りたためる。
- 既存の `chat_messages.metadata.attachment_paths` を持つ資料投稿も同じ時系列へ読み取り表示する。
  正本は既存の二つの保存先のまま。表示のための再投稿や canonical message ID の合成はしない。
  既読位置は引き続き `session_messages.id` のみを使う。
- `GET /v1/sessions/:id/chat-attachments` は対象 session の直近200資料投稿を返す。
  各投稿の添付は最大10件、ファイルは index と basename のみを公開する。
- `GET /v1/sessions/:id/chat-attachments/:messageId/:index` は保存済み投稿の所属を照合し、
  添付 guard の許可ルートと禁止名を強制して読む。呼出側からパスは指定できない。
  許可ルートは workspace、temp、既存 attachment policy 設定。元ファイルは変更しない。
- 最大8MiB。PNG/JPEG/GIF/WebP は base64 JSON、NULを含まないUTF-8は text JSON。
  テキスト内のHTMLを実行せず文字列表示する。SVGは画像として埋め込まない。
  ファイルは展開時に読み、閉じる・セッション移動・アンマウントで fetch を中止する。
  消失・拒否は404、容量超過は413、非対応バイナリは415。応答は private/no-store。
- 添付一覧・個別ファイルの失敗を表示し再試行できる。添付一覧の失敗で会話本文を隠さない。
- 2026-09-10: 保存済みファイルの画像・動画は同じ個別取得 API の `?raw=1` から元ファイルを配信する。
  PNG/JPEG/GIF/WebP は画像として直接表示、MP4/M4V/WebM/MOV は controls / playsInline /
  preload=metadata の動画プレイヤーで表示する。自動再生せず、変換や全体の base64 化をしない。
  動画コーデックの対応はブラウザに依存する。消失・非対応等の表示失敗には再試行を用意する。
  raw は上記メディア拡張子のみを許可し、既存の session 所属・保存パス・公開範囲ガードを必ず通す。
  private/no-store と nosniff を付け、単一 byte Range は206、満たせない範囲は416、HEADは本文なし。
  最大64KiBずつ読み、EOF・切断・エラーでファイルハンドルを解放する。rawには8MiBのプレビュー制限を課さない。
  テキスト等の JSON プレビューには従来の制限を維持する。状態所有者はHTTP adapterと各メディア表示。
  過去のファイルが削除されている場合の復旧は、送信者に同じ資料の再共有を依頼する。
- HTTP adapter は `src/api/chat-attachments.ts`、保存の読み取りは persistence の ChatRepo、
  開閉・取得キャンセルの状態は session-message-webui の各プレビューが所有する。

### モバイルとRWF絵文字入力

- チャット画面の `touch-action: manipulation` でダブルタップズームを抑止する。
  ピンチズームとスクロールを許容する。端末ごとの実機評価は別途行う。
- RWF絵文字一覧は既存 reaction-mappings と reaction-skill-workflows API から開く度に取得する。
  既定値に override を適用し、解除された値を除外、異体字セレクタを正規化して重複を除く。
  カスタムスキル割当が同じ絵文字の表示名を優先する。登録の正本は RWF 設定のまま。
- 2026-09-10: 一覧には対応する `/skill` 名を表示し、同じ skill の絵文字を1項目にまとめる。
  同じスキルでも各絵文字を選択でき、個別ラベルを併記する。スキル割当のない組み込みは action ごとにまとめる。
- 選択は入力欄のカーソル位置へ挿入する。送信は既存送信操作で行う。
  選択自体は RWF 実行やリアクション送信ではない。停止セッション・送信中は入力不可。
- 検証契約は `chat-attachments.test.ts`、`Attachments.test.tsx`、`RwfEmojiPicker.test.tsx`。
  ファイル公開境界、UTF-8保持、HTML非実行、取得中止、絵文字の非自動送信を対象とする。
