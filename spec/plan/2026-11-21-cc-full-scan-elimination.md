# Concordia 全件ループの撤去方針 (2026-11-21)

> 指示 (2026-11-21):「まず全件ループみたいな動きやめろ」「最適化方針作って」。同日の停止の調査結果をもとにした方針案。

状態: S1 (P0) を実装した (2026-11-22、未反映)。migration は main が 153 まで進んでいたため 154 (FS-01) と 155 (FS-13) になった。本文中の 151〜155 は当時の仮番号で、S2 以降は 156 から振り直す。S2 以降は未実装。
数字の印: [確] は実測・ログ・コードで確認済み、[推] は確認済みの値からの計算・外挿・推定、[未] は未確認。行番号は調査時点の src のもの。

## 1. 目的と定義

**目的**: 1回の処理で読む量を「対象の件数」だけで決まる形にする。データの総量が増えても、イベントループを止める時間が増えないようにする。

**全件ループ**: 対象を絞らずに、全行・全セッション・全 PR・全チャンネル・全ファイルを毎回読み直したり回したりする処理。本書では次の6つの形を指す。

1. 索引に乗らずに行を読み流す SQL。EXPLAIN に `SCAN <表>` や `USE TEMP B-TREE FOR ORDER BY` が出るもの、WHERE に `lower()`・`LIKE '%x%'`・`json_extract` を置くもの、選択度の低い索引の範囲を最後まで読むもの。
2. 件数の上限が無い一覧取得。JS の `.slice` や `.filter` で絞る前に全件を読む処理。
3. 1件ごとに DB・ファイル・`JSON.parse` を繰り返す N+1。
4. 変化分ではなく、毎周期に全件や遡り窓の全体を照合する定期処理。
5. I/O の区切りが無く、microtask だけでつながる長い同期の塊。
6. DB 全体の大きさに比例する保守処理 (VACUUM など) を、本体で同期に実行すること。

**CC-NODE との関係**: CC-NODE-01 (応答性) は、応答経路で上限の無い走査をすることを禁じている。CC-NODE-06 (状態と DB) は、同期 DB API の実行とロック待ちをイベントループの時間として扱うよう求めている。本書は、この2つを SQL の計画・読む列と件数・周期処理の読み方について具体化し、テストと計時で確かめられる決まり (CC-SCAN-xx) にする。周期処理も同じイベントループで応答経路を止めるので、規則は応答経路に限らず、`concordia.db` を開くすべての処理に当てはめる。

**既存の計画との関係**:

- [2026-09-01 の軽量化](2026-09-01-cc-event-loop-diet.md) の続きにあたる。
  - そこに残っていた「`POST /v1/harness/context` の9秒の停止 (blackbox snapshot の可能性)」は、FS-11 で snapshot の費用を確かめた。1回約0.8秒で、listPending は最悪465ms。9秒の全部は説明できていない。
- [2026-10-11 の監査](2026-10-11-cc-rv-data-growth-audit.md) の項目のうち、次の2つを本書で引き継ぐ。
  - P1「Test Forum の終局照合」は FS-17 と FS-18 で扱う。
  - P2「escalation intake」は FS-35 で扱う。
- 「ended の履歴は消さず、照会の境界で絞る」という方針は、2026-10-11 の監査と同じにする。

## 2. 観測

### データと DB の状態 [確]

- `concordia.db` は 1.97GB (page_count 482,499、4KB ページ)。表は172個、索引は351個。SQLite は 3.53.4、better-sqlite3 は 13.0.3。
- 統計はまったく無い。
  - `sqlite_stat%` の表が0個ある。
  - src と `node_modules/@ludiars` には、`ANALYZE`・`PRAGMA optimize`・`INDEXED BY`・`NOT INDEXED` の呼び出しが無い (Grep で確認)。
  - 夜間の処理 (`src/db/nightly-vacuum.ts:43-53`) がしているのは、checkpoint と VACUUM だけ。
- 主な表の規模:

| 表 | 規模 |
|---|---|
| `session_events` | 約19.7万行 (rowid 91,966〜288,755)。inject 47,844行、prompt 22,031行、user_activity 32,528行。索引は `(session_id, ts)`・`(kind, ts)`・`(ts)` の3本だけ |
| `sessions` | 約3,950行 (active 20 / ended 3,929)。metadata は合計約35MB、1行あたり15〜100KB |
| `blackbox_decisions` | max(rowid) 73,678。gate の domain が72,644行。行を刈る処理が無い |
| `cost_one_shot_calls` | 約877MB、51,365行 |
| `transcript_logs` | id で約429万 |
| `harness_session_audit` | 約9.4万行 |
| `discord_session_channels` | 本社の scope で4,712行 |
| `discord_config` | 12,204行 |

- live の DB には、2026-11-21T14:24:04Z に migration version 150 が当たった。新しい migration は151から始まる。

### 停止 [確]

- `cc-live.jsonl` の末尾30MB (15時間分) で、`event loop stalled` が2,460回出ていた。
  - 長さは中央値1.7秒、p90 4.9秒、最大175秒。
  - 最大の175秒 (2026-11-20T23:26:29Z〜23:29:24Z) は、前後のログが空白なので、ホストのスリープだった可能性がある [推]。
- 停止の行に「処理中」として載っていた要求 (要求の件数ではなく、載った行の数):

| 要求 | 載った行の数 |
|---|---|
| `GET /v1/usage-budgets/users` | 3,605 |
| `GET /v1/usage-budgets` | 3,510 |
| `POST /v1/harness/gate` | 774 |

- 2026-11-19T07:16〜11-21T13:53 の約54.6時間で、1秒以上の停止が3,405件、合計8,032秒あった。
  - 1時間あたりに直すと約62回・約147秒になる [推: 割り算]。
  - この期間には、2f635e65 で直す前の時間帯も入っている。
- 予算集計の停止:
  - 2f635e65 (11/21 05:23Z、single-flight と memo の導入) より前は、03:38〜04:39Z の61分のうち3,207秒 (88%) 止まっていた。
  - 直した後も、11:23Z の集計は7.7分かかった。その10分間に266秒 (44%) 止まり、停止148件のうち121件はこの要求の実行中だった。
  - いま集計を起こしているのは、Staff 画面の `GET /v1/usage-budgets` と `/users` だけ。約56時間で36回と31回呼ばれている。
- 夜間の VACUUM (28夜分):
  - 普段は32〜67秒、外れ値は313.9秒と492.5秒。停止の lag は 313,634ms と 462,706ms だった。
  - 回収できた量は最大でも3.47%。11-12 は `database or disk is full` で失敗した。
- 再起動は24時間に9回あった。

### 1回あたりの同期の塊 (主なもの)

| 処理 | 周期・きっかけ | 1回の塊 | 出典 |
|---|---|---|---|
| 予算集計 (`GET /v1/usage-budgets`・`/users`) | Staff 画面からの取得 | 直した後も10分で266秒止まる [確]。1回あたり75〜365秒の同期処理 [推] | FS-05 |
| harness gate の DB の部分 | ツールの実行ごと (24時間で1,446回) | listRecent 0.5〜1.15秒 + 予算の判定 0.18〜0.3秒。間に I/O が無いので1つの塊になる [確] | FS-11、FS-06 |
| stat の tick | 60秒ごと | 1.8〜1.9秒 [確] | FS-02 |
| reaper | 5分ごと | 0.81〜1.07秒 [確] | FS-23 |
| 本社の session-forum の照合 | 10分ごと + 起動時 | 1.4〜1.9秒 [確] | FS-16 |
| 本社の test-forum の照合 | 5分ごと | 1.4〜1.7秒 [確] | FS-17 |
| sweeper | 60秒ごと | 0.3〜0.4秒 [確] | FS-22、FS-35 |
| `GET /v1/delegation/runs` | Lictor の接続ごと | 0.6〜2.2秒。再起動直後の最悪の1分は24回で29.5秒 [確] | FS-13 |
| 夜間の VACUUM | 毎日 03:00 JST | 32〜492秒 [確] | FS-36 |

**停止との時刻の相関** [確] (因果関係は [推]):

