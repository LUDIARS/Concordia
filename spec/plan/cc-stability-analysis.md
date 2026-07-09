# Cc セッション安定性解析 — 「よく落ちる」の原因分解と改修ポイント

- Date: 2026-07-09
- Status: analysis only (実装なし・提案資料)
- Area: session lifecycle / spawn / reaper / hooks / Discord control plane
- 解析方法: コードベース全域の静的解析 (Fable による多角並列調査 + 実コードでの裏取り済み)

## TL;DR

「Cc がよく落ちる」は単一のバグではなく、**5 系統の故障モードの複合**である。
しかも複数の系統が連鎖する: Concordia 本体が 1 つの未捕捉 rejection で丸ごと死ぬ →
再起動時に全セッションの WS カウントがゼロ化される → 健全な Cc が lost 判定される →
lost は二度と active に戻れない → 行が purge される → reaper が「孤児」と誤認して
**動作中の claude.exe ごと `taskkill /F /T`** する。

最優先 (P0) は次の 3 点。これだけで「落ちる」の大半が止まるか、少なくとも可視化される:

1. **Concordia 本体にプロセスレベルの安全網がない** — `unhandledRejection` / `uncaughtException` ハンドラが `src/` に 1 つも存在しない (grep で確認済み)。Node 22 の既定動作では未処理 rejection 1 発でプロセス全体が終了する。
2. **健全な Cc を殺す「purge → reap のハサミ」** — lost 復帰不能 + purge が `ws_clients` を見ない + reaper が「行なきプロセス = 孤児」と判定する 3 段連鎖。
3. **spawn 失敗が Concordia 本体を巻き添えにする** — `spawn()` に `error` ハンドラがなく、`wt.exe` / lictor が見つからないだけで uncaughtException になる。

---

## 故障モード分類

「落ちる」に見える現象は、実際には次の 5 つに分解される。

| # | モード | ユーザーから見た症状 |
|---|--------|---------------------|
| A | Concordia 本体プロセスのクラッシュ | 全セッションが同時に死んだように見える。管制・Discord・monitor が全部沈黙 |
| B | 健全な Cc セッションの誤 kill | 作業中の Cc が突然消える。特に Concordia 再起動後や長時間の autonomous 作業中 |
| C | Cc クラッシュの不可視化・無再起動 | 本当に落ちた Cc が検知されず、lost として 30 分後にひっそり消える。自動復旧なし |
| D | hook 起因のハング / 激遅 | Cc がフリーズ・毎ターン数秒固まる (死んでいないが死んで見える) |
| E | Discord 制御系の恒久停止 | bot が黙る。/end-session が「応答しませんでした」。セッションは生きているのに操作不能 |

---

## モード A: Concordia 本体が丸ごと落ちる

Concordia は全 Cc セッションの管制塔なので、本体が死ぬと**全部が同時に落ちたように見える**。
これが「よく落ちる」の最大の増幅器。

### A-1. プロセスレベルの安全網ゼロ 【P0】

- `src/server.ts:22-34` — エントリポイントにあるのは `beforeExit` ロガーのみ。
  `process.on("unhandledRejection")` / `process.on("uncaughtException")` は **src/ 全域に存在しない**。
- Node 22 の既定では未処理 rejection はプロセス終了。以下の A-2〜A-4 の全てがこれで即死に化ける。
- **改修案**: `src/server.ts` に両ハンドラを追加し、`reportError` (error-pipeline) 経由でログ +
  Discord エラーチャネルへ通知。`uncaughtException` は状態次第で graceful restart を選択できる形に。
  これ 1 つで「本体ごと死ぬ」が「1 操作が失敗してログに残る」に変わる。

### A-2. `spawn()` に error ハンドラがない 【P0】

- `src/control/spawner.ts:250-257` — Cc 起動 (`spawn("wt.exe", …)`) に `child.on("error")` なし、try/catch もなし。
- `src/control/codex-worker-spawn.ts:89-102` — Codex headless worker も同様。
- `spawn` の失敗 (ENOENT / EACCES / EMFILE / ENOMEM) は**非同期の `error` イベント**で通知される。
  リスナーがなければ uncaughtException → A-1 と合わせて**本体クラッシュ**。
  「Cc を起動しようとしたら Concordia ごと落ちた」を直接説明できる。
