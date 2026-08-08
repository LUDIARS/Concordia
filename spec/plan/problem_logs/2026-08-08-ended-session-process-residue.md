# 終了済みセッションの Lictor プロセスツリーが残留し続ける

- Date: 2026-08-08
- Status: diagnosed — 残留プロセスは手動回収済み、恒久修正は未実施
- Area: session lifecycle / reaper / control job queue / Lictor launcher
- Severity: high — 実測 149 プロセス / working set 10.7GB を占有し、ホスト全体が重くなった

## Summary

`ended` になったセッションの Lictor ラッパとその子孫 (claude / codex / node_repl /
codex-code-mode-host / powershell) が終了せず、数日単位で積み上がっていた。

2026-08-08 時点の実測 (直近 200 セッション):

| | 件数 |
|---|---|
| `ended` セッション | 186 |
| うち `lictor_pid` が消滅 (正常) | 158 |
| うち PID 再利用 (別プロセス) | 5 |
| **うちラッパが生存 = 残留** | **21** |

残留 21 本のツリーは子孫込みで 149 プロセス、working set 合計 10.7GB。最古は
2026-08-02 に `ended` になったもの。

`session_end_pending_at` マーカーの有無と残留は**完全に相関**していた
(マーカー保持 21 件 = 残留 21 件、マーカー無し 165 件は全て正常終了)。

## 根本原因

独立した 4 つの欠陥が直列に並び、回収経路が 1 本残らず塞がっていた。

### 1. Lictor が stale worktree のビルドで起動していた (回収コードが物理的に不在)

生存していた Lictor 全 35 本 (active 14 + 残留 21) が
`E:\Document\Ars\.wt-Lictor-runtime-repair\bin\lictor.mjs` から起動していた。
`E:\Document\Ars\Lictor` (main) 起動は 0 本。

この worktree は detached HEAD `74005f4` (2026-07-30) で `dist/process-tree.js` が
存在しない。すなわち Lictor `7fa28be` "fix(session): reap wrapped process tree on
shutdown" (2026-08-05、main マージ済・dist ビルド済) の `taskkill /F /T` は
**一度も実行されたことがなかった**。

`lictor_dev_path` は 2026-07-25 に main の node-pty が壊れていた回避策として
この worktree へ向けられ、そのまま戻されていなかった
([`2026-07-25-test-temp-cwd-spawn-race.md`](./2026-07-25-test-temp-cwd-spawn-race.md))。
main 側の node-pty prebuild と `lib/vestigium` は現在復旧しており、
`node bin/lictor.mjs --help` も通る。回避策の前提は既に解消していた。

設定は DB 永続 (AdminState) なので、コードにも git 履歴にも痕跡が残らない。
「マージしたのに効かない」の調査で dist の mtime を見ても検出できない。

### 2. `session-end-done` の POST 元がコードに存在しない

`POST /v1/sessions/:id/session-end-done` は
[`src/api/sessions/end.ts`](../../../src/api/sessions/end.ts) に実装済みで、これが
`stopCompletedSessionProcesses` を呼ぶ唯一の入口。しかし呼び出し元はコード上に無く、
唯一の produce 元が skill markdown の手順
(`.claude/skills/save-session-log.md`) に書かれた

```
curl -sS -X POST ".../session-end-done" || true
```

だけだった。モデルが手順を踏むことに依存し、しかも `|| true` で失敗が無言になる。
自動 session-end ではここが踏まれず、マーカーが永久に残る。

