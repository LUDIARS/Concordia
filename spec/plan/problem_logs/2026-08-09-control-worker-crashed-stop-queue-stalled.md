# control worker が crashed のまま停止キューが滞留し、セッション残留が再発している

- Date: 2026-08-09
- Status: unresolved — 真因未特定。Excubitor の起動経路が全サービスで壊れている
- Area: session lifecycle / control job queue / Excubitor breakaway spawn
- Severity: critical — Excubitor 経由でどのサービスも起動できない。副作用として
  停止経路も全滅し、放置すると終了済みセッションの残留が再び蓄積する

## Summary

2026-08-08 の調査 (上記ログ) で特定した 4 欠陥のうち #4 (control job の consumer が
存在しない) は、Excubitor カタログへ `concordia-control` を登録することで修正済みと
していた。しかし**実際には consumer が一度も定常稼働しておらず、停止キューは
2026-08-08 の調査時点 358 件から 713 件へ増え続けている**。

これは同一問題の再発ではなく、「修正したつもりが本番で効いていない」状態。
2026-08-08 の問題ログは「#4 は修正済み」として閉じているので、その記述を訂正する
必要がある。

## Evidence

計測時刻: 2026-08-09 (epoch ms `1786222630681`)。

### Excubitor サービス state

`excubitor_service_detail(concordia-control)`:

| 項目 | 値 |
|---|---|
| `state` | `crashed` |
| `last_seen_at` | `1786202610000` |
| `updated_at` | `1786222490000` |
| `restart_policy` / `max_restart` | `on-failure` / `5` |
| `command` | `node --env-file-if-exists=.env dist/control-worker.js` |
| `cwd` | `${ARS_ROOT}/Concordia` |

`excubitor_recent_logs(concordia-control)` → `{"logs": []}`。
`${ARS_ROOT}/logs/concordia-control/` はディレクトリのみ存在し、ファイル 0 件
(ディレクトリ作成 2026-08-08 22:58)。すなわち**プロセスは一行も出力せずに落ちている**。

### 停止キューの滞留

`concordia.db` の `control_jobs`:

| status | 件数 | 最古 `created_at` | 最新 `created_at` |
|---|---|---|---|
| `queued` | 713 | `1784935521647` | `1786222426565` |
| `failed` | 39 | `1784504327294` | `1784935521646` |

- kind は全件 `stop_process_tree`。
- `failed` 39 件の `last_error` は全て `job expired before execution` の 1 種類。
  = worker は過去に一度は動いており、期限切れ判定そのものは正しく機能している。
- `queued` 713 件のうち **712 件が `expires_at < now`** (期限切れ)。
  期限内は 1 件のみ。`expires_at = created_at + 300s`。
- 最新 `created_at` は計測時刻の約 3 分前。**キューは今も増え続けている**。

### 残留プロセスの再発

`sessions` の直近 `ended` 300 件のうち `session_end_pending_at` マーカー保持は 3 件。
その `lictor_pid` を `Win32_Process` で確認:

```
3 processes: ALIVE node.exe "node" "${ARS_ROOT}\\Lictor\\bin\\lictor.mjs" ...
```

- 3 本とも `ended_at` 済み・ラッパ生存 = 残留。
- 起動元パスは `$ARS_ROOT/Lictor` = 2026-08-08 に実施した #1 (stale worktree からの
  復帰) は効いている。**残留の原因はもはや #1 ではない**。
- 最古の `ended_at` は計測の約 29 分前で、猶予 300 秒を大きく超えている。
  すなわち #3 の猶予回収は発火して job を積んでおり、**キューの先で死んでいる**。

規模が 21 本 → 3 本に留まっているのは #1 の修正で Lictor 自身の tree-kill が
効くようになったため。恒常的な回収経路は依然として塞がっている。

## Regression Context

2026-08-08 の問題ログの「残作業」#4 は
「`control-worker` を Excubitor カタログへ登録するか、Concordia 本体プロセス内で
worker を起動する」だった。カタログ登録 (`concordia-control`) は main の
`excubitor.catalog.yaml` に入っており、`autostart: true`。