- 対照的に reaper 内の `runCapture` は正しく `proc.on("error", …)` している (`src/control/reaper.ts:313`)。
- **改修案**: 両 spawn に `error` (+可能なら `spawn`/`exit`) リスナーを付け、spawn 結果を
  `spawn_failed` としてセッション状態に記録する。

### A-3. rules engine の async リスナー / async setInterval 【P0】

- `src/events.ts:135-139` — `EventBus.emit` の `try { l(ev) } catch {}` は**同期 throw しか捕まえない**。
- `src/rules/engine.ts:45` — コードベースで唯一の **async** subscriber。中の `deps.rules.list(...)`
  (同期 better-sqlite3 呼び出し) が try/catch 外にあり、throw すると promise rejection として escape → 本体クラッシュ。
  emit はほぼ全イベントで走るため露出頻度が高い。
- `src/rules/engine.ts:67` — `setInterval(async () => {…})` も同型。tick 本体の `list()` /
  `actionFrequencyMultiplier()` が未ガード。
- 他のスケジューラ (`src/sweeper.ts:34-40`, `src/stat/scheduler.ts:123-129`) は sync 関数 + 内部 try/catch の
  安全パターンで書かれており、rules engine だけが外れ値。
- **改修案**: rules engine を他スケジューラと同じパターン (sync コールバック + 全体 try/catch) に揃える。

### A-4. Discord relay の未ガード async IIFE 【P1】

- `src/discord/bot.ts:859-873` (session prompt relay), `src/discord/bot.ts:916-921` (Slack→Discord mirror) —
  `void (async () => {…})()` に `.catch` がない。webhook 送信は 429 / Unknown Webhook (10015) /
  ネットワークエラーで普通に reject する → 本体クラッシュ。
- 隣接ハンドラ (`:776-780` delegation.mirror, `:898-899` permission_request) は `.catch` 済みで、この 2 箇所だけ漏れ。
- **改修案**: 2 箇所に `.catch(...)` を追加。合わせて「`void (async…)()` は必ず `.catch` を付ける」を lint 規約化
  (`@typescript-eslint/no-floating-promises` で機械的に検出可能)。

### A-5. SQLite の busy_timeout 未設定 + 2 プロセス書き込み 【P1】

- `src/db/index.ts:8-14` — `busy_timeout` pragma なし。`src/cost-worker.ts:32` が**同じ DB ファイル**を
  別プロセスで開く。WAL でも writer は 1 つで、競合時は better-sqlite3 の既定 5000ms を
  **イベントループを同期ブロックしたまま**待ち、超えれば SQLITE_BUSY throw。
  その throw が A-3 の未ガード地点に落ちれば本体クラッシュ、落ちなくても全 HTTP (hook 含む) が最大 5 秒停止。
- **改修案**: 明示的な `busy_timeout` 設定 + 書き込み系の try/catch 整備。cost-worker とのリース
  ハンドオフ窓 (`src/bootstrap/core.ts:743-748`) の二重書き込みも解消候補。

---

## モード B: 健全な Cc セッションが誤って kill される

### 生存判定の構造 (前提)

セッションが `active` を保つ条件は次の**どちらか**:

1. `ws_clients > 0` — `concordia-agent-client.mjs` の常駐 WS 接続 (`src/db/sessions-repo.ts:256-263` が除外条件)
2. `last_seen_at` が新しい — Cc hook (prompt / edit / compact / Stop) 発火時のみ更新

heartbeat は**タイマー式ではなくイベント駆動**。長い 1 ターン (長考・長時間ツール実行) 中は hook が
一切発火せず `last_seen_at` が凍結する。WS 接続中も `last_seen_at` は更新されない
(`sessions-repo.ts:270-302` は接続/切断時のみ touch)。つまり**作業中セッションを守っているのは WS 1 本だけ**。

### B-1. lost に落ちたら二度と active に戻れない 【P0・中心的欠陥】

- `POST /event` (`src/api/sessions/events.ts:46`)、`POST /heartbeat` (`src/api/sessions/lifecycle.ts:261-266`)、
  `PATCH` は `last_seen_at` を bump するが **`setStatus(…, 'active')` を呼ばない**。
  active への復帰は SessionStart (`lifecycle.ts:24`) のみ (検証済み)。
- 動作中の Cc は SessionStart を再度踏まないため、一度 lost になった健全セッションは
  **heartbeat を送り続けながら lost のまま固定**され、purge (→ B-2) の対象であり続ける。
- **改修案**: event / heartbeat 受信時に `status === 'lost'` なら active へ自動復帰させる
  (revive イベントをログして可観測化)。これが B 系統の最重要修正。