| 処理 | 停止が近くにあった割合 | 時刻をずらした基準 |
|---|---|---|
| 本社の session-forum 照合 | 98% (±7秒以内) | 20.8% |
| 本社の test-forum 照合 | 88% (±7秒以内) | 20.8% |
| gate の audit の書き込み | 28.7% (1.5秒以内) | 7.2% |

## 3. 規則

### CC-SCAN-01 索引の列は「等値の列 → 範囲・並びの列」の順にし、統計が無くても決まる形にする (CC-NODE-06)

- **決まり**
  - 対象は、大きい表 (目安は1万行以上か、追記され続ける表) を、要求経路や10分以内の周期処理から引く SQL。
  - その索引は、WHERE の等値条件の列をすべて先頭に並べ、範囲の列と ORDER BY の列をその後ろに置く。例: `session_events(session_id, kind, ts)`。
  - 選択度の低い列で始まる索引 (`(kind, ts)` など) や、ORDER BY の列を含まない索引 (`(domain, created_at)` に `ORDER BY id` を当てる形) は作らない。すでにあるものは置き換える。
  - sqlite_stat1 が無くても、正しい索引が1つに決まる形にする。
  - 書き込みの transaction の中では、索引で引けない照会を流さない。
- **理由**
  - 統計の無い DB で、planner が `idx_events_kind (kind=?)` を選んでいた。1回に105〜300ms かかっていた (FS-01)。
  - `(domain, created_at)` の索引は `ORDER BY id DESC LIMIT 50` の役に立たず、7.26万行を並べ替えていた (FS-11)。
  - `updateRunStatus` は、書き込みロックを持ったまま sessions の全行を走査していた (FS-14)。
- **確かめ方**
  - EQP の回帰テストを置く。migration を当てたメモリ DB で、対象 SQL の EXPLAIN QUERY PLAN について次を固定する (`src/db/transcript-logs-repo.test.ts:38-46` と同じ方式)。
    - 期待した索引の名前が出る。
    - `SCAN <大表>` と `USE TEMP B-TREE FOR ORDER BY` が出ない。
  - テストは、統計の無い状態と、代表的な sqlite_stat1 を入れて `ANALYZE sqlite_schema` で読み直させた状態の2通りで回す。
  - 統計が無い今は、メモリ DB の計画と live の計画が一致する (既存のクエリ37本で一致を確認済み [確])。
  - 提案: 大表の一覧を持つ。repo のテスト中に prepare された SQL を集めて EXPLAIN にかけ、許可リストにない大表の SCAN が出たらテストを落とす。

### CC-SCAN-02 計画は単項の `+` で決め、`INDEXED BY` で縛らない

- **決まり**
  - 使わせたくない索引があるときは、その列に単項の `+` を付ける。例: `+kind = ?`、`GROUP BY +service`、`+status = 'ended'`。
  - `INDEXED BY` と `NOT INDEXED` は使わない。
  - 例外にしてよいのは、次の (a) と (b) を両方満たすときだけ。そのときは理由を SQL の横に書き、EQP テストで固定する。
    - (a) 指名する索引が全環境にすでにあり、同じ PR で作るものではない。
    - (b) `+` では、統計を入れた状態の EQP テストで計画が決まらない。
- **理由**
  - `INDEXED BY` は、索引が無いと prepare が `no such index` で失敗する。より良い索引ができた後も古い索引を使わせ続け、COVERING の効果を消してしまう (FS-01)。
  - `NOT INDEXED` は、データの分布によって速さが変わる。intent の domain (0行) では全件 SCAN になり、184〜648ms かかった (FS-11)。
- **確かめ方**
  - src を Grep するテストを置き、`INDEXED BY` と `NOT INDEXED` が許可リストの外に無いことを固定する。
  - `+` を付けた SQL は、CC-SCAN-01 の EQP テストに入れる。

### CC-SCAN-03 一覧は SQL で上限を切り、本文の列は返す行だけ読む (CC-NODE-01)

- **決まり**
  - LIMIT は SQL で切る。JS の `.slice(0, N)` や `.filter` の前に全件を読まない。
  - API の `limit` と `since` は、上限と下限に丸める。
  - 一覧と周期処理では、本文の列を全行ぶん読まない。本文の列とは、`sessions.metadata`、`session_events.payload`、`cost_one_shot_calls.prompt`、`rendered_prompt`、`bullets`、transcript の payload を指す。
  - 先に索引の順で id と必要な列を決め、返す行の本文だけを PK で引く。
  - `SELECT *` を並べ替え (TEMP B-TREE) に載せない。
  - 画面向けには、2MB (`src/shared/http-cache.ts:21` の保存上限) 未満に収まる opt-in の形 (`?view=slim` など) を用意する。既定の応答の形は変えない。
- **理由**
  - かかる時間は、JSON の解析ではなく、本文をページから読み出す量で決まる。
    - metadata より後ろにある列だけを全行読むと29〜42ms で済む。
    - `json_extract` を `LIKE` や `instr` に替えても、281〜319ms が342〜429ms になるだけで速くならない (FS-22)。
  - `listSessions({},200)` は全行の metadata を並べ替えに積むので0.45〜0.5秒かかる。id と started_at だけなら11〜30ms (FS-26)。
  - `/v1/work/conversations` は応答が3.6〜4.1MB あり、114回すべて HTTP キャッシュに入らなかった (FS-30)。
- **確かめ方**
  - API のテストで、limit と since が丸められることを確かめる。
  - 一覧を返す repo メソッドの戻り型を `Pick<...>` にする。
  - EQP テストで、TEMP B-TREE が出ないことを確かめる。
  - http ログの `skip-size` を経路ごとに数え、画面向けの経路では0にする。

### CC-SCAN-04 JSON 列のキーで行を探すときは、json_valid で守った式索引を使う (CC-NODE-06)

- **決まり**
  - JSON 文字列 (`sessions.metadata` など) のキーで行を探すときに、WHERE に `LIKE '%..%'` や守りの無い `json_extract` を置いて、全行を評価しない。
  - まず、PK や既存の列で引ける側から対象の集合を作る。例: 表示する run の `child_session_id`。
  - キーで引くしかないときは、`CASE WHEN json_valid(metadata) THEN ... END` で守った式索引を、番号付きの migration で張る。少数の行にしかないキーには、部分索引 (`WHERE <式> IS NOT NULL`) を使う。
  - migration の中の式はリテラルで書き、照会の側でも字句まで同じ式を使う。
  - 最後の判定は今の JS の関数に残す。SQL での前絞りは、JS の判定と同じか、それより広くする。
  - 実列に上げる方式 (同じ UPDATE で列も書く) は採らない (3.1 の4)。
- **理由**
  - 親を指定した委託の照会は、式索引を張ると1,044〜1,070ms が3.2〜5.4ms になった。結び付く session の集合は、上限なしで作った正解と比べて差が0だった (FS-13)。
  - 壊れた JSON の行が1行あり、守りの無い `json_extract` はエラーで落ちる (FS-13)。`findSessionBySpawnId` には今その守りが無い (FS-25)。
- **確かめ方**
  - EQP テストで、照会の計画に式索引の名前が出ることを確かめる。
  - 壊れた JSON (`'{not json'`) の INSERT と UPDATE が成功することを確かめるテストを置く。
  - 代表的なデータで、SQL の前絞りと JS の判定の結果を突き合わせるテストを置く。
  - 式索引を足す PR では、metadata の UPDATE 1回あたりの増分を DB の複製で測り、PR に書く。

### CC-SCAN-05 1件ずつ引かず、照合の最初にまとめて引く (CC-NODE-01)

- **決まり**
  - ループの中で、1件ずつ SQL・`findX`・`JSON.parse`・ファイル読みをしない。
  - 照合の最初に1回だけ読み、Set か Map にする。キーの正規化は、JS の1つの関数 (`prKey` など) にそろえる。
  - DB をまとめて引くときは、`IN (SELECT value FROM json_each(?))` か JOIN の1本にする。
  - 1つのリクエストの中で、同じ行を何度も `SELECT *` や `JSON.parse` しない。読んだものは引数で渡す。ただし、自分で書いた後は読み直す。
  - 外部の一覧 (Revisor など) や、Discord の全チャンネル・全アクティブスレッドの取得は、1回の照合につき1回にする。runtime をまたいでも共有する。