登録は行われたが**起動確認が行われなかった**。`state` を見れば `crashed` と分かる
状態が少なくとも 2026-08-08 22:58 (ログディレクトリ作成時刻) から続いている。

「カタログに書いた = 動いている」と見なした点が、2026-08-08 のログ自身が記した教訓
「キューに積むだけの経路は、consumer の死活を監視しないと無言で全滅する」を
そのまま繰り返している。

## Cause

### 直接原因: Excubitor が **どのサービスも起動できない** (breakaway spawn 後の子が即死)

`concordia-control` が起動できないのはこのサービス固有の問題ではない。
**Excubitor の起動経路そのものが壊れている。**

#### 症状

Web API (`excubitor_control_service`) と CLI (`excubitorctl service <code> start`)
のどちらからでも同じ形で失敗する。2026-08-09 に `concordia-control` を 4 回、
`genius` を 1 回試行し、5 回とも同一:

```
service <code> could not be verified after breakaway spawn (pid=<spawned pid>);
it exited immediately or its identity was unreadable
```

`genius` は `npm run start` (`shell: true`)、`concordia-control` は
`node ... dist/control-worker.js` (`shell: false`) で、**シェル経由の有無に関わらず
同じ**。現在稼働しているサービス (cernere / concordia / revisor / ludellus-web) は
いずれもこの破損より前から動いているものだけで、Excubitor 経由で新規に上げられた
ものは無い。`data/process-logs/concordia.manual.out.log` の存在は、既に手動起動での
回避が行われていたことを示す。

#### 切り分け済みの事実

- **launcher は正常に動いている。** spawn 中に `data/process-logs/.breakaway-*.json`
  を監視したところ `{"pid":<spawned pid>}` が書かれていた。つまり launcher の
  `child.once('spawn')` は発火しており、`error` は出ていない (ENOENT ではない)。
- **子プロセスは一度も観測できない。** spawn 前後 25 秒間・100ms 間隔で
  `Win32_Process` を走査しても、コマンドラインに `control-worker` を含む
  `node.exe` は一度も現れなかった。返された PID も直後には消滅している。
- **子は一行も出力していない。** `concordia-control.err.log` の mtime は
  supervisor 起動直後の autostart 試行時 (2026-08-09 00:23:22) のまま更新されない。
  append open では mtime は動かないので、これは「書き込みが無い」ことを示す。
- **ログファイルのロックではない。** `cmd //c "echo probe >> concordia-control.out.log"`
  は成功する。
- **同じコマンドを手動実行すると正常に起動する**:

  ```
  $ cd ${ARS_ROOT}/Concordia && node --env-file-if-exists=.env dist/control-worker.js
  .env not found. Continuing without it.
  {"level":30,"name":"control-worker","msg":"control worker started (durable OS-control queue consumer)"}
  ```

すなわち「プロセスの生成には成功するが、生成された子が実行に入る前に消える」。
子の環境 (WMI の env block → launcher → `spawn` の `env` に渡る `childEnv`) の
欠落が候補として残るが、**本ログ時点では未特定**。

#### 棄却した仮説

- **restart budget 枯渇** — 明示 `start` でも同じ失敗をするため、`max_restart: 5`
  の消費では説明できない。
- **cmd.exe のログ排他 (Excubitor `a56035d` が対処した既知バグ)** — 症状は似ているが、
  supervisor (`dist/service-runner.js`) の起動時刻は 2026-08-09 00:22:22 で、
  `dist/` の build (2026-08-08 23:15) より後。サービスの lifecycle は
  `src/index.ts:516` で local-control supervisor へ委譲されており、spawn 層は
  修正後のコードで動いている。**「Excubitor が古いから」ではない。**
  backend (`dist/server.js`、2026-08-06 起動) は確かに古いが、spawn はそこでは
  行われない。この仮説に基づいて一度「Excubitor 本体の再起動が必要」と結論したが、
  それは誤りだった。