### B-2. purge → reap の「ハサミ」 【P0】

3 段の連鎖で、生きているプロセスを Concordia 自身が殺す:

1. **purge が `ws_clients` を見ない** — `purgeStale` (`src/db/sessions-repo.ts:323-340`, 検証済み) は
   `status IN ('lost','abandoned') AND last_seen_at < cutoff` だけで行を DELETE する。
   WS が再接続済みの生きたセッションでも、lost 固定 (B-1) + 静かな 30 分で行が消える。
2. **行が消えると reaper の保護が消える** — reaper (`src/control/reaper.ts:95-150`) は
   `active`/`lost`/`ended`(5 分猶予) の行に紐づくプロセスだけを保護する。行なき lictor /
   agent-client は「記録なき孤児」に分類される。
3. **孤児は tree-kill される** — `reapOrphans` (`reaper.ts:216-238`) → `stopSessionByLictorPid` →
   Windows では `taskkill /F /T` (`src/control/stop-session.ts:38-46`)。**作業中の claude.exe と
   その全ツールサブプロセスが flush の機会なく即死**する。
- reaper spec 自身がこの構造を「行を消すと lictor_pid も失われ… 記録なき真の孤児」と明記している
  (`spec/feature/session-process-reaper.md`)。
- **改修案** (いずれか、併用可):
  - `purgeStale` に `ws_clients = 0` 条件を追加する
  - purge 前に紐づくプロセスの生存確認を行い、生きていれば purge しない (または先に graceful stop)
  - reaper が「記録なき孤児」を kill する前に **transcript mtime** (作業中判定の真のシグナル、
    `src/control/stalled-session-nudge.ts:10-16` が既に利用) を確認する

### B-3. Concordia 再起動が lost 化の起爆装置になる 【P1】

- 起動時に `resetAllWsClients()` が**全セッション**の `ws_clients` を 0 にする
  (`src/bootstrap/core.ts:704`, 検証済み)。agent-client の再接続バックオフは 1〜30 秒
  (`tools/concordia-agent-client.mjs:116-118`)。
- 再接続完了前に sweeper の初回 tick (60 秒周期) が来ると、`last_seen_at` が古いだけの
  健全セッションが lost に落ち、B-1 により復帰不能になる。さらに reaper は**起動直後に即 1 回走る**
  (`reaper.ts:280`)。
- WS 側にも増幅要素: サーバの 25 秒 ping で応答のない接続は terminate される (`src/api/ws.ts:115-123`)。
  agent-client 側のイベントループが一瞬詰まるだけで切断 → 再接続 30 秒の無防備窓が生じる。
- **改修案**: 起動後 N 分 (例: 再接続バックオフ最大値 + sweeper 1 周期 ≒ 2〜3 分) は
  sweeper の lost 判定と reaper の孤児 kill を停止する「起動猶予ウィンドウ」を設ける。

### B-4. 閾値の設定不一致 — `.env.example` が発症頻度を 6 倍にする 【P0・修正コスト極小】

- コード既定: `lostAfterSec = 1800` (30 分, `src/shared/config.ts:216`)。
  一方 `.env.example:10` は `CONCORDIA_LOST_AFTER_SEC=300` (5 分) を配布している (検証済み)。
  README / docs / service-schema も「5 分」と記述しており、`spec/setup/config-reference.md:58` が
  不一致を既に指摘、`spec/setup/core.md:110` には「active session がすぐ lost になる」が
  既知症状として載っている。
- `.env.example` をコピーした環境では lost 化の窓が 5 分になり、B-1〜B-3 の連鎖が**桁違いに起きやすい**。
- **改修案**: `.env.example` を 1800 に修正し、ドキュメントの「5 分」記述を一掃する。
  運用中の実 env も確認を推奨。

### B-5. PID 再利用を検証しない tree-kill 【P2】

- DELETE の保険 kill (`src/api/sessions/lifecycle.ts:376-400`) と admin/stop-session は
  metadata に保存した `lictor_pid` / `agent_client_pid` を `isPidAlive` だけで確認して
  `taskkill /F /T` する。Windows で PID が無関係プロセスに再利用されていた場合、
  **無関係プロセスのツリーを殺す**。
- POSIX 側は `process.kill(-pid)` のプロセスグループ kill (`stop-session.ts:49`) で、
  lictor/agent-client がグループリーダーでない場合に誤爆リスク。