- **理由**
  - `hasRecordedPr` を2,239回呼ぶと1.4〜1.7秒かかる。Set にすると11.8ms になる (FS-17)。
  - `readSessionRelay` を4,201回呼ぶと1.9秒かかる (FS-16)。
  - gate は1回で同じ sessions 行を7〜8回読んでいる (FS-12)。
- **確かめ方**
  - prepare か repo の呼び出しを数えるテストを置き、対象の件数 N を変えても SQL の実行回数が変わらないことを確かめる。

### CC-SCAN-06 重い読み出しの前に、結果を変えない安い条件で抜ける

- **決まり**
  - 集計や判定では、DB の行・transcript・JSON の解析の前に、安い条件で抜ける。安い条件の例: 予算があるか、帰属先があるか、記憶済みか、観測された対象があるか、scope が空か。
  - 抜けてよいのは、抜けても結果が同じだと示せるときだけ。
  - 結果が変わる近道は採らない。反例: 予算が0件のときに `offerBudgetResumes` を省くと、予算を消した後に残った中断に再開の案内が出なくなる。`isResumable(null)` が true だからである (FS-24)。
- **理由**
  - 予算が0件でも、gate のたびに0.18〜0.35秒を使っていた (FS-06)。
  - 予算集計は、帰属先を確かめる前に537本すべてに eventsByKind を投げていた (FS-05)。
  - reaper は、観測されたプロセスが0件でも DB を全部読んでいた (FS-23)。
- **確かめ方**
  - 前提が0件のときに重い repo メソッドが呼ばれないテストと、抜けなかった場合と結果が同じであるテストを、対にして置く。

### CC-SCAN-07 定期処理は変化分だけを読み、照合ではずれだけを SQL で返す (CC-NODE-01)

- **決まり**
  - 単調に増える id (AUTOINCREMENT の rowid) を watermark にし、`WHERE id > ?` の範囲だけを読む。
  - 遡り窓 (直近24時間など) を読むのは、起動後の1回だけにする。
  - watermark が0や null のまま範囲を読まない。
  - DB と外部の状態の照合では、ずれている行だけを索引で返す1本の SQL で対象を決める。
  - 変化がほとんど無い照合はイベント駆動を主にし、周期の照合は取りこぼしを拾う保険として間隔を延ばす。
  - ただし、照合が後始末を担っている対象は、絞り込みで外さない。例: `endDiscordSessionChannels` は DB だけを閉じ、Discord の archive をこの照合に任せている。
  - 周期処理は1回ごとに、`durationMs`・対象の件数・変化の件数をログに出す。
- **理由**
  - escalation intake は、本物の宣言が0件なのに、毎分3.8万行・13.7MB に LIKE をかけていた (FS-35)。
  - 本社の session-forum 照合は、24時間140回のうち変化があったのが13回だけだった。子会社の420回はすべて変化0だった (FS-16)。
  - id の範囲を0から読むと、表の全体をなめて298ms かかる (FS-35)。
- **確かめ方**
  - 2回目の実行で読む id の範囲が、前回より後だけになることを確かめるテストを置く。
  - 照合のログに3つの項目が出ることをテストで確かめる。
  - ログで変化0の周期の割合を見て、周期を見直す。

### CC-SCAN-08 ファイルは追記分だけを読み、終わったものは確定値で持つ (CC-NODE-01)

- **決まり**
  - 追記されるファイルは、(path, size, mtimeMs, offset) の状態を持って追記分だけを読む。size が offset より小さくなったときと、path が変わったときは作り直す。
  - ファイルごとに in-flight の Promise を持ち、同時に来た読み出しを1本にまとめる。
  - 終わったセッションの集計は DB に確定値として残し、再起動のときに読み直さない。
  - ディレクトリ全体を読む処理は、(名前, mtimeMs, size) のキャッシュを持ち、変わったものだけを読み直す。
  - 外部コマンドの起動を、件数の分だけ繰り返さない。
- **理由**
  - 解析には約7.3ms/MB かかる。再起動のたびに、予算で315MB、monitor で531MB を読み直し、cost チャンネルでは4重に読んでいる (FS-07、FS-08)。
  - セッションを登録するたびに、session-logs の619ファイルを全部読んでいる (AS-02)。
  - 1回の数え直しで git を約6,660回起動する (AS-03)。
- **確かめ方**
  - 同じファイルを2回読ませ、2回目に読んだバイト数が追記分だけであることを確かめるテストを置く。
  - 新しいインスタンス (再起動に相当) で、確定済みのセッションのファイルを開かないことを確かめるテストを置く。

### CC-SCAN-09 同期の塊は区切る (CC-NODE-01)

- **決まり**
  - I/O を挟まないループは、約8ms か決まった件数ごとに `await new Promise(r => setImmediate(r))` で処理を譲る。await が microtask しか待たないループも、これに含める。
  - 要求経路の重さは、経路全体の同期時間の合計で見積もる。gate なら、budgetGate・decideGate・audit.record の合計。
  - 1つの塊は50ms 以下を目安にする (暫定。5章)。
- **理由**
  - 予算集計は、memo が温まると482本の処理が microtask だけでつながり、1つの塊になる [推] (FS-05)。
  - gate では、budgetGate と decideGate が1つの塊になっている (FS-11)。
  - await があっても、待つ相手がキャッシュ済みなら処理は譲られない。
- **確かめ方**
  - N 件を回すループで、setImmediate が期待した回数だけ呼ばれることをテストで確かめる。
  - 提案: 周期処理の計時ログに、区切りごとの最長時間 (`maxBlockMs`) を出す。
  - 本体の pid に絞った `event loop stalled` のログを見る。

### CC-SCAN-10 重い集計は前回の値をすぐ返し、裏で1本だけ数え直す

- **決まり**
  - 時間のかかる集計の値は、stale-while-revalidate と single-flight で返す。
  - TTL は集計の完了時刻から数え、集計にかかる時間より長くする。
  - 判定 (gate など) に使う値は、許す古さの上限を決めてから使う。
  - これは、優先順位表の P2 にある「重い集計値は前回値と取得時刻で返してよい」を実装するときの決まりである。
- **理由**: TTL の起点が集計の開始時刻 (`src/cost/usage-budget-tracker.ts:124`) になっている。Staff 画面は完了の60秒後に次を取りに来るので、集計が2分を超えると数え直しが途切れずに続いていた (FS-05)。
- **確かめ方**
  - 同時に来た呼び出しが1本の集計にまとまることをテストで確かめる。
  - TTL が完了時刻から数えられることをテストで確かめる。

### CC-SCAN-11 保守処理は O(1) の指標で要否を決め、DB 全体に比例する処理を本体で走らせない (CC-NODE-06)

- **決まり**
  - VACUUM・checkpoint の TRUNCATE・ANALYZE は、先に O(1) の指標 (`freelist_count / page_count` など) で効果を見積もる。閾値に届かなければ実行せず、見送ったことをログに出す。
  - DB 全体の大きさに比例する処理 (一括の VACUUM、上限の無い ANALYZE) は、本体のプロセスでは走らせない。
  - 必要なときは、Concordia を止めた保守の時間に、Excubitor の peer operations を通して行う。
  - 統計は、`PRAGMA analysis_limit=400` を付けた `PRAGMA optimize` でだけ更新する。
  - 初回の統計は夜間に作る。openDb では、sqlite_stat1 がすでにあるときだけ optimize を打つ。
- **理由**
  - 夜間の VACUUM は32〜492秒止めるのに、回収できるのは最大3.47% だった (FS-36)。
  - worker や別の接続に移しても解決しない。VACUUM は終わるまで書き込みロックを持ち続け、本体の書き込みは busy_timeout の5000ms の間、同期で待たされるからである。これは CC-NODE-06 の「プロセス分割だけで共有 DB の競合が解消したと判断しない」に当たる例である。
- **確かめ方**
  - 閾値未満のときに見送ることをテストで確かめる。
  - 見送りと実行のログに、`free_ratio`・`freelist_pages`・`page_count` と、optimize の所要時間を出す。

### CC-SCAN-12 索引は番号付きの migration で足し、作る時間と書き込みの増分を先に測る (CC-NODE-06)

