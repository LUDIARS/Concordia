# Discord `/end-session` Unknown Interaction Regression

- Date: 2026-07-06
- Status: investigated; fix and regression tests added in working tree
- Area: Discord interaction handling / session lifecycle
- Severity: user-visible command failure

## Summary

`/end-session` で Discord が「アプリケーションが応答しませんでした」を表示し、Concordia 側には次の警告が出た。

```text
8:39:33 [discord] interaction handler failed id=1523473383340376204: Unknown interaction
```

これは以前にも起きていた Discord interaction ACK timeout 系の再発であり、リグレッションとして扱う。

## Evidence

`Concordia/logs/concordia.log` に、該当 interaction と直前の command receive が残っていた。

```text
discord command received name=end-session guild=1136199339417534606 channel=1523466448251519096 user=905235114026467350
interaction handler failed id=1523473383340376204: Unknown interaction
```

Discord snowflake から復元した interaction 作成時刻:

```text
interaction id: 1523473383340376204
created_at: 2026-07-06 08:39:19.355 +09:00
handler_log: 2026-07-06 08:39:33.251 +09:00
age_at_handler: about 13.9s
```

Discord の initial response window は約 3 秒なので、handler に入った時点で既に期限切れだった。

## Regression Context

過去の channel archive に同系統の記録がある。

- `logs/channel-archives/___-13-28-37-discord-interaction-handler-failed-id-151448633-1514486593682018384-2026-06-11.md`
- 当時の結論: slash command handler が HTTP などを await してから reply すると 3 秒 timeout で `Unknown interaction` になる。
- 当時の方針: `end-session` は「受け付けたら即 OK」を返す。

今回の再発では `/end-session` は DELETE を fire-and-forget していたが、session channel lookup より前に ACK していなかった。また Control Panel の `ctrl:end-session:confirm:*` は DELETE 完了まで `interaction.update()` を待つ経路が残っていた。

## Cause

直接の失敗は `Unknown interaction`。今回のログでは command receive 時点で interaction age が約 13.9 秒あり、Discord gateway event processing が遅延した、または既に期限切れの interaction を処理した可能性が高い。

加えて、コード上の防御が不十分だった。

- `/end-session` は `requireSessionChannel()` の後に `reply()` していた。
- Control Panel の confirm は `DELETE /v1/sessions/:id` を await してから `interaction.update()` していた。
- 失敗ログに command/custom id や interaction age が無く、次回調査で期限切れ到着か handler 内遅延かを切り分けにくかった。

## Fix Requirements

- Discord interaction は可能な限り handler 冒頭で ACK する。
- `/end-session` は session lookup より前に `deferReply({ ephemeral: true })` する。
- Control Panel confirm は DELETE 前に `deferUpdate()` する。
- `interaction handler failed` ログには command/custom id と snowflake 由来の `age_ms` を出す。
- command receive/autocomplete receive ログにも `age_ms` を出す。
- ACK 先出しをテストで固定し、将来のリグレッションを検出する。

## Verification Added

追加テスト:

- `tests/discord-end-session.test.ts`

検証内容:

- `/end-session` が session lookup より前に `deferReply` する。
- Control Panel の `ctrl:end-session:confirm:*` が DELETE 完了前に `deferUpdate` する。
- Discord snowflake timestamp decode が該当 interaction id で期待値を返す。

実行済み:

```text
npm test -- --run tests/end-session-flow.test.ts tests/sessions-api.test.ts tests/discord-end-session.test.ts
npm run lint
```

## Follow-up

`age_ms > 3000` の interaction が継続する場合、ACK 先出しでは救えない。chat-worker / embedded bot / Discord gateway のイベント処理遅延や二重起動、event loop stall を別途調査する。