- **改修案**: kill 前にプロセスの開始時刻・イメージ名を記録値と照合する。

### B-6. reaper 猶予とセッション終了処理のタイムアウト不整合 【P2】

- `reaperEndedGraceSec = 300s` (`config.ts:224`) に対し、session-end 完了待ちは
  `SESSION_END_DONE_TIMEOUT_MS = 600s` (`src/api/sessions/shared.ts:25`)。
  終了処理 (ログ・memory 書き出し) が 5〜10 分かかると、正当なクリーンアップ中に
  reaper が lictor ツリーを kill しうる。
- **改修案**: 2 つの窓を揃える (reaper 猶予 ≧ session-end タイムアウト)。

---

## モード C: 本当のクラッシュが見えない・復旧しない

### C-1. `& exit 0` による終了コード洗浄 【P1】

- `buildWtArgs` (`src/control/spawner.ts:133`, 検証済み) はコマンド末尾に `& exit 0` を付ける。
  Windows Terminal のタブ残留回避が目的だが、副作用として **lictor / claude のあらゆる異常終了が
  終了コード 0 に洗浄**される。Concordia は spawn 後に `unref()` して手を離すため
  (`spawner.ts:250-257`)、クラッシュを示すシグナルが一切残らない。
- **改修案**: lictor 側で子プロセスの終了コードを取得し、`POST /event {kind:"exit", code}` として
  Concordia に報告させる。WT タブ挙動は lictor 報告後の `exit 0` で両立できる。

### C-2. 自動再起動が存在しない 【P1】

- 死んだ Cc は `active → lost → abandoned → purge` と減衰するだけ (`src/sweeper.ts:45-94`)。
  `tryRecover` (`sweeper.ts:130-147`) は transcript の再パース (表示用) であり再起動ではない。
  stalled-session-nudge は WS 経由のテキスト注入なので、死んだプロセスには無音で落ちるだけ。
  唯一の再起動である relictor (`src/api/sessions/end.ts:19-70`) は**手動 + 対象が active であることが条件**
  のため、既に落ちたセッションには使えない。
- **改修案**: C-1 の exit 報告 (または lost 検知) をトリガに、relictor の引き継ぎパスを再利用した
  **opt-in の auto-respawn** を追加する。回数上限・バックオフ付き。

---

## モード D: hook が Cc をハング・激遅にする

`tools/concordia-hook.mjs` は exit code の面では安全 (常に `process.exit(0)`, `:52-55`) だが、
**ハングと遅延**の面で問題がある。

### D-1. `execSync` に timeout がない — SessionStart で無期限ハング 【P1】

- `tryGitRemote` / `tryGitBranch` (`tools/concordia-hook.mjs:417-430`, 検証済み) は
  `execSync` に `timeout` オプションなし。credential プロンプト・stale な `index.lock`・
  巨大 repo で git が詰まると **SessionStart hook が無期限ブロック**し、Cc セッションが起動できない。
- **改修案**: `timeout` (+ `killSignal`) を渡す。数秒で十分。

### D-2. サーバ停止時に毎プロンプト 6〜9 秒固まる 【P1】

- `appendEvent` (`:199-207`) は postJson → dumpPendingTasks → (prompt 時) dumpProcessLogs を
  **直列**に実行し、各 fetch が `TIMEOUT_MS` (1500ms) まで待つ。`CONCORDIA_HOOK=1` の場合は
  active ゲート (`:83-87`) がバイパスされるため、**Concordia が落ちている間も** UserPromptSubmit の
  たびに 4〜9 本の fetch が各 1.5 秒ずつタイムアウトする ≒ 毎ターン約 6〜9 秒のフリーズ。
  ユーザーには「Cc が死んでいる」ように見える。モード A で本体が落ちたとき、この項が症状を倍加する。
- **改修案**: fetch を `Promise.all` で並列化 + 最初の接続失敗で hook 全体を short-circuit
  (「サーバ不在」を数十 ms で確定させる)。

### D-3. stdout 汚染によるコンテキスト肥大 【P2】

- `QUIET_STDOUT` は `prompt` のみ (`:50`)。`edit` (PostToolUse) / `compact` / `session-end` では
  `[Concordia tasks]` 等が stdout に出て Cc のコンテキストへ注入される。**毎ツール実行ごと**の注入は
  長時間セッションのコンテキストを圧迫し、compaction 頻度を上げて安定性を下げる。
  サイズ上限もない (`:188-196`, `:361`)。
