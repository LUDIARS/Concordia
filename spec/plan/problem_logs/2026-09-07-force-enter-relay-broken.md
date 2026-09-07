# 🙄 force-enter が届かない (出所ヘッダで CR が本文化 + ask 質問中の保留)

- Date: 2026-09-07
- Status: fixed (このログと同じ PR で修正)
- Area: Concordia — reaction-workflow (`src/platform/reaction-workflow.ts`) × Lictor — pending-question-gate / wrap
- Severity: 中。 送信取りこぼしの唯一の救済操作が無効化されていた。 セッションが入力欄に文字を抱えたまま無言で停止し、 人間が張り付いても復帰させられない

## Summary

Discord で 🙄 を押すと `force-enter` が発火し、 対象セッションへ CR (Enter キー相当) だけを
inject して「送信を強制する」のが仕様。 2026-09-07 時点でこれが 2 つの独立した原因で
機能しなくなっていた。

1. **CR が本文に化けていた。** `ReactionWorkflowRunner.inject()` は provenance がある
   inject の先頭に `【Concordia reaction-workflow: <action> (<platform>)】\n` を足す。
   force-enter の prompt は CR 1 文字なので、 送られる本文は
   `【Concordia reaction-workflow: force-enter (discord)】\r` になる。
   Lictor 側は本文が複数行だと `submitDelayedEnter` に落ちるため、 **日本語の見出しを
   入力欄へ打ち込んで submit する** 動作になる。 Enter キー押下ではない。
2. **ask マーカー質問が開いている間は保留されていた。** Lictor の `classifyInject` は
   `discord:<uid>` / `slack:<uid>` 形式だけを human と見なす。 Enter 系の source は
   `reaction-workflow` / `discord-enter` / `discord-enter-fallback` / `slack-enter-fallback`
   といずれもコロン区切りではないため **automatic** と判定され、 marker 質問 (policy
   `"automatic"`) が 1 件でも開いていれば `PendingQuestionGate` が握り潰す。
   人が「送信されていない」と気付いて救済しに来る状況そのものが、 保留条件と一致していた。

## Evidence

2026-09-07、 セッション `lictor-2a7dc3e9-462a-4be0-afed-b0c4cb3be142` (cwd `E:/Document/Ars`)。

- Concordia の発火は成立している (`data/process-logs/concordia.out.log`):
  - `00:08:08.512Z discord reaction-workflow: action=force-enter mode=inject … emoji=🙄`
  - `00:23:33Z` にも同じ組。 直近 5 日で計 4 回。
- 対象セッションの transcript
  (`~/.claude/projects/E--Document-Ars/33bfda24-114f-4f0e-8d89-28c0463c3c88.jsonl`) は
  **23:58:52 の assistant フレームを最後に一切伸びていない**。 CR も見出し本文も届いていない。
- 経路の健全性は個別に確認済み — 「壊れているのは中継そのもの」と切り分けた:
  - `sessions.ws_clients = 1` (Lictor の WS は接続済み)。
  - sidecar `POST /v1/keys` に空 `data` を投げると `400 data is empty after sanitization`
    (= `ptyWriter` 健在。 ptyWriter 不在なら 503 が先に返る。 pty へは 1 バイトも書かない検査)。
- 最後に正しく動いた記録は `session_events` の 2026-07-03T14:28:31Z
  `{"text":"\r","source":"reaction-workflow"}` — **装飾なしの CR**。

## Regression Context

原因 1 は Concordia `1f2b983b`「リアクション注入の出所を session message の正本まで運ぶ」
(2026-09-04 23:06) で入った。 本文を持つアクション向けの装飾を **キー列アクションにも
無条件に適用** したのが欠陥。 neco の初期見立ては Lictor の trust folder 対応
(`a9db299` 2026-09-02 ほか) だったが、 これらは `child.write()` を叩くだけで
submit 経路には触れていない。 時期が近かったための誤帰属。

原因 2 は Lictor `efb5b2b`「未回答の ask 質問を blocker にして自動 inject で勝手に
進ませない」で入った。 保留対象を **source 文字列だけ** で決めており、 本文の性質
(制御信号か本文か) を見ていなかった。

## Cause

- `src/platform/reaction-workflow.ts` の `inject()`: provenance の有無だけで
  ヘッダ付与を決めていた。 アクションが本文を送るのかキー列を送るのかを区別していない。
- Lictor `src/pending-question-gate.ts` の `shouldDefer()`: 判定材料が
  `origin.bypassesMarkerHold` (= source 由来) のみ。 本文が CR/LF だけの inject は
  モデルが自分の質問に自答する経路になり得ないが、 その区別が無い。

## Fix

1. **Concordia**: `isKeySequenceAction(action)` を追加し、 `force-enter` では出所ヘッダを
   付けない。 出所は `provenance` と session event に残るので追跡性は落ちない。
   併せて log の `targetSessionId.slice(0, 8)` を廃止 — `lictor-2` までしか出ず、
   どのセッションへ入れたのか特定できなかった。
2. **Lictor**: `shouldDefer()` で本文が CR/LF のみの inject を marker 保留の対象外にする。
   picker 質問 (`"all"`) では従来どおり保留する (Enter は既定候補を確定させてしまうため)。
   既に本文を保留中のときは Enter も FIFO に並べる (順序逆転で本文が確定しなくなるため)。
3. **Lictor**: `onInject` / `onAnswerQuestion` の無言 return
   (`ptyWriter` 不在 / sanitize 後に空) に理由ログを足す。 今回の切り分けで
   「Cc は届けたのにセッションで何も起きない」 の原因が log にも transcript にも
   残っていなかったのが調査を長引かせた。

## Verification

- Concordia `src/platform/reaction-workflow.test.ts` (81 tests pass):
  - force-enter は装飾なしの `"\r"` だけを inject する。
  - force-enter でも provenance は残る (本文には出さない)。
  - 本文を持つアクション (`context`) には従来どおりヘッダが付く。
- Lictor `tests/pending-question-gate.test.ts` (16 tests pass):
  - marker 質問が開いていても素の CR は通る。
  - 本文を持つ automatic inject は従来どおり保留される。
  - picker 質問では CR も保留される。
  - 本文を保留中なら CR も並び、 flush 順は 本文 → CR。
  - 末尾が CR なだけの本文は「素の Enter」扱いしない。
- Lictor full suite: 526 pass / 0 fail / 1 skip。 typecheck 両リポとも 0 error。

## Follow-up

- 反映には両サービスの build + Excubitor 経由の再起動が要る
  ([[feedback-memoria-reflect-needs-build-and-restart]] と同じ性質)。
- `discord-enter` / `*-enter-fallback` / `reaction-workflow` を Lictor が automatic と
  分類する構造自体は残る。 本文を持つ制御 inject を将来足すときは、 source を
  `discord:<uid>:<用途>` 形式にして human 分類へ寄せること。
- 調査中に `ws session claim rejected: invalid enrollment` が **43,540 件** 出ているのを
  観測した (claim してくる `session` は Cc の `lictor-…` ではなく claude の transcript
  UUID)。 今回の事象とは別件だが、 セッション起動のたびに毎秒リトライしてログを
  埋めている。 別途調査が要る。
