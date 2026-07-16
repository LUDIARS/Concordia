# Forum Codex spawn が session 登録前で止まる

- 発生日: 2026-07-16
- 対象: Concordia / Cc Discord forum spawn
- run: `ff453f79-f028-4fa6-96f9-cf8d1d9f128b`
- 症状: forum には「Cc がセッションを起動しました」と出るが、その後 session が登録されず Delegation run が `spawned` のまま残る。

## 観測事実

- `cc-live.jsonl` では worker PID の spawn 成功まで記録されている。
- `cost-one-shot-queue.jsonl` では対象 `codex exec --json` が exit code 0、約 272 秒で完了している一方、`metadata.sessionId` は null だった。
- Codex rollout は作成され、session id `019f6999-1d7f-7113-a240-9cc95a5b6a35` を持っていた。
- 現行 Codex CLI の stdout は開始時に `thread.started` / `thread_id` を出す。worker は旧形式の `session_meta.payload.session_id` だけを認識していた。

## 原因

`tools/concordia-codex-worker.mjs` の stdout parser が現行 Codex JSONL schema に追従していなかった。また、session id が得られないまま子プロセスが終了しても Delegation run の終端状態を更新しなかったため、run が永久に `spawned` と表示された。

## 修正方針

1. `thread.started.thread_id` と旧 `session_meta` の両方を解釈する純粋 parser を分離する。
2. `/v1/sessions` の成功を確認してから session 登録済みとみなす。
3. worker 終了時に Delegation run を必ず `completed` / `failed` へ更新する。session 登録できなければ exit code 0 でも明示的に failed とする。
4. 現行・旧イベントと未登録終了の回帰テストを追加する。

## 検証

- [x] parser unit test
- [x] Delegation / Discord / monitor test
- [x] typecheck / build
- [ ] 本体フォルダを build 後、Excubitor 経由で Concordia を再起動して forum spawn を実機確認