- **決まり**
  - Concordia が持つ表の索引は、`src/db/schema.ts` の MIGRATIONS の末尾に番号付きで足す。あわせて次を更新する。
    - `SCHEMA_VERSION` (`:14`)
    - `src/db/migration-ledger.ts` の FROZEN_MIGRATIONS
    - SCHEMA_FINGERPRINT
  - 適用済みの migration と、baseline の STATEMENTS (`schema.ts:79-80` など) は書き換えない。書き換えると checksum が合わず、起動できなくなる。
  - 外部パッケージが持つ表 (`blackbox_*`) の索引は、持ち主の ensure 処理 (`ensureBlackboxSchema`) を正本にする。Concordia の側では、同じ名前・同じ列で `CREATE INDEX IF NOT EXISTS` を流す。
  - 同じ名前の索引の定義は1つにする。`IF NOT EXISTS` は、後から来た定義を黙って無視するからである。
  - 索引は昇順で張り、`ORDER BY ... DESC` は索引を逆向きに読ませて満たす。DESC を使うのは、並びの向きが混ざるときだけにする。
  - 本文の overflow を全行読むことになる索引 (例: `cost_one_shot_calls` の被覆索引) は、起動時の migration に入れない。
  - 索引を足す前に、DB の複製で作成時間を測り、書き込み1件あたりの増分 (更新される列を含む索引かどうか) を見積もる。どちらも PR に書く。
  - 未反映の migration は、すべて1つの `BEGIN IMMEDIATE` の中で続けて走る (`src/db/migrator.ts:36-72` で確認 [確])。version を分けても、同じ反映の中ではロックは短くならない。重いものを分けたいときは、反映 (再起動) を分ける。
- **理由**
  - 起動時に作る索引の重さの見積もり: FS-01 の索引は live で3〜6秒 [推]、FS-13 の式索引は約1秒 [推]。busy_timeout は5000ms (`schema.ts:1153`)。
  - 確認結果には、同じ名前で定義の違う索引の提案があった (3.1 の5)。
- **確かめ方**
  - migration-ledger の既存のテストを通す。
  - 提案: sqlite_master の sql を比べ、同じ名前の索引の定義が1つであることを確かめるテストを置く。
  - PR に、DB の複製で測った作成時間を書く。

### CC-SCAN-13 Web の取り直しは1本にまとめ、表示に効くイベントでだけ引く (CC-NODE-01)

- **決まり**
  - WS のイベントで一覧を取り直すときは、取得中のものとの合流と、末尾1〜2秒の debounce をかける。
  - きっかけにするのは、表示に効くイベントの種類だけにする。許可リストは1か所に置く。
  - payload に id があるときは、その1件だけを差し替える。
- **理由**: Monitor を表示している間は、session.event (毎分2〜3回) と stat.collected (毎分約2.2回) のたびに、0.45〜0.6秒と0.16〜0.19秒の計算が走る。表示中は毎分1.5〜2秒になる [推] (FS-28)。
- **確かめ方**
  - 許可リストをテストで固定する (表示に使う項目と kind の対応)。
  - hook の合流と debounce をテストで確かめる。

### 3.1 確認結果どうしの食い違いと、この方針での決め方

1. **FS-01 の「予算集計で毎分20〜30秒」は採らない。**
   - 予算が0件のとき、`sweepNotices`・`status`・`cachedStatus` は集計の前に返る (`usage-budget-tracker.ts:215-216, :223-224, :238-239`)。
   - 集計を起こすのは、`GET /v1/usage-budgets` と `/users` だけである [確]。
   - gate のたびにかかる費用は、集計ではなく attributionFor の分である (FS-06)。
2. **FS-06 と FS-12-budget は、同じ箇所を同じ方法で直す内容なので、FS-06 にまとめる。**
3. **FS-05 (7)「予算が0件なら offerBudgetResumes を呼ばない」は採らない。** CC-SCAN-06 の反例に当たる。FS-24 の式部分索引で直す。
4. **metadata のキーで引く方式は、式索引に決める (CC-SCAN-04)。**
   - 理由 (a): 式索引は、どの書き手が書いても追従する。別のプロセス、古い build、生の SQL を流すテストのどれでもよい。
     - 実列の方式では、SessionsRepo を通った書き込みだけが列を更新する。
     - いま、26日前に起動したままの control-worker (pid 26744) が動いている [確: プロセス一覧]。Concordia のものかどうかは、コマンドラインからの推測である。
     - 点検での指摘「どちらの方式も setMetadata だけに頼る」は、実列の方式にだけ当てはまる。
   - 理由 (b): 実列の方式では、全行の書き直しが migration のロックの中に入る。複製では約3秒かかり、WAL が約60MB 増えた。式索引の作成は読むだけで済む。
   - 理由 (c): 式索引には実測がある (FS-13)。
   - 代償: metadata の UPDATE 1回が、索引2本で0.23ms から0.42ms になった [確: メモリ上の写し]。本数に比例するなら、6本で +0.6ms 前後になる [推]。
     - P2 で式索引を足す前に、metadata の UPDATE の回数を測る。増分が問題になる場合は、実列の方式を考え直す。
   - 生成列 (VIRTUAL) は採らない。書き込みが +0.6ms/回で、統計が無いと部分索引が選ばれず985ms かかった [確]。
5. **索引の定義は昇順にそろえる。**
   - sessions:
     - `idx_sessions_started(started_at, id)`
     - `idx_sessions_status_started(status, started_at, id)`
     - `idx_sessions_team_started(team_id, started_at, id)`
   - delegation_runs:
     - `(finished_at, child_session_id, status)` の部分索引
     - `(spawn_branch, created_at)`
   - その他:
     - `session_reports(generated_at)`
     - `chat_messages(ts, id)`
     - `rule_runs(created_at, run_id)`
6. **`INDEXED BY` の扱い。**
   - FS-28 (2) のつなぎの `INDEXED BY` は使わない。FS-01 の索引のほうが先に入るので、つなぎが要らない。
   - FS-33 は、まず `GROUP BY +service, provider` を試す。統計を入れた EQP テストで ts の範囲索引が選ばれない場合だけ、CC-SCAN-02 の例外として `INDEXED BY idx_cost_one_shot_calls_ts` を使う。
7. **統計 (FS-04) と VACUUM (FS-36) の順序。**
   - optimize は、VACUUM を見送るかどうかの判定より前に置く。後ろに置くと、見送る夜には一度も走らない。過去28夜はすべて見送りになる値だった。
   - 統計を入れる PR は、統計を入れた版の EQP テストがそろってから出す。統計が入ると、「メモリ DB の計画が live と一致する」という前提が崩れるからである。
8. **migration の番号。**
   - 本書の151以降の番号は仮である。
   - 実装に着手するときの main の `SCHEMA_VERSION` の次から振り、並行するブランチと番号が重ならないか確かめる。
9. **ログから数えた件数。**
   - テストのプロセスが、本番と同じ `cc-live.jsonl` に書き込んでいる [確: pid 82444、88584 など]。
   - FS-15 の「25回」は、本体の pid だけで数えると10回になる。
   - FS-23 の106回と FS-03 の2,430回は、本体の pid のものだけだと確かめた。
   - そのほかの件数は、pid で数え直していない。今後の計測は本体の pid に絞って行う。
10. **DB を開いているプロセス。**
    - 確認結果では、openDb を呼ぶのは5プロセスとされていた。いま動いているのは、本体と control-worker の2つである [確: プロセス一覧]。
    - cost-worker は止まっている。起動のたびに `cost-worker lease expired` が出ている。
    - migration のロックとぶつかる相手は、`control_jobs` を500msごとに `BEGIN IMMEDIATE` で claim する control-worker である (`src/db/control-jobs-repo.ts:95-127`)。

## 4. 直す箇所

P0 から順に並べる。「止める時間」は、1回あたりの同期の塊、またはそれに相当する時間である。