`1f097b7` "fix: stop Lictor only after session-end completion" (#363, 2026-07-18) が
それまでの時間ベース ended 回収 (`endedGraceSec`) を撤去してこの通知だけを引き金に
したため、通知が来ない = 回収されない、が確定した。

### 3. sweeper の fallback が「Lictor 生存時」に構造的に到達不能

設計上の保険は「ended + マーカー → sweeper が lost へ → lost 専用 reaper が回収」。
しかし sweeper の抽出条件
([`findStaleEndedWithMetadataKey`](../../../src/db/sessions-repo.ts)) は

```sql
WHERE status = 'ended' AND last_seen_at < ? AND ws_clients = 0 AND ...
```

残留 Lictor は生きているので Concordia へ traffic を送り続け、`last_seen_at` が
更新され続ける。実測では `ended_at = 2026-08-02` のセッションの `last_seen_at` が
**調査時点の現在時刻**だった。`last_seen_at < lostCutoff` は永久に成立しない。

つまりこの fallback は「Lictor が既に死んでいる場合」にしか発火せず、
**回収が必要な唯一のケース (Lictor が生きている) では必ず外れる**。

### 4. control job worker が存在せず、停止 job が誰にも消費されない

`control_jobs` テーブルは **358 件すべて `status='queued'` / `attempts=0`**。
1 件も実行されていない。

consumer は standalone プロセス
[`src/control-worker.ts`](../../../src/control-worker.ts) (`npm run control:worker`)
だが、Excubitor カタログに `control-worker` サービスが登録されていない。
`concordia` は `node dist/server.js` のみを起動する。

reaper・relictor insurance・session-end 完了停止はすべて
`enqueueStopProcess` 経由なので、**kill 経路が全滅**していた。

### 4b. (派生) reaper が稼働中セッションの `cmd.exe` ラッパを孤児と誤判定する

`GET /v1/admin/orphans` は稼働中セッション (調査を行った当セッション自身を含む) の
`cmd.exe` ラッパを軒並み orphan として列挙する。

spawn は `cmd /d /s /c "node ...\lictor.mjs ..."` の形なので、`cmd.exe` の
コマンドラインにも `lictor.mjs` が含まれ `classifyKind` が `lictor` と判定する。
一方 `sessions.metadata.lictor_pid` に登録されるのは**その子の node の PID**。
両者は決して一致しないため、`classifyOrphans` は live セッションのラッパを
必ず孤児と判定する。

現在この誤判定が実害を出していないのは #4 で job が消費されていないからにすぎない。
**#4 だけを直すと、次の reaper tick で稼働中セッションが子ごと tree-kill される。**
修正順序の制約としてここに記録する。

## 実施した対処 (2026-08-08)

1. `PUT /v1/admin/lictor` で `lictor_dev_path` を `E:/Document/Ars/Lictor` へ復帰。
   `resolveLictorLauncher` は spawn ごとに評価されるため Cc 再起動は不要。
   以後 spawn される新規セッションから `7fa28be` が効く。
   稼働中プロセスは旧コードのままなので入れ替わるまで残留は続く。
2. 残留 21 ツリー (149 プロセス) を `taskkill /F /T` で手動回収。
   実行前に「ended である」「cmdline が `lictor.mjs`」「プロセス起動時刻が
   `ended_at` 以前」「プロセス起動時刻が `started_at` と 300 秒以内で一致」の
   4 条件で PID 再利用を排除し、active/lost の PID がツリーに含まれないことを
   assert した (PowerToys 等 5 件の PID 再利用を実際に除外)。
   結果 151/151 消滅、稼働中 14 セッションは全て健在、空きメモリ 29.4GB。

## 残作業 (未実施)

修正順序に依存関係がある。

1. **#4b を先に直す** — `classifyOrphans` が `cmd.exe` ラッパを孤児にしないこと。
   登録 PID とプロセスツリーの親子関係を突合するか、`cmd.exe` を分類対象から
   外す。これを #4 より先に入れないと稼働中セッションを殺す。
2. **#4** — `control-worker` を Excubitor カタログへ登録するか、Concordia 本体
   プロセス内で worker を起動する。併せて queued 358 件の棚卸し
   (大半が #4b 由来の誤判定なので破棄が妥当)。
   → **カタログ登録のみ完了。稼働はしていない。**
   `concordia-control` は `state=crashed` でログ 0 行、queued は 713 件へ増加。
   詳細と再診断は
   [`2026-08-09-control-worker-crashed-stop-queue-stalled.md`](./2026-08-09-control-worker-crashed-stop-queue-stalled.md)。
3. **#2** — `session-end-done` を skill markdown ではなく Lictor の shutdown
   コードから POST する。失敗を握り潰さずログに残す。
   → 実装済み・未マージ (Lictor `fix/session-end-done-from-shutdown`)。
4. **#3** — ended + マーカーの回収を `last_seen_at` に依存させない。
   `session_end_pending_at` からの経過時間で判定する
   (撤去された `endedGraceSec` 相当を、通知経路の保険として復活させる)。

## 教訓

- 「マージしたのに効かない」の切り分けは dist の mtime では足りない。
  実プロセスの CommandLine を見て**どのパスから起動されたか**を確認する。
- 保険を「通知が来たら」の一本に絞ると、通知経路が死んだときに全滅する。
  #2 の撤去 (`1f097b7`) が #3 の構造的欠陥を露出させた。
- 「生きているから保護する」条件は、「生きていること自体が異常」なケースでは
  保護ではなく延命になる (#3)。
- キューに積むだけの経路は、consumer の死活を監視しないと無言で全滅する (#4)。
