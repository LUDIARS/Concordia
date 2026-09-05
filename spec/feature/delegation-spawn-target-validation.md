# 委託 spawn の着地検証とゾンビ回収

2026-09-05 の障害調査から。 委託 (delegation) の spawn が「指示した場所以外」で
走ってしまう穴と、 run が終わってもプロセスが残る事象を塞ぐ。

## 1. 何が起きたか

run `e1432d37` (Quaestor / Gmail リアルタイム監視) の実際の連鎖:

1. 呼び出し元が `POST /v1/delegation/invoke` を
   `cwd: E:/Document/Ars/.wt-Quaestor-mail-realtime` / `branch` 無し / `parent_session_id: null`
   で叩いた。
2. parent が無いので contract が引けず、 `branch` は `undefined` のまま。
3. `prepareSpawnTarget` は `branch` が無いと `ok: true` で即 return し、 `cwd` を
   素通ししていた。 git 検証は branch 経路の内側にしか無く、 **cwd が実在するかすら
   見ていなかった**。
4. `.wt-Quaestor-mail-realtime` は当時存在せず、 `wt.exe -d` が効かないため cwd が
   親を辿って共有 checkout (Castra root, branch `main`) へ着地した。
5. branch 指定は指示書本文の散文
   「worktree 作成済み、 branch feat/mail-realtime-pubsub」 としてしか存在せず、
   誰も構造化フィールドと突き合わせていなかった。

結果、 「共有 checkout の Quaestor には一切触るな」 と明示された委託が Quaestor の
`main` へ直接コミットした (`bc87b64`)。

同時に、 テンプレの `default_cwd` を全数確認したところ
`E:\Document\Ars\.wt-Memoria-discord-ai-notes` は既に存在せず、 同じ事故が起きうる
状態のまま残っていた。

## 2. 対策

### 2.1 cwd 検証 (`src/control/spawn-cwd.ts`)

`validateSpawnCwd` を `prepareSpawnTarget` の入口に置き、 **branch の有無に関わらず**
検証する。

| cwd | 判定 |
|---|---|
| 未指定 | ok (呼び出し元が場所を指定していない = 既定動作に委ねる) |
| 実在しない | **error** — spawn 中止 |
| ディレクトリでない | **error** — spawn 中止 |
| git checkout でない | branch/worktree を準備する場合だけ **error**。それ以外は ok |
| git checkout | ok (repoRoot を返し、 後段が再利用する) |

複数リポジトリを扱うテンプレは git checkout でない workspace root を正当に使うため、
git checkout まで常時要求しない。branch/worktree を準備する場合だけ必須にし、本文に
既存 branch が書かれているのに構造化 branch が無いケースは次節の照合で止める。

### 2.2 branch の単一情報源 (`src/delegation/branch-source.ts`)

`resolveDelegationBranch` が contract → 引数の順で branch を決め、 指示書本文の
言及と突き合わせる。

- 本文だけが branch を指している → **spawn 中止** (呼び出し元の渡し忘れ)
- 本文と構造化フィールドが食い違う → **spawn 中止** (どちらが正か機械では決まらない)
- 一致 / 本文に言及なし → 通す

検出は 「`branch` / `ブランチ` の直後に置かれた、 `/` を含むトークン」 に限定する。
裸の `feat/xxx` を拾うと `spec/feature/foo.md` のような path で誤検知し、
正常な spawn を止める害の方が大きい。

検証は `DelegationService.runDefinition` に置く。 `/v1/delegation/invoke` と
`/v1/admin/spawn` の両経路がここを通るため、 1 箇所で両方に効く
(従来は前者だけが contract を見ており、 経路でムラがあった)。

### 2.3 worktree 状態の明示 (`SpawnWorktreeState`)

`spawn_worktree_created: boolean` は 「作らなかった」 が 3 通りに潰れ、 事故と正常を
区別できなかった。 `spawn_worktree_state` 列を足して 4 値で持つ。

| 値 | 意味 | 正常か |
|---|---|---|
| `created` | 新規に worktree を作った | ○ |
| `reused` | 既存の worktree を再利用した | ○ |
| `none-by-design` | branch 指定が無い。 呼び出し元の cwd で走る | ○ |
| `none-shared-checkout` | branch 指定はあるが worktree 無効。 共有 checkout 上で走る | 要注視 |