| ID | 箇所 | 何が全件か | 頻度 | 止める時間 | 直し方 | 優先度 |
|---|---|---|---|---|---|---|
| FS-01 | `src/db/sessions-repo.ts:538-544` eventsByKind、`:546-566` latestEventsByKind、`:572-581` lastEventTsByKind、`src/bootstrap/core.ts:2272-2274, :2315-2317` | (session_id, kind) で引く照会が `idx_events_kind(kind, ts)` を選び、その kind の全期間の行 (inject 47,844・prompt 22,031) を読む | 予算集計・gate・stat の tick・reaper (`src/control-session/reaper-facts.ts:183-185`)・`src/control/idle-nudge.ts:157`・`src/api/prs.ts:327`・monitor | [確] 1回 105〜300ms。複製に索引を張ると eventsByKind ×20 が24ms | `session_events(session_id, kind, ts)` を足し、`idx_events_kind` を消す (migration 151)。eventsByKind と lastEventTsByKind を `ORDER BY ts DESC, id DESC` にする。この4本と core.ts の2本を EQP テストで固定する | P0 |
| FS-02 | `src/stat/scheduler.ts:61-101` (:89) | active の全件について、prompt の全行を1つの macrotask で読む | 毎分 | [確] 1塊 1.8〜1.9秒。複製では5ms 未満 | FS-01 の索引で直る。EQP テストに COVERING を入れる | P0 (FS-01 に含む) |
| FS-05 | `src/cost/usage-budget-tracker.ts:104-106, :124, :138-143, :160-162, :193-197`、`src/api/usage-budgets.ts:66-75`、`src/bootstrap/core.ts:690-694` | 帰属先と memo を確かめる前に、今月の全セッション (538本) に attributionFor → eventsByKind をかける。listSessionsInRange は SCAN + TEMP B-TREE で metadata を7.86MB 読む | Staff 画面の `GET /v1/usage-budgets` と `/users`。[確] 約56時間で36回・31回 | [確] 直した後も10分で266秒 (44%) 止まり、1回に7.7分かかった。[推] 1回 75〜365秒の同期処理 | 帰属先 → memo → attributionFor の順にする。予算が0件なら集計しない。SWR にし、computedAt を完了時刻にする。[P1] 約8msごとに譲る。予算用に列を絞った repo を作る (started_at の索引は FS-26)。[P2] settle 済みの按分を DB に確定値で残す | P0 |
| FS-06 (FS-12-budget を統合) | `src/cost/usage-budget-gate.ts:52-57`、`src/api/harness-session.ts:360`、`src/api/register-core.ts:897` | 予算が0件でも、gate のたびに eventsByKind で inject の全行を読み、結果を捨てている | gate ごと。[確] 24時間で1,446回 | [確] 1回 0.18〜0.35秒 (p50 261ms) | readSuspension の後で、予算が1件も無ければ deny:false を返す (`hasAnyBudget()`。予算を書いたらキャッシュを捨てる)。[P1] 予算があるときは新しい順に iterate し、最初の有効な印で止める。cachedStatus を SWR にする | P0 |
| FS-11 | `node_modules/@ludiars/blackbox/dist/store-sqlite.js:192-195` listRecent、`src/harness/blackbox-engine.ts:382-383, :413-423, :429-440, :448-450`、`src/api/harness-session.ts:492` | `WHERE domain=? ORDER BY id DESC LIMIT 50` が `(domain, created_at)` の索引に乗り、gate の72,644行を TEMP B-TREE で並べ替える。/context は stats を得るために snapshot 全体を作る (listPending は最悪465ms) | gate ごと。/context ごと (24時間で363回) | [確] 1回 0.8〜1.15秒。複製では0.55ms | `blackbox_decisions(domain, id)` を、ensureBlackboxSchema と Concordia 側の IF NOT EXISTS の両方で張る。/context は stats だけを返す口にする。[P1] gate と intent のルール一覧をメモリに持ち、書き込みで捨てる | P0 |
| FS-13 | `src/db/sessions-repo.ts:173-180`、`src/api/delegation.ts:457-481`、`src/delegation/run-session-read-model.ts:26-48` | parent_session を指定しても、sessions の全行を LIKE で SCAN し TEMP B-TREE で並べる。1,000行・metadata 15MB を解析する | Lictor の接続ごと。再起動の直後に約20本が一斉に呼ぶ | [確] 1回 0.6〜2.2秒。最悪の1分は24回で29.5秒 | 表示する run の分だけを引く listDelegationSessionsForRuns を作る (child_session_id の PK、run_id の式索引、call_name の式索引 + started_at)。migration 152。結び付けの規則は変えない | P0 |
| FS-16 | `src/discord/session-channel.ts:204, :228-242`、`src/discord/bot.ts:1650, :1655` | 本社のチャンネル行4,712件すべてに readSessionRelay をかける (metadata 34MB の解析、findRun 2,332回) | 10分ごと + 起動時 | [確] 1塊 1.4〜1.9秒 | 各 pass の前に、状態のずれだけを返す SQL を1回流して Set にする (`listSessionStatusDrift`)。ended の行の archive の修復は外さない | P0 |
| FS-17 | `src/discord/test-forum-reconcile.ts:216-219`、`src/db/discord-test-surfaces-repo.ts:87-90` | 終局 PR 2,239件ごとに、`lower(repo_origin)` で scope の約4,000行をなめる | 5分ごと | [確] 1塊 1.4〜1.7秒。Set にすると11.8ms | 記録済みのキーを1回読んで Set にする (キーは `prKey`)。[P2] Revisor から差分だけを取る | P0 |
| FS-36 | `src/db/nightly-vacuum.ts:43-49` | DB 全体 (1.97GB) の VACUUM を本体で同期に実行する。回収は28夜とも10%未満 (最大3.47%) | 毎日 03:00 JST | [確] 32〜492秒 (28夜の平均72秒)。11-12 は容量不足で失敗 | 空き率が10%未満なら見送る (checkpoint の TRUNCATE もしない)。超えた日も本体では VACUUM せず、warn を出して保守の時間に回す | P0 |
| FS-03 | `src/bootstrap/core.ts:2280, :2323`、`src/control-session/reaper-facts.ts:183-185` | 親の inject の全行に、1行ずつ json_extract をかける | control の tick (毎分)。patrol の TypeError を直すと、子1本につき最大2回になる | [確] 子1本 114ms。索引に乗せると0.34ms | FS-01 の索引で直る (SQL は変えない)。EQP テストに入れる。patrol を直す PR で、EQP を確かめてから戻す | P1 (FS-01 で解消) |
| FS-04 | `src/db/nightly-vacuum.ts`、`src/db/index.ts:20` | 統計 (sqlite_stat1) が無く、planner が選択度を知らない | — | 直接は止めない。[推] 初回の ANALYZE (上限400) は2〜3秒 | 夜間に `analysis_limit=400` と `optimize=0x10002` を、VACUUM を見送るかの判定より前に打つ。openDb では stat1 があるときだけ打つ。統計を入れた版の EQP テストがそろってから入れる | P1 (段階 S3) |
| FS-10 | `src/subsidiary/budget.ts:57-58, :87-92`、`src/subsidiary/gate.ts:124`、`src/api/subsidiary.ts:135` | 子会社ごとに sessions を SCAN する (5回)。単位の誤り (ms の値を秒の列と比べる) のため、今は0行しか返らない | Monitor の表示中、8秒ごと | [確] 1要求 7〜70ms。[推] 単位だけ直すと、transcript の全体読み ×5 が加わる | 単位を直すのと同じ PR で入れる: budget が0以下なら数えない、全子会社の分を1回の SQL で取る、60秒の共有キャッシュを置く。超過判定が効き始めるので、運用に一報する | P1 |
| FS-14 | `src/db/sessions-repo.ts:183-217`、`src/db/delegation-repo.ts:1023-1041` | run 1件の session を OR の条件で探し、sessions の全行を SCAN する。updateRunStatus は書き込みの transaction の中で全行に json_extract をかける | `GET /runs/:id` が約2日で372回。終端の報告ごと | [確] 0.35〜0.45秒 / 0.32〜0.39秒 | OR を UNION にし、FS-13 の式索引で引く (400件で結果の差は0) | P1 |
| FS-22 | `src/db/sessions-repo.ts:404-415`、`src/sweeper.ts:231-232` | ended の3,929行の metadata (34MB) を読んで印を探す。該当は0件 | 毎分 | [確] 0.19〜0.32秒 | session_end_pending_at の式部分索引で引き、`+status` と `+last_seen_at` を付ける。読み直しての判定は残す | P1 |
| FS-23 | `src/control/lost-session-process-reaper.ts:55-64, :116-121`、`src/control/reaper.ts:135-137, :199-200` | 1回の tick で listSessions を7回呼び、そのたびに同じ status の全行の metadata を TEMP B-TREE に積む | 5分ごと | [確] 1塊 0.81〜1.07秒 | 観測されたプロセスが0件なら DB を読まない (結果は同じ)。保護する集合は tick の初めに1回だけ作り、`(status, started_at, id)` の索引で200行の必要な列だけを読む。200件で打ち切ることの是非は、別に仕様で決める | P1 |
| FS-26 | `src/db/sessions-repo.ts:167-170` ほかの一覧、sessions の索引 | started_at の索引が無いので、一覧が全行を SCAN し、metadata ごと TEMP B-TREE に積む | Web の一覧、予算や個人予算などの周期処理 | [確] `listSessions({},200)` 0.45〜0.5秒。複製に索引を張ると60〜90ms | `(started_at, id)` と `(status, started_at, id)` を足し、重複している `idx_sessions_repo_active` を消す (migration 153)。metadata の要らない呼び出し元は、要約を返す口に替える | P1 |
| FS-30 | `src/api/work.ts:65, :77-100` | 1回の要求で `listSessions({})` を2回呼び、100セッション × 80フレームを返す。3.6〜4.1MB で HTTP キャッシュに入らない | 約55時間で114回 (呼び出し元は未特定) | [確] 1回 0.47〜2.4秒の1塊 | 1回目の結果を使い回す。チップの集計は軽い列で行う。metadata は返す分だけ読む。10セッションごとに譲る。[推] 1回 100〜150ms になる | P1 |
| FS-07 | `src/cost/log-usage.ts`、`src/cost/usage-timeline.ts:105-116`、`src/cost/windowed-usage-cache.ts` | transcript をファイル全体で読み直す (memo が無いか、変化があると全体を読む) | 予算集計と monitor のたび、再起動ごと (24時間に9回) | [確] 約7.3ms/MB。最大43MB のファイルで約0.3秒。[推] 再起動ごとに約7.6秒 | 時刻つきの点も、(path, size, mtime, offset) の差分で読む。ファイルごとに in-flight を持つ。約8msごとに譲る | P2 |
| FS-08 | `src/api/chat-read-models.ts:202-209, :236`、`src/cost/cost-report.ts:57`、`src/cost/org-cost.ts:109`、`src/cost/session-usage-cache.ts:161-183` | 4つの runtime が、cost-report と transcript をそれぞれ別に作る。monitor は7日窓を SCAN する | 10分ごと ×4 | [確] 平常時は10分あたり0.1〜0.3秒。[推] 再起動の直後に約5.3秒 | プロセス共通の single-flight にし、snapshot を共有する。ファイルごとに in-flight を持つ。タイマーの時刻をずらす | P2 |
| FS-12 | `src/api/harness-session.ts:245-250, :288-290, :473-474`、`src/harness/reliability/task-branch-service.ts:115-172` | 1回のリクエストで、同じ sessions 行を `SELECT *` で7〜8回、JSON.parse で6〜7回読む | gate ごと | [確] 4〜14ms | ハンドラの冒頭で1回読んで渡す (書いた後は読み直す)。1つのキーしか見ない読み出しは列を絞る | P2 |
| FS-15 | `src/delegation/finished-run-reaper.ts:89-96`、`src/db/delegation-repo.ts:659-668` | 終わった run 2,796件をすべて並べ替え、findSession を200回、parse を3回ずつ行う | 5分ごと | [確] 1塊 0.29〜0.35秒 | lictor の pid が観測されなければ DB に触らない。読む列を4つにし、部分被覆索引 (昇順) を張る。JOIN 1本にする | P2 |
| FS-24 | `src/db/sessions-repo.ts:392-401`、`src/bootstrap/core.ts:714-725` | budget_suspension を、全行に json_valid をかけて探す (該当0件) | 10分ごと | [確] 0.25〜0.28秒 (以前は最大0.52秒) | budget_suspension の式部分索引で引く。予算0件での省略はしない | P2 |
| FS-25 | `src/management/runtime.ts:44-46`、`src/db/sessions-repo.ts:161-164`、`src/bounty/pr-lookup-adapter.ts:38-40` | spawn_id・subsidiary_id・task の LIKE で全行を SCAN する | management の依頼が起動確認中の間、2秒ごと (今は0) | [確] 1回 0.24〜0.48秒 | spawn_id と subsidiary_id の式部分索引で引く (json_valid の守りも足す)。task は [P3] 小さな表を作って引く | P2 |
| FS-28 | `src/api/monitor.ts:45, :148-151`、`src/api/stat.ts:47-59`、`web/src/hooks/useWsEvent.ts:81-84`、`web/src/pages/Monitor.tsx:20-35` | ended の全行を並べてから20件に切る。stat は298件に findSession の N+1 をかけ、7.84MB になって HTTP キャッシュに入らない | Monitor の表示中、WS のイベントごと (毎分2〜3回と約2.2回) | [確] 0.45〜0.6秒 / 0.16〜0.19秒。[推] 表示中は毎分1.5〜2秒 | SQL で LIMIT 20 にする。latestEventsByKind はセッションごとの LIMIT 1 にする (FS-01 の後)。stat は JOIN と `?view=slim` にする。Web は CC-SCAN-13 に従う | P2 |
| FS-29 | `src/db/sessions-repo.ts:167-170`、`src/api/sessions/lifecycle.ts:414-417`、`src/api/sessions/category.ts:2-12`、`web/src/pages/session-chat/SessionChat.tsx:24-25` | `GET /v1/sessions` が全行を SCAN して TEMP B-TREE で並べ、分類で findRun の N+1 をかける | SessionChat の表示中、WS のイベントごと | [確] 1回 0.27〜0.9秒 | FS-26 の索引に加えて `(team_id, started_at, id)` を張る。run は IN の1回で引く。取り直しのきっかけを絞る | P2 |
| FS-31 | `src/api/taskflow.ts:79-93, :207-208`、`src/taskflow/overview.ts:106-108, :168-189` | recentRuns(1000) を本文ごと読み (3.8MB)、文書ごとに run 1000件と PR 500件を find する | Taskflow の表示中、30秒ごと (今は0回) | [推] 表示中は毎分約1秒 | 列を絞る (6ms)。事前に Map にする。5〜10秒の共有メモを置く | P2 |
| FS-32 | `src/db/sessions-repo.ts:628-632`、`src/api/reports.ts:80`、`src/daily/scheduler.ts:48-55`、`src/daily/aggregator.ts:80-126`、`src/api/daily.ts:19-23` | session_reports を全行 SCAN して TEMP B-TREE で並べる。limit に上限が無い。日報を1日に約12回作り直す | 一覧の表示時 (今は0回)。日報は4時間ごと | [確] 0.58〜0.84秒 (キャッシュが冷えていると12秒) | `session_reports(generated_at)` を張る。limit を1〜100に丸める。過去の日の作り直しをやめる (出力が変わるので合意してから) | P2 |
| FS-35 | `src/control/escalation-transcript-intake.ts:45-54`、`src/db/transcript-logs-repo.ts:376-391`、`src/bootstrap/core.ts:1960-1962` | 直近24時間の transcript 3.8万行・13.7MB に、毎回 LIKE をかける (本物の宣言は0件) | 毎分 | [確] 68〜122ms | id の watermark で差分だけを読む。24時間窓を読むのは起動後の1回だけ | P2 |
| AS-01 | `src/discord/session-status-card.ts:430-441, :466-481`、`src/discord/bot.ts:1788-1811, :1859` | 起動のたびに、消せないカード438〜454件を直列の REST で消しに行き、失敗して印を残す | 起動ごと | [確] 1回 264〜471秒。I/O の待ちなのでイベントループは止めないが、その間 active のカードが更新されない | `Thread is archived` を「もう消せない」とみなして印を消す。removed を正しく数える。active のカードの更新を先に回す | P2 |
| AS-02 | `src/api/sessions/lifecycle.ts:319-327, :421-436`、`src/control/collaboration-context.ts:135-140, :223-242`、`src/session-logs/reader.ts:121-153`、`src/session-logs/project-dictionary.ts:55-62` | セッションを登録するたびに、session-logs の619ファイル (7.86MB) を全部読み、120個の名前ごとに new RegExp を作る | `POST /v1/sessions` (約56時間で127回) | [確] 1回 wall 約1秒・CPU 約0.6秒 (25〜30ms ずつ) | (名前, mtime, size) のキャッシュと in-flight を持つ。RegExp を使い回す | P2 |
| AS-03 | `src/work/repo-scan.ts:147-223`、`src/work/repo-list-cache.ts:61-62` | 作業ルート直下で .git を持つ1,665項目 (うち linked worktree 1,525) に、git を4回ずつ起動する | `GET /v1/work/repos` (Work の表示中、30秒ごと。今は0回) | [推] 1回の数え直しで main thread を合計約138秒 (20ms ずつ) ふさぐ | linked worktree は親の `worktree list` の結果から作る。HEAD はファイルで読む。TTL を数分にする | P2 |
| FS-09 | `src/bootstrap/core.ts:1867-1874` | 2日窓を SCAN して metadata を解析する。対象が出ると、2分ごとに transcript を全体で読む | 2分ごと | [確] 35〜70ms (今は transcript を読んでいない) | SQL で対象を絞る。変化の無いセッションは readTotal を省く | P3 |
| FS-18 | `src/discord/bot.ts:1728` | 対象の無い子会社の runtime も、Revisor の一覧を処理する | 5分ごと | [確] 数 ms | scope が空 (関係する project も open の投稿も0件) なら取得しない | P3 |
| FS-19 | `src/discord/session-channel.ts:189-232`、`src/discord/taskworkflow-orphan-reconcile.ts:30`、`src/discord/bot.ts:1532-1534` | 1回の照合で、全チャンネルの取得を2回、アクティブスレッドの取得を3回行う。runtime が4つある | 10分ごと | [推] 毎分0.01〜0.05秒 (未計測) | まず計測する。照合の先頭で1回だけ取得して渡す | P3 |
| FS-20 | `src/discord/bot.ts:584-587`、`src/discord/egress.ts:104, :179, :193, :236`、`src/discord/forum-phase-sync.ts:9, :28-34` | イベントのたびに、4つの runtime がそれぞれ readSessionRelay を呼ぶ | イベントごと (約0.83件/秒) | [確] 1回0.43ms (毎分約0.08秒) | subsidiary_id だけを読む。relay state を引数で渡す | P3 |
| FS-21 | `src/discord/ingress.ts:544, :734-740`、`src/discord/channel-directory.ts:49` | discord_config の12,204行 (72%は空文字) を all() で読む | 1時間に数回 | [確] 30〜80ms | get() と接頭辞の範囲読みに替える。消すときは delete にする | P3 |
| FS-27 | `src/metrics/collector.ts:65-66`、`src/control/nudge-skip-record.ts:47-50` ほか | active のセッションを毎回 `SELECT *` で読む | 毎分約10回 [推] | [確] 1回 8ms | 列を絞る。FS-26 の索引で TEMP B-TREE が消える | P3 |
| FS-33 | `src/db/cost-one-shot-calls-repo.ts:138-140`、`src/api/cost.ts:182` | summarySince が service の索引に乗り、全5.1万行 (877MB) を読む | 呼ばれたとき (今は0回) | [推] 数秒 | ts の範囲で引く (3.1 の6)。since に下限を付ける | P3 |
| FS-34 | `src/db/harness-audit-repo.ts:98-117`、`src/api/harness-session.ts:612-613`、`src/db/chat-repo.ts:118-123`、`src/db/delegation-task-runs.ts:19-22`、`src/db/rule-runs-repo.ts:204-209` | 一覧が SCAN か TEMP B-TREE になる。audit の summary(0) は9.4万行を読む | 画面の表示時、委託の起動ごと | [確] 0.07〜0.45秒 (キャッシュが冷えていると最大33秒) | 索引を足す (昇順)。chat の limit を丸める | P3 |
| FS-37 | `src/db/transcript-logs-repo.ts:111-119, :316-325`、`src/bootstrap/core.ts:2235, :2282, :3167, :3212` | tsSpan が MIN と MAX を1つの文で取るので、セッションの索引の範囲を全部読む | 巡回ごと | [確] 20セッションで9〜42ms | MAX だけを取る lastTs を足す。tsSpan は MIN と MAX を別の scalar subquery にする。flushSync には観測だけを足す | P3 |
| AS-04 | `src/app.ts:92-115` (Actio 側は `modules/task/chat/runtime.ts:46`、`cycle.ts:15-65`) | Actio が30秒ごとに、全接続・全チャンネルを Concordia 経由で巡回する | [確] 毎分約71要求 | [推] Concordia 側で毎分0.07〜0.14秒。[確] cc-live.jsonl の行の70% を占める | ログに出すしきい値をパスごとに持たせる。Discord の gateway のイベントを転送する (Actio との2リポにまたがる) | P3 |
| AS-05 | `src/taskflow/actio-store.ts:30-39, :190-208`、`src/taskflow/state-store.ts:41-52` | 全 binding の Actio タスク約1,945件に、1件ずつ INSERT と SELECT をする | 10分ごと + `/tasks`・overview | [確] 79〜85ms | 既存の行を1回で Map にし、無い分だけを1つの transaction で書く | P3 |
| AS-06 | `src/harness/reliability/code-acceptance.ts:37-80`、`src/harness/ddd-evidence.ts:13-17, :54-73` | 変わったソース1件ごとに、domain の70ファイルを読み直す | commit と push の gate | [確] ソース100件で1.19秒 | 1回読んで使い回す | P3 |
| AS-07 | `src/rules/knowledge-runtime.ts:174-186`、`src/db/chat-knowledge-repo.ts:113-116`、`src/rules/knowledge-select.ts:44-92` | 返信のたびに、知識の断片1,331件をトークン化して df を作り直す | 返信ごと (今は0) | [確] 0.11〜0.15秒 | 書き込みで上がる世代番号ごとに、df をメモリに持つ | P3 |

