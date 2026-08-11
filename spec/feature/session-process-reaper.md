---
type: feature
title: "セッション終了プロセスの回収 (reaper)"
description: "Concordia セッション終了後に残留する Lictor ラッパと concordia-agent-client プロセスの回収設計。session-end完了通知による確定停止、失敗時のlost回収、OSプロセス走査の3段構成。"
service: concordia
domain: session-coordination
tags:
  - typescript
  - lifecycle
  - spawn
  - state-machine
  - monitoring
  - polling
  - websocket
  - event-driven
status: implemented
updated: 2026-06-30
---


# セッション終了プロセスの回収 (reaper)

終了したセッションの周辺プロセス (Lictor ラッパ `node lictor.mjs` と
`concordia-agent-client.mjs`) が残留してメモリを食う問題への対処。
過去 2 回の修正が効かなかったため、 仕組みから見直して再設計した (2026-06-18)。

## 根本原因 (診断)

プロセスを倒す道具は揃っていた — `control/stop-session.ts` の
`stopSessionByLictorPid` は Windows で `taskkill /F /T` (プロセスツリー一掃)、
Lictor は登録時に `lictor_pid` を `sessions.metadata` に書いている
(`Lictor/src/wrap.ts` の `client.register({ metadata: { lictor_pid } })`)。

**問題は「その kill が自動経路から一度も呼ばれていなかった」こと:**

1. `stopSessionByLictorPid` の呼び出しは `POST /v1/admin/stop-session/:id`
   (手動管理 API) ただ 1 箇所。普段は誰も叩かない。
2. 通常終了 `DELETE /v1/sessions/:id` は pid-kill せず、 Lictor へ
   `force-exit` HTTP を best-effort 送信するだけ。これは Windows/ConPTY 上で
   `child.kill("SIGTERM")` → cmd.exe ラッパしか落ちず**不発になりやすい**。
3. `sweeper.ts` は active→lost→abandoned→**`purgeStale` で DB 行を削除**する
   だけで一度も kill しない。行を消すと `lictor_pid` も失われ、 生きたままの
   プロセスは**記録なき真の孤児**になり Concordia から永久に kill 不能になる。
4. `concordia-agent-client` は SessionStart hook が `nohup` で detached spawn
   する別ツリー (`lictor_pid` の外)。WS で `session.ended/lost/abandoned` を
   受けたら自死する設計だが、 イベント不達 / 行 purge で孤児化する。

過去の 2 回の試行はそれぞれ「手動 kill API の追加」「Lictor force-exit の追加」
で、 **どちらも自動ライフサイクルに pid-kill を配線せず**、 sweeper の
kill-せず-purge も直さなかったため孤児が溜まり続けた。

## 対処 (Phase 1 = 止血 / Phase 3 = 回収)

### Phase 1: kill 経路の配線 (止血)
`DELETE /v1/sessions/:id` は force-exit (graceful) 送信後、 猶予
(`FORCE_EXIT_GRACE_MS` = 5s) で `lictor_pid` がまだ生存していれば
`stopSessionByLictorPid` で確実に倒す保険を追加 (`api/sessions.ts`)。

### Phase 3: 孤児回収 reaper (`control/reaper.ts`)
sweeper の kill-before-purge には踏み込まず (lost の復帰可能性を誤って殺す
リスクがある)、 OS プロセス走査ベースの reaper で包括的に回収する。これは
既に purge され記録が消えた分も拾える唯一の手段。

- `scanAgentProcesses()` — OS から node プロセスを列挙し cmdline で
  lictor / agent-client を分類 (Win=PowerShell CIM で pid/経過秒/cmdline、
  POSIX=`ps -eo pid=,etimes=,args=`)。
- `classifyOrphans()` (pure) — **active/lost の session に紐付かない**ものを
  孤児と判定。lictor は `pid ∈ live lictor_pids` か、 agent-client は
  `--session <id> ∈ live session ids` か、で live を判定。
- **誤爆防止 (live work を絶対殺さない):**
  - generic orphan判定ではactive/lost/endedをlive扱いにし、endedを経過時間で回収しない。
  - lost rowは専用判定で、`CONCORDIA_REAPER_LOST_GRACE_SEC`経過後もlost、
    `ws_clients=0`、metadataのPIDとOS上の`lictor.mjs` PIDが一致する場合だけtree-killする。
    kill直前にrowを再取得し、active復帰・WS再接続・PID差替えがあれば見送る。
  - 起動から `reaperMinAgeSec` (既定 180s) 未満は見送り (pid 登録レース回避)。
  - `DELETE /v1/sessions/:id` はmetadataへsession-end待機中を永続記録する。
    `POST /v1/sessions/:id/session-end-done` を受けた場合だけ記録済みPIDを停止する。
  - 完了通知がないままtrafficとWS接続が途絶えた待機中sessionはsweeperがlostへ移す。
    その後はlost専用reaperが復帰猶予とPID再確認を経て回収する。
