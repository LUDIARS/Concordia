# Feature: idle-after-final-answer nudge (待機催促通知)

## 目的

Concordia がラップするセッション (Lictor 経由の Claude / Codex / Gemini) が
**最終回答 (final_answer) または会話要約 (summary) を送信した後**、一定時間
`N` 秒以内に**ユーザの入力意思 (キーボード入力イベント)** が観測されなかった場合、
そのセッションに**メッセージを送った人全員**へ「待機中です」の催促通知を送る。

AI が回答を返して入力待ちに入ったのに、依頼者が離席・見落としで気付かない状況を
救う。`N` は設定で変更可能。

## 用語 / 既存の材料

- **final_answer / summary の送信**: セッションの transcript は Lictor が
  `POST /v1/sessions/:id/transcript-frame` で Concordia に流し、Concordia は
  `eventBus.emit({ type: "transcript.frame", target_session_id, seq, kind, payload, ts })`
  する (`src/api/sessions/relay.ts`)。
  - 最終回答 = `kind: "text"` かつ `payload.role === "assistant"`。
    Codex は payload に `phase` を持ち、`phase === "final_answer"` が最終回答
    (`src/discord/egress.ts` 参照)。
  - 会話要約 = `kind: "summary"`。
- **入力意思 (キーボード入力イベント)**: **現状 Lictor はローカルの生キーストロークを
  Concordia に送っていない。本機能で Lictor 側に新イベントを追加する** (§Lictor 契約)。
  Concordia は `POST /v1/sessions/:id/event { kind: "user_activity" }` として受ける。
- **メッセージを送った人**: 人間 inject の `source` (`discord:<uid>:…` /
  `slack:<uid>:…`) に埋まっている。`src/control/requester.ts` の
  `parseRequesterSource(source)` が `{ platform, userId }` を返す。session_events の
  `kind === "inject"` を走査して distinct な requester 集合を得る。

## 振る舞い

### 1. アーム (タイマ開始/リセット)

`eventBus` を購読し、`transcript.frame` が **最終回答 or summary** のとき、その
`target_session_id` の idle タイマを **now + N 秒 に (再)セット**する。

- 判定: `kind === "summary"` ||
  (`kind === "text"` && `payload.role === "assistant"` &&
   (codex の場合は `payload.phase === "final_answer"`、それ以外は role=assistant で可))。
- 同一ターンで複数フレームが流れるため、来るたびに**リセット** (= 最後の送信から N 秒)。
- セッションが `active` でない、または `N <= 0` (無効) なら何もしない。

### 2. キャンセル (入力意思の観測)

以下のいずれかでそのセッションの idle タイマを**クリア (disarm)** する:

- `POST /v1/sessions/:id/event { kind: "user_activity" }` 受信 (Lictor の生キー検知)。
- `transcript.frame` が **ユーザ発話** (`kind === "text"` && `payload.role === "user"`) = submit 済み。
- 新規の**人間 inject** (`session.inject` で `parseRequesterSource` が非 null)。
- セッション終了 / inactive 化。

### 3. 発火 (通知)

タイマが N 秒満了したら:

1. session_events から `kind === "inject"` を走査し、`parseRequesterSource` で
   **distinct な requester** (platform+userId) を集める。1 人もいなければ通知しない。
2. そのセッションの Discord/Slack channel に、集めた全員をメンションして 1 通投稿する:
   例) `<@uid1> <@uid2> — このセッションは回答を返してから N 秒 入力がありません（待機中）`。
   - 投稿は既存の egress / セッション channel 解決を再利用 (AskUserQuestion が
     requester をメンション投稿する経路と同じ基盤)。
   - Discord は `<@userId>`、Slack は `<@userId>` メンション記法。
3. **ワンショット**: 発火後はそのサイクルを disarm する。次の final_answer/summary が
   来たら再アーム。連投しない。

## 設定 (`N` 秒)

- env `CONCORDIA_IDLE_NUDGE_SEC` (整数秒)。既定 `120`。`0` 以下で機能無効。
- 既存の設定ロード (`src/shared/config.ts`) に沿ってフィールド追加し、runtime へ配線。
- (任意) admin/config で上書き可能にする場合は既存 AdminState パターンに合わせる。

## 実装方針 (SRP / ファイル分割)

- **`src/control/idle-nudge.ts`** (新規, pure に近い state machine):
  - per-session の `Map<sessionId, {timer, armedAt}>` を保持。
  - `arm(sessionId)` / `clear(sessionId)` / `dispose()`。
  - タイマ発火時に注入された `notify(sessionId)` コールバックを呼ぶだけ (DB/Discord は外)。
  - `setTimeout` はテスト差し替え可能に (既存 cost.ts の keepTimersRefed / unref 流儀)。
- **配線 (bootstrap)**: `eventBus.subscribe` で arm/clear を駆動し、`notify` は
  requester 収集 + Discord/Slack 投稿を行う既存サービスへ委譲。
- **events ハンドラ**: `src/api/sessions/events.ts` に `kind === "user_activity"` を追加
  (バリデーションは既存 EventSchema に沿う。payload は空で可)。→ idle-nudge.clear を呼ぶ。
- **通知本文の組み立て**: pure 関数 (`buildIdleNudgeText(requesters, seconds)`) にして単体テスト。
- ユニットテスト: arm→N 経過で notify 発火 / arm 後 clear で発火せず / 複数フレームで
  タイマがリセットされる / requester 集合の distinct 化 / N<=0 無効。

## Lictor 契約 (別委託。本 spec で定義だけする)

Lictor は wrapped セッションの pty に**実ユーザのローカル stdin (生キーストローク)** が
来たとき、Concordia へ軽量イベントを送る:

- `POST /v1/sessions/:id/event { kind: "user_activity", payload: {} }`。
- **inject と区別する**: Lictor が `submitInject` / `ptyWriter` で流し込む注入
  (Discord/Web 由来) は user_activity として送らない。あくまで**物理端末の stdin**
  由来のみ。
- **デバウンス**: 高々 1〜2 秒に 1 回 (連打で洪水にしない)。best-effort、失敗は無視
  (Lictor の Concordia 連携は degrade 前提)。
- Lictor の keystroke は信頼境界 (CLAUDE.md)。新経路は**送信のみ** (pty への書き込みは
  しない) なのでサニタイズ対象外だが、イベント payload に生入力内容は載せない
  (「入力があった」事実だけ; プライバシ/ログ肥大回避)。

## 受け入れ基準

- [ ] final_answer/summary 送信後 N 秒無入力 → 送信者全員にメンション通知が 1 回届く。
- [ ] N 秒以内に user_activity (生キー) / ユーザ発話 / 新規 human inject → 通知されない。
- [ ] 連続フレームで最後の送信から N 秒に正しくリセットされる。
- [ ] `CONCORDIA_IDLE_NUDGE_SEC=0` で機能無効。
- [ ] 通知先は inject source から解決した distinct requester のみ (制御 inject は除外)。
- [ ] 既存 transcript relay / egress / session lifecycle を壊さない。ユニットテスト green。