`spawn_worktree_created` は後方互換のため残す。

### 2.4 終了済み run のプロセス残留 (`src/delegation/finished-run-reaper.ts`)

run が `completed` / `failed` になって `finished_at` が入っているのに、 spawn された
`claude.exe` が終了せず 1 コアを 100% で焼き続ける事象が常態化していた。 実測:

| child session | run status | finished_at | 残留 |
|---|---|---|---|
| 30cf73dd | completed | 09-03 13:10 | 44 時間 |
| 6bc3c03e | completed | 09-03 10:54 | 46 時間 |
| 739af913 | completed | 09-03 10:49 | 46 時間 |
| 55055712 | completed | 09-03 14:38 | 42 時間 |
| 372b5aa0 | failed | 09-03 15:29 | 42 時間 |
| 6c553b15 | failed | 09-04 21:14 | 12 時間 |

6 本で約 7.5 コア (24 コア機で Idle 1.4 コアまで飽和)。

`findZombieRuns` が 「`finished_at` から猶予を過ぎてなお子 session の `lictor_pid` が
生存し、かつ session metadata の process 世代 (`concordia_spawn_id` / `start_iso`) と
Excubitor の観測結果が一致する run」 を返す。 PID 単独では、終了後に同じ PID を得た
無関係な process を誤停止しうるため回収対象にしない。猶予 (既定 600 秒) は
session-end flow・transcript flush・Discord 投稿の時間を見込む。

**既定は検出のみ。** kill は共有インフラの lifecycle 操作なので、
`admin.delegation_finished_run_auto_reap` を明示的に ON にしたときだけ行う。
停止は既存の `stopSessionByLictorPid` (Windows は `taskkill /F /T` でプロセスツリー) を
再利用する。

#### 回収の通知

回収を実行したときだけ、 chat の `system` チャンネルへ 1 通投げる (検出だけのときは
ログのみ — 掃除していないのに通知すると常時鳴り続ける)。

**メンションは `admin.mention_user_id` の 1 人だけ** (neco 指示 2026-09-05)。
回収対象の run には元の指示者や supervisor が紐づいているが、 それらを引いて足すと
1 回の掃除で無関係な人がまとめて呼ばれる。 掃除は管理者の関心事であって、 委託を出した
人の関心事ではない。

メンションは本文へ `<@id>` を書かず `mention_user_ids` の構造化フィールドで渡す。
egress は `allowedMentions: { parse: [] }` を付けて送るため、 本文に紛れた文字列は
発火しない。 文面に載せるのは Cc 自身が持つ値 (run id / pid / status / 経過時間) だけで、
委託の指示文やユーザ入力は載せない。

文面の組み立ては `src/delegation/zombie-reap-notice.ts` (純関数)。 一覧は 10 件までで、
超えた分は件数だけ示す。

`run-watchdog.ts` とはファイルを分ける。 あちらは *進行中* の run が止まっていないかを
見て子へ inject する。 こちらは *終わった* run が居座っていないかを見てプロセスだけを
対象にする。 run の status は書き換えない。

## 3. 設定 (AdminState)

| キー | 既定 | 意味 |
|---|---|---|
| `admin.delegation_finished_run_scan_enabled` | `true` | ゾンビ走査を行う |
| `admin.delegation_finished_run_auto_reap` | `false` | 検出したゾンビを停止する |
| `admin.delegation_finished_run_grace_sec` | `600` | 終了扱いからこの秒数は猶予 |

## 4. API

- `POST /v1/delegation/finished-run-scan` — 今すぐ走査する。 `?reap=1` を付けたときだけ
  停止する。 応答は `{ ok, reaped, count, zombies[] }`。
- `POST /v1/delegation/invoke` / `POST /v1/admin/spawn` の応答に
  `spawn_worktree_state` / `worktree_state` を追加。

定期走査は `startFinishedRunReaper` (既定 5 分周期、 `run-watchdog` と同じ
loop-bulkhead に乗せる)。
