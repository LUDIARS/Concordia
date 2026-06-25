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
  - live = status `active` または `lost` (lost は復帰しうるので殺さない)。
    回収対象は ended/abandoned/purged(行なし) のみ。
  - 起動から `reaperMinAgeSec` (既定 180s) 未満は見送り (pid 登録レース回避)。
  - **session-end 進行中の保護 (安全弁):** `ended_at` から `reaperEndedGraceSec`
    (既定 300s = 5 分) 以内の ended session は live 扱いで殺さない
    (`liveSetsFromRepo` が active/lost に加えて grace 内 ended を live 集合へ入れる)。
    `DELETE /v1/sessions/:id` が status=ended にした直後から AI 側 session-end スキル
    (log 保存 / memory 更新 / Memoria 登録) が走り、 その完了は
    `POST /v1/sessions/:id/session-end-done` → force-exit で確定的に閉じる。
    reaper がこの猶予内に割り込むと WT を巻き込んで「途中で終わる」事故になるため、
    猶予の間は kill を背後にキューしたまま session-end の終了を見届ける。
- `startReaper()` — 既定 ON、 `reaperIntervalMs` (既定 5 分) 周期 + 起動直後 1 回。
- 手動: `GET /v1/admin/orphans` (dry-run 一覧) / `POST /v1/admin/reap`
  (`{dry_run?, min_age_sec?}`)。

## 設定 (env)
- `CONCORDIA_REAPER_ENABLED` (既定 `1`)
- `CONCORDIA_REAPER_INTERVAL_MS` (既定 `300000`)
- `CONCORDIA_REAPER_MIN_AGE_SEC` (既定 `180`)
- `CONCORDIA_REAPER_ENDED_GRACE_SEC` (既定 `300` = 5 分。 `0` で無効 = ended を即回収)

## Phase 2: agent-client の明示 kill (実装済)
agent-client は通常 WS の `session.ended/lost/abandoned` で自死するが、 **WS 切断中に
終了イベントが飛ぶと取りこぼし**孤児化する (reaper が 5 分以内に回収はする)。確定的に潰すため:
- `tools/concordia-agent-client.mjs` が起動時に `PATCH /v1/sessions/:id`
  `{ metadata: { agent_client_pid } }` で自分の pid を登録。
- `DELETE /v1/sessions/:id`(猶予後保険)と `POST /v1/admin/stop-session/:id` が
  `lictor_pid` と並べて `agent_client_pid` も kill (`parseAgentClientPid`)。

## 残 (follow-up)
- PC パフォーマンス / セッション別メモリの Monitor 可視化 → 実装済 (PR #186)。