## 5. 進め方

### 段階

LUDIARS の規則に従い、各段階は1つの PR にまとめる。P2 以降は量が多いので、着手する領域ごとにそれぞれ1つの PR にしてよい。migration の番号は仮のもの (3.1 の8) である。

| 段階 | PR に入れるもの | migration (仮の番号) | 反映するときの注意 |
|---|---|---|---|
| S1 (P0) | FS-01・02、FS-05 (1)(2)(4)、FS-06 (P0)、FS-11 (P0-a・P0-b)、FS-13、FS-16 (P0)、FS-17 (P0)、FS-36 (P0)。EQP の回帰テストの土台 (統計なしの版)。周期処理の計時ログ (durationMs・対象の件数・変化の件数) | 151: session_events の索引を足し、idx_events_kind を消す。152: sessions の委託のキーの式索引2本。blackbox の索引は、ensure と IF NOT EXISTS で起動後に1回張る (約0.35秒 [確: 複製]) | 下の「migration と索引の注意」に従う |
| S2 (P1) | FS-03 (EQP)、FS-05 (5)(6)、FS-06 (P1)、FS-10、FS-11 (P1)、FS-14、FS-22、FS-23 (1)(2)、FS-26、FS-30。統計を入れた版の EQP テスト | 153: sessions の並び用の索引2本、重複している索引の削除、session_end_pending の式部分索引 | sessions は約4千行なので小さい。FS-10 は挙動が変わるので運用に一報する |
| S3 (P1・統計) | FS-04 | なし (sqlite_stat1 は migration の外) | 初回の統計は夜間に作る。戻すときは `DELETE FROM sqlite_stat1` の後に `ANALYZE sqlite_schema` を実行する |
| S4 (P2) | FS-07・08・12・15・24・25・28・29・31・32・35、AS-01・02・03 | 154: delegation_runs の部分索引、`sessions(team_id, started_at, id)`、budget_suspension・spawn_id・subsidiary_id の式部分索引、`discord_session_channels(scope, status)`、`session_reports(generated_at)` | 式索引を足す前に、metadata の UPDATE の回数を測る (3.1 の4) |
| S5 (P3) | 残りの項目。計測で必要になったものから | 155 以降: harness_session_audit、chat_messages、`delegation_runs(spawn_branch, created_at)`、rule_runs、test_surfaces の lower の式 | — |

