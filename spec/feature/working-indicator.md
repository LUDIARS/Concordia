# 「作業中」インジケータ

## 目的
セッションが指令を受けて transcript が動いている間、チャンネルの**最後のメッセージ**
として「🔄 作業中…」を出し続け、進捗があったら消す。これで「まだ動いているのか／
止まった・入力待ちなのか」をリモート（Discord）で一目で判別できる。

ユーザ指示:
> 指令を受け付けて transcript が動いている間は「作業中」というメッセージを必ず
> 最後に投稿し、進捗があった際は消すようにする。

## 振る舞い（[`../../src/platform/working-indicator.ts`](../../src/platform/working-indicator.ts)）
`WorkingIndicator` は per-session の状態機械。post/remove はプラットフォーム依存の
コールバック注入（Discord/Slack 双方から使える）。

- **進捗（`noteProgress`）**: transcript.frame / セッション chat / prompt 受領で発火。
  既存の「作業中」を**即削除**（最下部でなくなったため）→ `repostDelayMs`（既定 1.5s）
  落ち着いてから最下部に再投稿。連続進捗中は削除のみ繰り返しタイマをリセットするので
  フリッカらず、ストリーミングが一段落した時に最下部へ出る。
- **idle 除去**: `idleMs`（既定 60s、`CONCORDIA_DISCORD_WORKING_IDLE_SEC`）無進捗で除去。
  = 作業が止まった／入力待ち。
- **clear**: `session.ended` / `session.lost` で即除去。
- per-session に操作を promise チェーンで直列化し、delete/post の取り違えを防ぐ。

## Discord 配線（[`../../src/discord/bot.ts`](../../src/discord/bot.ts)）
- 投稿は **webhook ではなく通常 bot メッセージ**（`channel.send`）。`message.delete` で
  確実に消せるため。session channel が active のときのみ。
- `routeEvent` で: `transcript.frame` / `chat.posted(session)` / `session.event(prompt)`
  → `noteProgress`、`session.ended` / `session.lost` → `clear`。
- bot 自身の投稿なので ingress は `author.bot` で無視し、自己ループしない。

## 既知の制約 / フォローアップ
- Slack platform への配線は未実装（v0.1）。`WorkingIndicator` は platform 非依存なので
  Slack bot からも同じコントローラを使えるが、本 PR では Discord のみ。
- 「作業中」テキストは固定。将来 current_task を併記する余地あり。