- **改修案**: edit hook では stdout を抑制 (または pending task がある時のみ・サイズ上限付き)。

### D-4. 細部 【P2】

- `Number(env.CONCORDIA_TIMEOUT_MS ?? "1500")` (`:46`) — 非数値だと `NaN` → `setTimeout(fn, NaN)` は
  0ms 発火となり全 fetch が即 abort、報告が無音で全滅する。バリデーション追加。
- `readFileSync(0)` (`:373-379`) — stdin が閉じられない呼び出し方をされると永久ブロック。

---

## モード E: Discord 制御系の恒久停止

### E-1. `ShardReconnecting` を fatal 扱いして bot を自壊させる 【P1】

- `src/discord/bot.ts:663-671` — `ShardError` / `ShardDisconnect` に加え、discord.js が自力で
  resume する**通常イベント**の `ShardReconnecting` まで `stopAfterGatewayInstability` (`:282-297`) に
  流し、タイマー全消去 + eventBus 購読解除 + `client.destroy()` する。
- 復帰経路がない: `src/bootstrap/core.ts:435-439` は状態を記録して handle を null にするだけで、
  **watchdog も自動再起動もない**。ネットワークの一瞬の揺らぎで bot が恒久停止し、
  セッションチャネル・status card・inject が全部止まる = 「落ちた」ように見える。
- **改修案**: `ShardReconnecting` では teardown しない。真の切断には上限付き自動再起動を
  `onRuntimeState` から行う。

### E-2. interaction ACK 順の残存リグレッション 【P2】

- 2026-07-06 の問題ログ (`spec/plan/problem_logs/2026-07-06-discord-end-session-unknown-interaction.md`)
  で「ACK 先出し」方針が確立したが、同じアンチパターンが残っている:
  `src/discord/commands/enter.ts:22-24`、`src/discord/commands/mmtask.ts:66-69`
  (どちらも `requireSessionChannel` が deferReply より先)、
  `src/discord/control.ts` の `ctrl:refresh` (`:115`) / `ctrl:end-session`・`ctrl:rename` (`:131,138`) /
  spawn modal (`:125`) / pick 系 (`:155,163`)。
- なお同ログの Follow-up「age_ms > 3000 が続くなら event loop stall を調査」は、本資料の
  A-5 (SQLite 同期ブロック最大 5 秒) と D-2 が有力な説明になる。
- **改修案**: 該当ハンドラ冒頭に `deferReply` / `deferUpdate` を移動し、問題ログと同様に
  テストで固定する。

### E-3. メモリの緩やかな成長 【P2】

- `promptRelayLast` (`bot.ts:234`)、`error-fix.ts` の `lastSeen` Map、cost-sampler の `seen` Set 群
  (`session-usage-cache.ts:162` ほか) が無限成長。クラッシュではなく長期稼働時のメモリ圧。
  上限またはTTL付き構造への置き換えを推奨。

---

## タイミング定数一覧 (現状値と関係)

| 定数 | 値 | 定義 |
|------|-----|------|
| sweeper 周期 | 60s | `config.ts:220` |
| active → lost | **1800s (`.env.example` は 300s!)** | `config.ts:216` / `.env.example:10` |
| lost/abandoned → purge (行 DELETE) | 1800s | `config.ts:218` |
| lost → abandoned | 86400s | `config.ts:217` |
| WS ping / 死活 terminate | 25s | `src/api/ws.ts:21,115-123` |
| agent-client 再接続バックオフ | 1〜30s | `concordia-agent-client.mjs:116-118` |
| reaper 周期 | 300s (+ 起動直後に即 1 回) | `config.ts:222`, `reaper.ts:273,280` |
| reaper 最小プロセス年齢 | 180s | `config.ts:223` |
| reaper ended 猶予 | 300s | `config.ts:224` |
| DELETE 保険 kill 猶予 | 5s | `src/api/sessions/shared.ts:19` |
| session-end 完了待ち | 600s (**reaper 猶予 300s と不整合**) | `shared.ts:25` |
| hook fetch timeout | 1500ms × 直列 4〜9 本 | `concordia-hook.mjs:46` |

典型的な誤 kill シナリオ (連鎖の実例):

