# 発話による「セッション終了」

## 目的

「セッション終了」と発言してもプロセスが閉じず、人間が改めて `/end-session` を叩く必要が
あった (2026-08-09 neco 指摘)。発言はセッションへ inject されるだけで、実際に終了させるのは
セッション自身の責務だったため、session-end skill を回しきれないセッションが残り続けた。

## 挙動

- `session_end` capability を持つユーザーによるセッションチャンネルへの発言が
  「セッション終了」の指示なら、Concordia が
  `session_end_requested_at` を metadata に記録する。発言自体は従来どおり inject する
  (残作業の片付け・ログ保存はセッション自身にやらせる)。
- **即時には終了させない。** 指示の最後で実行する形にするため、要求以降にセッションが
  静かになってから (`last_seen_at` が既定 90 秒更新されない) 終了させる。
- 静かにならないまま既定 15 分を超えたら終了させる。残り続けるのを防ぐのが目的なので、
  ここは待ち続けない。
- 終了処理は `/end-session` (= `DELETE /v1/sessions/:id`) と**同じ関数** (`endSessionNow`) を通る。
  session-end inject → pending 印 → status=ended → report/独白 まで同一で、
  完了通知が来なければ既存の expired-session-end-reaper が PID を回収する。

## 判定

- 対象: `セッションを終了` / `セッション終了` / `session-end` (空白・全角空白は無視)。
- 発話全体が終了指示として読める場合だけを対象にし、`session-end skill の実装` のような
  単なる言及は対象外にする。
- 除外: 打ち消しを含む文 (`しないで` `せず` `不要` `やめて` `中止` `禁止`)。
  誤終了は取り返しがつかないので、拾い漏らす側に倒す。
- Discord 発話は `/end-session` と同じ `session_end` capability を必須とし、未認可なら
  inject も終了要求の記録も行わない。
- 認可済みの終了指示について、終了時期は要求時刻と `last_seen_at` だけで判定し、
  LLM の自己申告には依存しない。

## 検証

- `src/control/end-session-request.test.ts` — 検知 (肯定 / 打ち消し / 単なる言及) と、
  idle 経過・上限超過・要求なしの選別。
- `src/discord/ingress.test.ts` — 発話終了の認可と、未認可時に inject しないこと。
- `src/control/end-session-command.test.ts` — HTTP / watcher 競合時の終了副作用の冪等性。