### 測り方と目標

- 目標の値は暫定のものである。CC-NODE の許容値 (まだ決まっていない) を運用担当が決めたら、そちらに置き換える。
- 停止の数は、`cc-live.jsonl` をストリームで集計して出す。
  - 本体の pid に絞る (テストのプロセスの行を除く)。
  - 起動直後の2分と、03:00 の保守の時間は除く。
  - 反映の前と後のそれぞれ24時間を、同じ曜日・同じ時間帯で比べる。

| 段階 | 測るもの | いまの値 | 目標 (暫定) | 測り方 |
|---|---|---|---|---|
| S1 | 1秒以上の停止 | 約62回/時・約147秒/時 [推: 3,405件・8,032秒 ÷ 54.6時間。2f635e65 より前の時間帯を含む] | 15回/時以下、30秒/時以下。1回の最長は5秒未満 | 上記の集計 |
| S1 | eventsByKind・lastEventTsByKind・parentReceivedRunTerminal の1回 | [確] 105〜300ms | 5ms 以下 | DB の複製での計時と、EQP テスト |
| S1 | stat の tick の1回 | [確] 1.8〜1.9秒 | 50ms 以下 | 計時ログ |
| S1 | gate の DB の区間 (budgetGate + decideGate) | [推] 0.7〜1.5秒 | 50ms 以下 | 計時ログ (LLM の時間を除いた区間) |
| S1 | `GET /v1/usage-budgets` (予算0件のとき) | [確] 1回で最大約37分 | 10ms 以下 | perf ログ |
| S1 | `GET /v1/delegation/runs` (parent を指定) | [確] p50 582ms。最悪の1分は29.5秒 | 1回50ms 以下。再起動直後の1分の合計が2秒以下 | perf ログ |
| S1 | session-forum と test-forum の照合の同期の区間 | [確] 1.4〜1.9秒 / 1.4〜1.7秒 | 100ms 以下 | 照合ログの durationMs と、同じ時刻の停止 |
| S1 | 03:00 JST の停止 | [確] 32〜492秒 | VACUUM を見送る夜は、1秒以上の停止が0回 | 夜間処理のログ |
| S2 | 1秒以上の停止 | S1 の後の値 | 3回/時以下、5秒/時以下 | 上記の集計 |
| S2 | reaper の1 tick と sweeper の1回 | [確] 0.81〜1.07秒 / 0.3〜0.4秒 | 150ms 以下 / 50ms 以下 | 計時ログ |
| S2 | `GET /v1/sessions` と `/v1/work/conversations` | [確] 0.27〜0.9秒 / 0.47〜2.4秒 | 100ms 以下 / 200ms 以下 (1つの塊は50ms 以下) | perf ログ |
| S3 | 統計を入れた版の EQP テストと、夜間の optimize | — | テストが通る。optimize が5秒以下 [推: 見積もりは2〜3秒] | テストとログ |
| S4 | 再起動後10分間の transcript の読み直し | [確] 予算で315MB、monitor で531MB | 確定済みのセッションは0。1ファイルの塊は50ms 以下 | 計時ログ |