```
Concordia 再起動 (またはクラッシュ→再起動)
  → resetAllWsClients で全セッション ws_clients=0        (core.ts:704)
  → agent-client 再接続まで最大 30s の無防備窓
  → sweeper 初回 tick で last_seen が古い健全セッションが lost 化   (sweeper.ts:45-80)
  → 以降 heartbeat を送っても active に戻れない            (B-1)
  → 静かな 30 分 (autonomous 作業・長考) で purgeStale が行を DELETE  (sessions-repo.ts:323)
  → 次の reaper tick が「記録なき孤児」と判定
  → taskkill /F /T で作業中の claude.exe ツリーごと即死     (reaper.ts:230-236)
```

---

## 推奨ロードマップ

### Phase 1 — 即効・低リスク (P0)

| # | 改修 | 対象 | 規模 |
|---|------|------|------|
| 1 | `unhandledRejection` / `uncaughtException` ハンドラ追加 | `src/server.ts` | 小 |
| 2 | spawn への `error` リスナー + try/catch | `spawner.ts:250`, `codex-worker-spawn.ts:89` | 小 |
| 3 | rules engine を安全パターンに揃える | `src/rules/engine.ts:45,67` | 小 |
| 4 | event / heartbeat での lost → active 自動復帰 | `events.ts:46`, `lifecycle.ts:261` | 小 |
| 5 | `purgeStale` に `ws_clients=0` 条件 + reaper の transcript mtime 確認 | `sessions-repo.ts:323`, `reaper.ts:104-116` | 中 |
| 6 | `.env.example` の 300 → 1800 とドキュメント修正 | `.env.example:10` ほか | 極小 |

### Phase 2 — 検知と復旧 (P1)

| # | 改修 | 対象 |
|---|------|------|
| 7 | 起動猶予ウィンドウ (sweeper/reaper の起動直後停止) | `bootstrap/core.ts`, `sweeper.ts`, `reaper.ts` |
| 8 | `& exit 0` 廃止 or lictor による exit code 報告 | `spawner.ts:133`, lictor |
| 9 | opt-in auto-respawn (relictor パス再利用) | `sessions/end.ts` |
| 10 | Discord `ShardReconnecting` 非 fatal 化 + bot 自動復帰 | `discord/bot.ts:663-671`, `core.ts:435` |
| 11 | bot.ts 未ガード IIFE 2 箇所に `.catch` + `no-floating-promises` lint | `bot.ts:859,916` |
| 12 | hook: git timeout / fetch 並列化 / サーバ不在 short-circuit | `concordia-hook.mjs` |
| 13 | SQLite `busy_timeout` + 書き込みガード | `src/db/index.ts` |

### Phase 3 — 堅牢化 (P2)

PID 照合付き kill (B-5)、reaper 猶予の整合 (B-6)、hook stdout 抑制 (D-3)、
interaction ACK 先出しの残存箇所 (E-2)、無限成長 Map/Set の上限化 (E-3)、
timeout env のバリデーション (D-4)。

---

## 検証・回帰テスト案

- **lost 復帰**: lost セッションに `POST /event` → status が active に戻ることをテスト
  (現状は戻らないことが確認できる = 修正の回帰テストになる)。
- **purge 保護**: `ws_clients > 0` の lost セッションが `purgeStale` で消えないこと。
- **spawn 失敗**: `wt.exe` 不在を模した spawn ENOENT でプロセスが落ちず、`spawn_failed` が
  記録されること (spawnFn 注入は `codex-worker-spawn.ts` に前例あり)。
- **rules engine**: `deps.rules.list` が throw しても tick / listener が生存すること。
- **hook**: サーバ停止状態で prompt hook が 500ms 以内に終了すること。
- **Discord**: `ShardReconnecting` 発火で bot が destroy されないこと。
  enter / mmtask / control 各ハンドラの defer 先出し (既存 `tests/discord-end-session.test.ts` と同型)。
- **起動猶予**: 再起動直後 (`resetAllWsClients` 直後) に sweeper を強制 tick しても
  lost 化しないこと。

## 補足: 既存の問題ログとの接続

- `2026-07-06-discord-end-session-unknown-interaction.md` の Follow-up
  (「event loop stall を別途調査」) は、本資料 A-5 (SQLite 同期ブロック) と D-2 (hook 直列 fetch)
  が最有力の説明。interaction 到達が 13.9 秒遅延した件は、event loop が秒単位で塞がる経路が
  実在することと整合する。
- コミット `81ab65f fix(server): reduce startup load` も startup 時のイベントループ負荷を
  示唆しており、B-3 の起動直後レースと同じ時間帯に問題が集中している。