### 副次: `concordia-cost` / `genius` も同じ理由で停止

姉妹 worker `concordia-cost` も `state=crashed` (`last_seen_at` `1785835345000`)。
`genius` も `autostart: true` のまま `stopped`。起動経路の破損で軒並み上がっていない。

### 残存する構造要因: #2 が未マージ

`session-end-done` の POST を Lictor の shutdown コードから行う修正は
Lictor `fix/session-end-done-from-shutdown` (`4dc6274` + autofix `dfb9461`) に
実装済みだが main 未マージ。通知経路が skill markdown 依存のままなので、
猶予回収 (#3) → control job → worker という保険経路への依存が続いている。

## Fix Requirements

0. **先に Excubitor の breakaway spawn を直す**。これが直らない限り
   `concordia-control` / `concordia-cost` / `genius` を含むどのサービスも
   Excubitor 経由では起動できない。切り分けでは、子へ渡す環境の**キー名だけ**を
   launcher 側で一時採取し、手動起動時との差分を取る。値は token・資格情報・ローカル設定を
   含み得るため保存しない。値の確認が不可避な個別キーは secret 判定後に明示的に redact し、
   dump をリポジトリ・共有ログ・PR artifact へ入れない。
1. `concordia-control` を復旧し、**定常稼働していることを state と実ログで確認する**。
   カタログ登録だけを完了条件にしない。
2. 復旧前に滞留 713 件を棚卸しする。712 件は `expires_at` 切れで、worker は
   `job expired before execution` として failed にするだけ (実測済みの挙動) なので
   稼働再開による誤 kill リスクは低い。期限内 job のうち orphan job は
   `expectedCommand`、session job は session metadata と observed process generation
   で PID 再利用を防ぐため、それぞれの防御が 1 件ずつ実際に効くことを確認してから
   流す。
3. spawn 失敗と起動後クラッシュを区別できるログを残す。`log_path` にファイルが
   1 つも作られない現状では原因を特定できない。
4. consumer 死活を監視対象にする。`control_jobs` の `queued` 件数と最古
   `created_at` を health / 通知の materialに載せ、「積まれ続けているのに
   消費されていない」を無言にしない。
5. Lictor `fix/session-end-done-from-shutdown` (#2) をマージし、猶予回収を
   保険の位置へ戻す。

## Verification

- 復旧後、既存の期限切れ backlog が drain され、新規 job が 300 秒以内に
  `succeeded` または `failed` へ遷移すること。新規投入があるため、`queued` 総数の
  単調減少は完了条件にしない。
- `ended` かつ `session_end_pending_at` を持つセッションが猶予 (300 秒) + 1 tick
  以内に消えること。現在の 3 件が回収されることで確認できる。
- 稼働中セッションのラッパが tree-kill されないこと (`classifyKind(cmd, name)` による
  `cmd.exe` 除外 = #4b の回帰テスト)。復旧直後の 1 tick で active セッション数が
  減らないことを確認する。

テストは本ログ作成時点では実行していない。

## Follow-up

- [`2026-08-08-ended-session-process-residue.md`](./2026-08-08-ended-session-process-residue.md)
  の「残作業」#4 は「カタログ登録済み・稼働未確認」と訂正する。
- Excubitor 経由の起動が全滅していたことに誰も気づいていなかった。個々のサービスは
  「stopped だから止めてあるのだろう」と読めてしまう。`start` が失敗し続けている
  こと自体を通知する経路が要る。
- Excubitor の spawn 層はマージ + build だけでは反映されない (本体再起動が必要)。
  「Excubitor 自身の修正が Excubitor 経由の起動を直す」構図では、再起動しない限り
  修正が効かないまま全サービスの起動が壊れ続ける。build 時刻と supervisor の
  起動時刻の突合を、Excubitor の修正マージ後の定型確認にする。
- 同じ理由で止まっている可能性のあるサービスを再起動後に洗い直す。少なくとも
  `concordia-cost` は同一原因。`genius` (autostart / on-failure / stopped) も要確認。