### migration と索引の注意

- **S1 のロックの時間**
  - 見積もりは次のとおり。
    - 151 は live で3〜6秒 [推]。根拠は、複製の4.7万行で284ms [確] だったことと、キャッシュが冷えた状態での読み出しの計時 [確]。
    - 152 は約1秒 [推]。
    - 合計4〜7秒になり [推]、busy_timeout の5000ms を超えうる。
  - 反映の前に、`concordia.db` の複製で、151 と 152 の合計時間を測る。
  - 反映は Excubitor の peer operations で次の順に行う。前後に cc-test の claim と release を入れる。
    1. control-worker を止める。
    2. 本体を起動する。
    3. 本体の readiness の後で、control-worker を起動する。
  - 複製での計測が10秒を超えたら、152 を S2 の反映へ回す。同じ反映の中で version を分けても、ロックは短くならない (CC-SCAN-12)。
- **WAL の増え方**: 151 で15〜25MB 増えると見積もる [推]。`journal_size_limit` の64MB には収まる。
- **idx_events_kind を消す影響**
  - 消した後は、kind だけで引く照会が全件を読むことになる。
  - src にはそういう照会が無い [確: Grep]。
  - src の外の運用スクリプトと、Revisor のデータ増加の監査は確かめていない [未]。S1 の前に確かめる。
- **書き込みの増え方**
  - session_events は索引を置き換えるだけなので、本数は変わらない。
  - sessions の式索引は、metadata の UPDATE 1回あたり1本につき約0.1ms 増える [推: 2本で +0.19ms という実測から]。
  - started_at を含む索引が更新されるのは、INSERT と status の変更のときだけ。
  - blackbox の `(domain, id)` は、1件あたり +0.02ms [確]。
- **式索引**: 必ず json_valid の CASE で守る。壊れた JSON の行が1行ある [確]。
- **戻し方**
  - 索引は、DROP INDEX をする migration を新しく足して戻す。適用済みの migration は編集しない。
  - 統計は、`DELETE FROM sqlite_stat1` の後に `ANALYZE sqlite_schema` を実行して戻す。
- **build の確認**: 反映の前後で、build と稼働中の dist が一致していることを確かめる。調査中にも、src の行番号と稼働中の dist がずれていた時間帯があった [確: version 150 の反映の前後]。

## 6. 範囲外・未確定

- **PC 全体の負荷による伸び**
  - 同じ照会でも、計測の時期によって0.7〜1.3秒と1.9〜2.2秒のように値が違った (FS-13)。
  - CPU やディスクの混み具合、GC、ホストのスリープは、本書では扱わない。
  - 目標の比較は、同じ曜日・同じ時間帯で行う。
- **原因を特定できていない停止**
  - 2026-11-21T06:19:52Z の90.9秒。actio-chat/request の処理中だった。
  - 起動直後2分の停止。1回の起動で2〜20回、合計5.8〜50秒、最大17.9秒あり、起動処理と重なっているとみている [推]。
- **正しさの不具合 (別に起票する)**
  - FS-10: ms と秒の取り違え。
  - FS-23: 保護する集合が200件で切れる。
  - FS-03: patrol の TypeError (15時間で821回)。
  - FS-13 と FS-30: 上限で打ち切られて、古い行が漏れる。
  - FS-30: 最新ではなく最初の80フレームを返している。
  - FS-32: 日報を1日に約12回作り直している。
  - FS-35: 古い end を再び適用しうる潜在的なバグ [推]。
- **人の判断が要るもの**
  - FS-36 は、2026-08-24 の neco の決定「毎日 03:00 JST に一括 VACUUM する」(`src/db/nightly-vacuum.ts:1-8`) を変える。空き率が10%未満の夜は見送り、超えた夜も本体では実行しない形にするので、S1 に入れる前に承認を得る。
  - 保持期限: blackbox_decisions (刈る処理が無く、1日約1.4千件増える)、session_reports、日報の files の上限、cost_one_shot_calls の prompt の分離。
  - `auto_vacuum=INCREMENTAL` への切り替えと、保守の時間の VACUUM の手順。
  - ended の履歴は消さずに、照会の境界で絞る。
- **他のリポの変更**
  - Revisor: summary の差分を取る口 (FS-17 の P2)。
  - Lictor: `?sessions=none` (FS-13・14)。
  - Actio: 巡回のイベント化 (AS-04)。
  - `@ludiars/blackbox`: ensure に索引を入れる (FS-11)。
- **未計測・未確認**
  - Discord の REST の応答の大きさ (FS-19)。
  - `Thread is archived` のエラーコード (AS-01)。
  - Excubitor の process snapshot の大きさ。
  - wal-guard の checkpoint の同期の部分の時間。
  - metadata の UPDATE の回数。
  - AS-03 の作業ルート (暗号化された設定は読んでいない)。
  - control-worker が Concordia のものかどうかと、その build。
  - ログの件数の、pid での数え直し (3.1 の9)。
- **今は動いていないので外したもの**
  - Slack の session index (無効)。
  - PR reconciler と full-sync (無効)。
  - cloud-forum (有効かどうか不明)。
  - 小さい周期処理 (rule engine の1秒 tick で約2ms など)。
  - これらを有効にするときは、本書の規則で見直す。