- `startReaper()` — 既定 ON、 `reaperIntervalMs` (既定 5 分) 周期 + 起動直後 1 回。
- 手動: `GET /v1/admin/orphans` (dry-run 一覧) / `POST /v1/admin/reap`
  (`{dry_run?, min_age_sec?}`)。

## 設定 (env)
- `CONCORDIA_REAPER_ENABLED` (既定 `1`)
- `CONCORDIA_REAPER_INTERVAL_MS` (既定 `300000`)
- `CONCORDIA_REAPER_MIN_AGE_SEC` (既定 `180`)
- `CONCORDIA_REAPER_LOST_GRACE_SEC` (既定 `300` = 5 分。lost復帰猶予後にLictor treeを回収)
- `CONCORDIA_REAPER_SESSION_END_GRACE_SEC` (既定 `300` = 5 分。session-end 完了通知を待つ猶予)

## SPEC-REAPER-SHELL-WRAPPER: 起動子は agent プロセスではない

spawn は `cmd /d /s /c "node <path>/bin/lictor.mjs ..."` の形で Lictor を起動するので、
shell ラッパ (`cmd.exe`) のコマンドラインにも `lictor.mjs` が現れる。一方
`sessions.metadata.lictor_pid` に登録されるのは **その子の node** の PID で、両者は
決して一致しない。

`classifyKind` は shell ラッパを分類対象から外す (`agent-process-classify.ts`)。
除外しないと稼働中セッションのラッパが「live PID 集合に無い = 孤児」と必ず判定され、
control worker が動いた瞬間に作業中のセッションが子ごと tree-kill される。
ラッパ自体は本体を tree-kill すれば子の終了に伴って自然終了するので、追跡しない。

判定材料は Excubitor snapshot の `name` (image 名) とコマンドラインの `/c` / `-c` 委譲形。
snapshot の取得・age 算出は `agent-process-scan.ts`、分類は
`agent-process-classify.ts` に分離し、session-end 回収も同じ検証済みプロセス情報を使う。

## SPEC-SESSION-END-GRACE: 完了通知が来ない場合の保険回収

`session-end-done` 通知だけを停止の引き金にすると、通知経路が死んだ瞬間に回収手段が
0 本になる。reaper は毎周期、`session_end_pending_at` から
`CONCORDIA_REAPER_SESSION_END_GRACE_SEC` を過ぎた ended session を
`stopCompletedSessionProcesses` で回収する (`expired-session-end-reaper.ts`)。

判定は **マーカー自身の経過時間**で行い、`last_seen_at` には依存しない。
残留した Lictor は生きている限り traffic を送り続けて `last_seen_at` を更新するため、
`last_seen_at` 基準の条件は「回収が必要な唯一のケース (ラッパ生存)」で永久に成立しない。
停止に失敗した場合はマーカーを残して次周期で再試行する。

## 前提: control worker が動いていること

reaper・relictor 保険・session-end 完了停止はいずれも `control_jobs` へ job を積むだけで、
実際の kill は別 process の `concordia-control` (`dist/control-worker.js`) が行う
(同期 taskkill を API と同じ event loop で走らせないため。2026-07-15 の問題ログ参照)。

この service が動いていないと kill 経路が無言で全滅する。Excubitor catalog 断片
(`excubitor.catalog.yaml`) に `concordia-control` を定義しているのはこのため。
`control_jobs` に `queued` が積み上がり続けている場合は、まず worker の死活を疑う。

## Phase 2: agent-client の明示 kill (実装済)
agent-client は通常 WS の `session.ended/lost/abandoned` で自死するが、 **WS 切断中に
終了イベントが飛ぶと取りこぼす**。確定的に潰すため:
- `tools/concordia-agent-client.mjs` が起動時に `PATCH /v1/sessions/:id`
  `{ metadata: { agent_client_pid } }` で自分の pid を登録。
- `POST /v1/sessions/:id/session-end-done` と `POST /v1/admin/stop-session/:id` が
  `lictor_pid` と並べて `agent_client_pid` も kill (`parseAgentClientPid`)。

## 残 (follow-up)
- PC パフォーマンス / セッション別メモリの Monitor 可視化 → 実装済 (PR #186)。
