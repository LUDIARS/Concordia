---
type: feature
title: "管制セッション — Cc の全セッションを 1 つの常駐セッションで見守り、進捗だけを上書きで持ち、止まった作業へ追加指示する"
description: "Cc の起動と同時に 1 つだけ動く管制セッション (singleton、落ちたら Cc が立て直す)。各セッションの状況はサイドチャンネル (stat-collect の現況報告とセッション行) から進捗ボードへ上書きで写し、管制の会話文脈には積まない。人間とは Discord の管制チャンネルで話し、状況確認は対話ごとに進捗ボードを読む短命の側セッションが答え、一括指示は Cc が対象を絞って既存の inject 経路で送る。自動確認でも作業状態が変わらないセッションには、管制セッションが追加指示を出す。既定 OFF で、1 設定で ON にする。"
service: concordia
domain: control-session
tags:
  - control-session
  - session-coordination
  - safety
status: implemented
related:
  - feature/autonomous-work-continuation.md
  - feature/goal-and-go.md
  - feature/human-response-confirmation.md
  - feature/daily-goal-run.md
  - ux/session-coordination.md
  - architecture/ddd.md
updated: 2026-11-21
---

# 管制セッション

> 所属ドメイン: [`control-session`](../domains/control-session.domain.json)

価値: UX-CC-SC-W2 (主)、UX-CC-SC-W3、UX-CC-W4。シナリオ SC-S2 / SC-S4、UX-CC-S5。
上位 UX は [セッション協調](../ux/session-coordination.md)、横断の不変条件は [ddd.md](../architecture/ddd.md) の CC-INV-03/04/06/08。

## 経緯

- 2026-11-16 neco 指示:「新しくメジャーに上げる前に Cc の管制セッションを作ろう」。
  1. 管制セッション = Cc の全セッションの出来事・イベントを統括するセッション。Cc 起動と同時に 1 つだけ動く。
  2. 各セッションの状況をすべて持つのではなく、サイドチャンネル (btw) で状況を追い、進捗だけを持つ (上書き)。
  3. ユーザーと対話できるチャンネル (Discord) を用意する。主用途は状況確認と、多数のセッションへの一括指示。
  4. ユーザーとの対話も全部サイドセッションで行う。
  5. 自動確認でそれぞれの動きが止まっているとき、管制セッションが追加指示をする。
- 2026-11-17 neco 指示:「進捗確認のやり方を根本的に見直せ」「自動確認の更新判定も同じように」「作業が終わったパートはセッション終了」。
  実測では、全セッションが 100 分以上無活動でも管制ボードは「止まっている 0 件」と報告していた (旧基準 `unchanged_count>=2` は自動確認が送られて指紋が記録されたときしか増えない)。
  旧基準を廃止し、観測された動きと待つ理由だけで各セッションを 1 つに分類する (§2)。
- 人間の決定待ちのため、既定は OFF。`session.control_session_enabled` を 1 つ ON にすれば全部が動く。

## 構成要素と状態の所有者

| 要素 | 役割 | 状態の正本 |
|---|---|---|
| 管制セッション (本体) | 停止の要約を受けて追加指示を決める常駐 AI セッション。会話文脈には停止の要約だけが届く | セッション行 (Cc DB `sessions`)。保持者 (世代) は設定ストアの内部状態キー `control_session.holder` (人が編集する設定ではないので設定レジストリには載せない) |
| 管制の巡回 (supervisor) | 1 分ごとに singleton の起動・復旧、進捗ボードの更新、停止の検出と本体への要約送信 | なし (毎回 DB から決める) |
| 進捗ボード | セッションごとに最新 1 レコード (上書き)。履歴を持たない | Cc DB `control_progress_board` |
| 管制チャンネル | Discord の「管制」チャンネル。人間の状況確認と一括指示の入口 | Discord 設定 `control_channel_id` |
| 側セッション | 対話 1 回ごとに進捗ボードを読んで答える短命の 1 回限りの実行。会話を残さない | なし |

### 1. singleton の起動と復旧 (CC-CTL-INV-01)

- 設定が ON のとき、巡回は保持者 (spawn ID・世代・起動時刻) と、その spawn ID で登録された active なセッションを照合する。
  - 保持者が無い → 管制セッションを 1 つ起動し、保持者を記録する。
  - 保持者の spawn ID のセッションが active → 何もしない (Cc の再起動をまたいでも同じセッションを使い続ける)。
  - 起動後、猶予 (5 分) を過ぎても登録されない、または終了した → 新しい世代で立て直す。直前の起動から猶予が過ぎるまでは次を起動しない (起動の連打をしない)。
- 退役した世代のセッションが active のまま残っていたら、終了を促す 1 回の案内を送る (管制は常に 1 つ)。
- 管制セッションの作業場所は `<workspace>/.concordia-control/`。起動時に `CONTROL.md` (役割と使ってよい API・してはいけないこと) を置き、それを読ませて始める。
- 管制セッション自身は停止確認 (stall nudge)・Goal & Go・現況報告 (stat-collect) の対象から外す (CC-CTL-INV-02 の文脈を汚さない)。

### 2. 進捗ボード (CC-CTL-INV-02)

- 巡回ごとに active なセッションを 1 行ずつ上書きする。行の中身は: プロジェクト・branch・作業状態 (自動確認が記録した `cc_followup_progress` の state と「変化なし」回数。参考表示で判定には使わない)・現在のタスク (先頭だけ)・サイドチャンネルの最新の現況 (`/v1/stat` に届いた最新 1 件の要約)・最後の会話時刻・自動確認が最後に見送った理由 (`last_skip_reason`)・分類 (`status` / `status_reason`)・巡回の追加指示の段取り (`nudge_count` / `nudge_last_at` / `unresponsive_reported_at`)。
- 分類 (`src/control/session-classify.ts` の `classifySession`、入力は `src/control-session/classify-facts.ts` が集める)。優先順に 1 つ:

  | 分類 | 条件 | 理由に出すもの |
  |---|---|---|
  | 人間の判断待ち (`human_wait`) | 部署の自動確認 OFF・未回答の質問カード・human-wait・人間の応答待ちの確認・ask マーカー。照会できないときもここ | 待ちの種類 |
  | 審査・委託の結果待ち (`awaiting_result`) | session か branch が一致する審査中 (open) の Revisor PR、このセッションが親の実行中の委託 run。PR 一覧を読めないときもここ (ただし 3 巡回続けて読めなければ待つ理由にしない。下記) | PR 番号と checkStatus / run id / 読めない連続巡回数 |
  | 作業中 (`working`) | 最終活動が 20 分以内、または最終活動を観測できない | 何分前に活動 |
  | 終了候補 (`end_candidate`) | 担当作業が終わった (委託 run の終了を親が受信済み、または担当ブランチの Revisor PR が merged) かつ未コミットの変更が無い | 根拠と無活動分 |
  | 応答なし (`unresponsive`) | 最後の活動以降に巡回の追加指示が 3 回届いた、または届けた追加指示が猶予 (3 分) 後も会話に現れない | 回数 / 会話に入っていない疑い |
  | 停止 (`stalled`) | 上のどれでもない (待つ理由なし・無活動 20 分以上) | 無活動分・未コミットの変更の有無・未反応の回数 |

- transcript・git・Revisor を読む照会は、無活動が 20 分を超え人間待ちでないものだけに行う (Revisor の PR 一覧は 1 巡回で 1 回)。
- 審査状況の読み口 (`src/control-session/review-status-source.ts`、2026-11-17 追加): Revisor の一覧 API には repository / branch の絞り込みが無いため、open の詳細一覧 (`?state=open`) だけを読み (決着済みの要約一覧 `state=all` は読まない)、成功した結果を 60 秒キャッシュして巡回と終了候補の判定で共有する。セッションごとの照合は Cc 内で session id → repository + branch の順に絞る。読み取り失敗はキャッシュしない。
- 審査状況の読み取り失敗は巡回単位で数える (読まなかった巡回は数を変えない、成功で 0 に戻す)。1〜2 巡回目は「審査状況を確認できない (n 巡回連続)」で結果待ちにし、3 巡回続いたら待つ理由にせず無活動基準で分類する。そのとき `status_reason` に「審査状況を 3 巡回続けて確認できないため無活動基準で判定」を添える (CC-CTL-INV-10)。
- 人間の応答待ちの確認 (`human_response_confirmation`) が立っているセッションは、分類の前にそのセッション自身の動き (確認後のコミット・審査中 PR の提出/更新) を観測し、動いていれば確認を解いてから分類する (`src/control-session/confirmation-activity.ts`、判定は [human-response-confirmation.md](human-response-confirmation.md) の「観測された動きによる解除」)。
- 旧基準 (自動確認の「変化なし」が 2 回以上で停止) は廃止した。自動確認が送られない・指紋が無いセッションも、最終活動と待つ理由だけで停止になる (CC-CTL-INV-09)。
- 自動確認 (stalled-session-nudge) が送るのを見送ったときは、info ログに session_id と理由を出し、セッション metadata `stall_nudge_skip` に最後の 1 件を残す (`src/control/nudge-skip-record.ts`)。ボードはそれを `last_skip_reason` として写す。
- 終了したセッションの行は消す。行の履歴は持たない。管制セッションの会話文脈にもボードを積まない (必要なときに `GET /v1/control/board` で読む)。

### 3. 管制チャンネルと側セッション (CC-CTL-INV-03)

- 設定が ON の間、Discord に「管制」テキストチャンネルを用意する (カテゴリ外)。OFF の間は作らず、届いた発言には「管制は OFF」と返す。
- 投稿できるのはセッション操作を許可された人 (社員名簿) だけ。それ以外は理由を返して何もしない。
- 「一括:」「一括指示:」で始まる投稿は一括指示。`一括[Cc,At]: …` のようにプロジェクトコードで対象を絞れる (無ければ全 active)。Cc が対象を決めて §5 の経路で送り、送った数と送らなかった理由ごとの数を返信する。
- それ以外の投稿は状況確認。投稿ごとに側セッション (会話専用・ツールなしの 1 回限りの実行) が進捗ボードと質問だけを読んで答え、その返信を投稿へ返す。管制セッション本体の文脈には入れない。同時に動く側セッションは 2 つまでで、超えたら待ってもらう返信をする。

### 4. 停止したセッションへの追加指示 (CC-CTL-INV-04)

- 停止・応答なしの判定は §2 の分類による (旧基準の「変化なし 2 回」は使わない)。
- 停止・応答なしには、管制の巡回が自分で追加指示を送る (`src/control-session/patrol.ts`、stall-nudge のゲートには依存しない)。届け方は §5 と同じ (送る直前に送ってよい条件を確かめ直す)。来歴は `[管制] 管制の巡回からの追加指示です`。本文の先頭に目印 `[管制停止確認 #n]` を入れ、会話に入ったかの照合に使う。
  - 未返信でも黙らない。最後の活動以降に届けた回数 n に対して、次の送信まで 20 → 40 → 80 分 (上限 2 時間) 待って再送する (`patrol-nudge-policy.ts`)。会話が動けば回数を数え直す。
  - 届けた回数が 3 回に達しても会話が動かない、または届けた追加指示が猶予後も transcript に現れないものは「応答なし」に上げ、管制チャンネルへ 1 回だけ名指しで報告する (プロジェクト・session_id・理由・直近の追加指示の時刻)。
  - 人間待ち・審査待ちには送らない。理由はボードの `status_reason` に必ず残す。
- 巡回は停止・応答なしのうち §5 の送ってよい条件を満たすものを 1 通の要約にして管制セッションへ送る。同じ停止 (分類と最終活動の組) は 1 回だけ伝える。既定の追加指示とは別の指示が要るときだけ、管制セッションが下の API で送る。
- inject の「成功」は届いたことの確認ではない: `eventBus.canDeliverInject` は配信ゲートだけを見て、宛先の WS クライアントが接続しているかは見ない。届いたかは会話に目印が現れたかで確かめる (2026-11-16 21:00 JST の Cc 再起動後、lictor-9f9a75a2 宛ての inject が別のセッションの会話に入った件。Cc の配信は WS の `?session=` と一致する接続だけに送るので、別の会話へ入るのは Lictor が再接続で別の id を名乗ったとき)。
- 管制セッションは追加指示が要ると判断したら `POST /v1/control/instructions` で送る。Cc は送り手が現在の管制セッションであることを確かめ、§5 の条件を送る直前にもう一度確かめてから届ける。

### 5. 指示の送り方 (CC-CTL-INV-05/06)

- 送ってよいのは active で、次のどれにも当たらないセッションだけ: 未回答の質問カード (照会できないときも送らない)・human-wait・人間の応答待ちの確認・transcript 末尾の ask マーカー・部署の自動確認 OFF・管制セッション自身。
- 届け方は既存の `session.inject` (source `auto:control`)。本文の先頭に来歴 (`[管制] 管制セッション第 N 世代から` / `[管制] <人間> の一括指示`) を付ける。ゲート・審査・許可範囲の判断は届け先のセッションの既存の規則に従い、管制は許可を足さない。
- 送ったことは管制チャンネルへ件数と対象だけを知らせる (本文は載せない)。届かなかった (WS 未接続) ものは送信済みにしない。

### 6. ON / OFF

- `session.control_session_enabled` (既定 OFF、WebUI の設定で切替、Cc 再起動不要)。
- OFF にすると、巡回は起動・要約・ボード更新をやめ、active な管制セッションへ終了を促す案内を 1 回送り、保持者を消す。API は `control_disabled` を返す。
- 戻し方: 設定を OFF にする。進捗ボードは表だけなので、消しても各セッションの状態には影響しない。

### 7. 1 時間ごとのまとめ (CC-CTL-INV-07)

- 設定が ON で管制チャンネルが用意できている間、巡回のたびに最終投稿時刻 (内部状態キー `control_session.summary_posted_at`、設定レジストリの名前空間の外) を読み、未投稿・時計が戻った・1 時間経過のどれかなら、進捗ボードのまとめを管制チャンネルへ 1 通投げる (`hourly-summary.ts`)。
- 本文: 「🗂️ [管制まとめ] <JST 時刻> — 動いているセッション N 件」、分類別 (§2、0 件の分類も出す) とプロジェクト別の件数、停止・応答なし・人間の判断待ちの各件数とそれぞれ最大 10 行 (プロジェクト・session_id・無活動分・理由・直近の追加指示の時刻・現在のタスクの先頭 60 字)、前回のまとめ以降に管制が終了したもの (プロジェクト・session_id・理由・時刻)。超えた分は「…ほか n 件」。0 件なら「動いているセッションはありません。」。
- 終了したものの記録は内部状態キー `control_session.recent_ended` に溜め (上限 50 件)、まとめの投稿に成功したら消す (`ended-log.ts`)。
- 停止の要約 (§4 の管制セッションへの要約) も同じ分類を使う。
- 投稿に成功したときだけ時刻を残す。失敗は警告ログにして次の巡回で再試行する。OFF にすると時刻を消す (再 ON 直後に 1 回投げる)。
- まとめは管制チャンネルへの投稿だけで、管制セッション本体には送らない (CC-CTL-INV-02)。

## 不変条件

| ID | 条件 |
|---|---|
| CC-CTL-INV-01 | 管制セッションは同時に 1 つだけ。保持者の世代と spawn ID で照合し、猶予内に重ねて起動しない |
| CC-CTL-INV-02 | 進捗ボードはセッションごとに最新 1 行の上書きだけで、履歴を持たない。管制セッションの文脈にボードや各セッションの会話を積まない |
| CC-CTL-INV-03 | 人間との対話は側セッションで答え、管制セッション本体の文脈に入れない。投稿は社員名簿で許可された人だけ受け付ける |
| CC-CTL-INV-04 | 停止の要約は同じ作業状態の指紋につき 1 回だけ本体へ送る |
| CC-CTL-INV-05 | 人間の判断待ち (質問カード・human-wait・応答待ちの確認・ask マーカー) と部署の自動確認 OFF のセッションには、一括指示も追加指示も送らない (照会できないときも送らない) |
| CC-CTL-INV-06 | 指示は既存の inject 経路で来歴付きで届け、届け先の審査ゲート・許可範囲を回避しない。追加指示は現在の管制セッションからだけ受け付ける |
| CC-CTL-INV-07 | 管制チャンネルのまとめは 1 時間に 1 回まで。進捗ボードだけを読んで作り、投稿に成功したときだけ時刻を記録する。本文にメンションを含めない |
| CC-CTL-INV-09 | 待つ理由 (人間の判断・審査・委託の結果) の無いセッションが 20 分以上無活動なら、自動確認の記録の有無にかかわらず停止か応答なしに分類する (全員が無活動なのに停止 0 件、にはならない)。停止への追加指示は未返信でも上限 2 時間の間隔で送り続ける |
| CC-CTL-INV-10 | 待つ理由の照会 (審査状況) が失敗し続けても、停止の検出を無期限に止めない。3 巡回続けて読めなければ無活動基準に戻し、理由を `status_reason` に残す。人間の応答待ちの確認も、そのセッションが確認後にコミット・PR の提出/更新をしていれば解く |
| CC-CTL-INV-08 | 管制が閉じるのは、他セッションの作業指示で Cc が起動した子 (親子の記録があるもの、委託 run の子は親を引けなくても対象) と、親の記録が無くても担当ブランチの PR がマージ済みのセッション。委託 run の子は run が終端 (completed / partial / failed) で担当 PR がマージ済みかクローズ済みなら役目を終えたとみなす。人間の判断待ち・審査中の PR・testing claim・未保存の変更があるか、どれかを照会できなければ閉じない (古い質問カードだけは §9 の方針に従う。作業が終わった根拠があり 2 時間以上会話が無ければ、質問カード・人間の応答待ちの確認・ask マーカーは数えない — §9.3。human-wait は数える)。紐付く Actio タスクがすべて完了したことも作業が終わった根拠にする。先に案内を 1 回送り、猶予後も同じで案内に反応が無ければ既存のセッション終了経路で閉じる (プロセスを直接 kill しない)。終了の結果が分からなければ再送しない。閉じない理由はセッションに記録する |

## API

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/v1/control/status` | 設定・保持者・管制セッションの生死 |
| GET | `/v1/control/board` | 進捗ボード全件。各行に `link` (判断が要るセッションへ飛ぶ URL、引けなければ `null`、§10) を添える |
| POST | `/v1/control/instructions` | `{from_session_id, targets: [session_id], text}`。管制セッションからの追加指示。結果は届けた / 送らなかった理由ごと |

すべて既存の loopback 認可の内側。OFF のときは 409 `control_disabled`。

### 8. 起動の登録と詰まり (2026-11-16 障害対応)

- 管制セッションの起動は chores と同じく、spawn の直前に spawn ID を Cc 起動の登録 (pending spawn の enrollment) として記録し、起動に失敗したら取り消す。記録が無いと起動した Lictor のセッション登録が `invalid_or_consumed_session_enrollment` で拒否され、Lictor が作業場所の trust を焼かないため trust picker で止まる。
- 巡回は起動を最大 60 秒だけ待つ。返らない・例外は起動失敗として扱い、ボード更新とまとめの投稿を続ける。保持者は起動前に記録済みなので、猶予内に重ねて起動しない (CC-CTL-INV-01)。

### 9. 子セッションの片付け (CC-CTL-INV-08)

neco 指示 (2026-11-16)「セッションから作業指示で起動したセッションが反応してないか役目を終えた際に閉じる役割も持つ」。
2026-11-17 neco 指示「作業が終わったパートはセッション終了」で、子に限らず全セッションへ広げた。

- 対象: 既存の親子の記録がある子 (`reaper-policy.ts` の `classifyChild`) と、親の記録が無いセッション (`standalone`、担当 branch と repo_origin があり、branch が main / master / develop でないもの)。
  - リポ担当 (auto-succession): 子 metadata の `repo_agent_of.parent_session_id`。
  - 委託 run の子: metadata の `delegation_run_id` の run が、`delegation_runs.child_session_id` でこのセッションを子として記録しているもの。
  - 親を持つ `/v1/spawn`: metadata の `delegation_parent_session_id`。
  - 対象外: 管制セッション自身、部署の常駐 (`resident_sidecars.child_session_id`)、担当 branch の無い standalone (相談セッションなど)。人間が対話中のものは、会話が 30 分以内なら照会もしないので閉じない。
- 閉じてよい条件:
  - 役目を終えた: 委託 run の子は、親の記録に終端の通知 (source `delegation:<run>:status` の inject = completed / partial / failed) が届いていて、その後 30 分以上会話が無い。リポ担当は、担当ブランチの Revisor PR が merged で、その後 30 分以上会話が無い。Cc には反映済みの記録が無いため、反映中はリポ担当が testing claim を持つこと (下の除外) で代える。
  - standalone: 担当ブランチの Revisor PR が merged で、その後 30 分以上会話が無い (`done_merged`)。standalone は「反応しない」では閉じない (§4 の応答なしとして報告する)。
  - 反応しない (子だけ): 60 分以上会話が無く、自動確認 (`cc_followup_progress`) で作業状態が変わらなかった回が 2 回以上 (自動確認と管制の追加指示の後も変化が無い)。
- 閉じない (どれか 1 つでも当たるか、照会できないとき): human-wait・未回答の質問カード・人間の応答待ちの確認・ask マーカー・審査中の open PR (session か branch が一致)・testing claim 中・worktree に未コミットの変更がある・main より先のコミットがあり HEAD を head にした PR が Revisor に無い (`reaper-facts.ts`)。
- 2 段 (`reaper.ts`): 先に子へ「役目を終えたので作業記録を残して session-end してください」を 1 回送り、子の metadata `control_reaper` に時刻を残す (届かなければ記録しない)。10 分後も閉じてよい条件のままなら、既存の終了経路 (`DELETE /v1/sessions/:id` → `endSessionNow`) で閉じる。閉じる前後に親へ inject し (親の記録がある場合)、管制チャンネルへ件数と対象を知らせる。閉じたものは §7 のまとめに列挙する。終了を試みたら記録し、結果が分からなくても再送しない。
- 会話が 30 分以内の子は照会しない (git / Revisor を叩かない)。open PR の一覧は 1 巡回で 1 回だけ読む。
- 設定 `session.control_session_reaper_enabled` (既定 ON)。`session.control_session_enabled` が OFF なら動かない。OFF で次の巡回から止まる。

#### 9.1 閉じられずに残っていた例と対応 (2026-11-17、Actio 2eb4a28e-6444-4407-ab3d-06565cd14a32)

neco 指示 2026-11-17「終わったセッションをアーカイブしていきたい」→「管制が自動で閉じる」。親 lictor-24e68c85 が手で閉じた例を DB から調べた結果:

- `lictor-88db0fbf` (Revisor、委託 run `c2aad04c` completed、PR マージ済み): run の `parent_session_id` が空で、親は `triggered_by` にしか無かった。旧 `classifyChild` は親が引けない委託の子を null (対象外) にし、branch が main (provided-cwd) なので standalone にもならず、一度も判定されなかった。親が空なので `delegation:<run>:status` の inject も親に届いておらず、`done_delegation` も成り立たなかった。直近 14 日の委託 run はほとんどが `parent_session_id` 空 (cron・partial-requeue・セッション起動の一部)。
- 共有 checkout (基点ブランチ) で起動したセッションの未保存判定は `git status --porcelain` を共有 checkout で読み、他の作業の未追跡ファイル・submodule 差分で常に「未保存あり」になっていた。
- `lictor-baab89c6` (Concordia、親の記録の無い `/v1/spawn`、branch main): 対象外のうえ、未回答の質問カード (`discord_pending_questions`、約 18 時間前) が残っていた。
- partial で終わった委託: 終端扱いの判定 (`done_delegation`) は partial も含むが、親への通知の記録が前提で、親の空な run では成り立たなかった。

対応:

- 親の解決 (`runParentSessionId`): `parent_session_id` → metadata `delegation_parent_session_id` → `triggered_by` がセッション id (`lictor-<uuid>`) のとき、の順。cron 等の起動元は親にしない。親を引けない委託の子も対象にする (親への inject は省き、管制チャンネルにだけ知らせる)。
- 閉じてよい条件を追加:
  - `done_run_settled`: 委託 run が終端 (completed / partial / failed) で、担当 PR が merged か closed、その後 30 分以上会話が無い。担当 PR は作業ブランチならブランチで、共有 checkout (基点ブランチ) なら Revisor の PR の `sessionId` で引く (`findLocalPrBySession`: open の詳細一覧 → 同じリポジトリの直近の決着済みを単一取得)。PR が無い・照会できないときは閉じない。
  - 親を持つ `/v1/spawn` の子も、担当 PR がマージ済みなら `done_merged`。
  - 終了候補の案内後に反応が無いもの: 案内の後に会話があれば (案内から 60 秒より後の活動) 反応したとみなし、猶予後でも閉じずに案内からやり直す。反応が無いまま猶予を過ぎたら閉じる。
- 共有 checkout (基点ブランチ) のセッションは、追跡ファイルの変更だけを未保存とみなす (`--untracked-files=no --ignore-submodules=all`)。作業ブランチのセッションは従来どおり。
- 古い質問カードの方針: 未回答の質問カードは原則「人の回答待ち」で閉じない。ただしカードを出した後もセッションが 10 分以上作業を続けた (最終活動 ≥ カードの時刻 + 10 分) なら、カードは別経路で解決済みの古いものとみなし、作業が終わった根拠 (`done_*`) があるときに限り閉じない理由に数えない。根拠が「反応しない」だけのときは人の回答待ちとして閉じない。古いカードを無視して閉じるときは、親と管制チャンネルへの通知にその旨を書く。human-wait・人間の応答待ちの確認・ask マーカーは従来どおり閉じない。
- 閉じない理由の記録: 判定で閉じなかったセッションは metadata `control_reaper.last_skip_reason` / `last_skip_at` に理由 (`not_due` / `pendingQuestion` / `unsavedWork_unknown` など) を残す (変わったときだけ書く)。
- 通知: 案内・終了の通知 (親への inject と管制チャンネル) に、どのセッションを、なぜ閉じたかを書く。

#### 9.3 タスク完了と長い無活動で閉じる (2026-11-21 neco 指示)

指示 (原文): 「各 Claude のセッションが残り続けていてうざいので、タスクワークフローや session-end したセッションを archive してアプリの一覧に出てこないようにしたい」→ 選択「[B] タスク完了かつ無活動 — 紐付く Actio タスクが完了、または担当 PR がマージ済みで、一定時間 (例 2 時間) 動きの無いセッション。質問カード待ち・人間の応答待ちでも閉じる」。

調べた結果 (2026-11-21): 手元で動いている Claude のプロセス 20 本は、ほぼすべて Cc 上も active だった。Cc が閉じたセッションのプロセスは残っておらず、残る原因は閉じる判断まで届かないこと。閉じない理由の記録は `pendingQuestion` / `waitingHumanResponse` / `not_due` が多く、基点ブランチの会話セッションは対象外だった。

- 終わった根拠に `done_task` を足す: セッションに紐付く Actio タスク (`cc_task_links`、`readLinkedTaskViews`) がすべて done か cancelled で、その後 30 分以上会話が無い。紐付けが無い・読み取り中に紐付けが変わった・状態が分からないタスクがあれば根拠にしない (`linkedTasksAllDone`)。親子の記録の有無にかかわらず使う。
- 対象を広げる: タスクが紐付いていれば、基点ブランチ (main など) の会話セッションも standalone の対象にする。
- 長い無活動: 作業が終わった根拠 (`done_*`) があり、2 時間以上会話が無ければ、未回答の質問カード・人間の応答待ちの確認・ask マーカー (照会できない場合も) を閉じない理由に数えない (`REAP_DONE_LONG_IDLE_SEC`)。human-wait (人間の判断の明示記録)・審査中の open PR・testing claim・未保存の変更は従来どおり閉じない理由。根拠が「反応しない」だけのときは待ちを無視しない。
- 待ちを無視して閉じるときは、親と管制チャンネルへの通知にその旨を書く。会話記録は消えず、Claude は `--resume` で戻れる。
- 戻し方: `session.control_session_reaper_enabled` を OFF にすれば片付け全体が止まる。

session-end 済みのセッションについて: Lictor の shutdown は Cc の登録解除と CLI の停止まで行うので、Cc 上もプロセスも残らない。Claude デスクトップアプリの一覧に残るのはアプリ側の会話履歴で、Cc の管理外 (未対応、人間の判断待ち)。

#### 9.2 終了済みなのに Discord 側が開いたままのもの (2026-11-17 追加依頼)

Cc の記録では終了済みのセッションのチャンネル/スレッドは全件 `discord_session_channels.status` も ended / lost だが、Discord 側を閉じ直す照合 (`session-channel.ts` の `reconcileEndedSessionChannels` / `reconcileLostSessionChannels`、TaskWorkflow の取り残し `taskworkflow-orphan-reconcile.ts`) が過去分を拾えていなかった。稼働ログで確かめた原因:

- 照合が起動時の 1 回しか動いていなかった。定期実行は `CONCORDIA_DISCORD_STATUS_RECONCILE_SEC` (状態カードの定期照合、既定 0 = OFF) に相乗りしており、OFF のままだと終了イベントを取りこぼしたものが次の再起動まで開いたまま残る。
- 起動時の 1 回も、キャッシュに無いスレッドを「確かめられない」として全件 1 件ずつ取り直していた (`guild.channels.fetch()` はスレッドを読まない)。2026-11-17 の起動では ended 3,056 件・lost 406 件を取り直して 57 分かかった。
- 既に閉じたスレッドを閉じ直そうとして Discord が `Thread is archived` で拒否し、毎回失敗していた (同日 68 件)。
- `CONCORDIA_DISCORD_ORPHAN_RECONCILE_DRY_RUN` は稼働設定に無く (試運転ではない)、TaskWorkflow の取り残しは紐付けが消えたスレッドだけが対象で、今回の残りとは別。

対応:

- 照合の先頭で開いているスレッドの一覧 (`fetchActiveThreads`) を 1 回読み、読めたら「キャッシュに無いスレッド = 既に閉じている」として取り直さない。読めなければ従来どおり 1 件ずつ確かめる。
- 既に閉じたスレッドを終了表示にするときは編集しない (閉じていること自体が終了の表示)。
- 状態カードの定期照合を OFF にしていても、終了したセッションのチャンネル/スレッドを閉じる照合を `CONCORDIA_DISCORD_SESSION_FORUM_RECONCILE_SEC` (既定 600 秒、0 で停止) ごとに回す。会話記録は消さない (アーカイブへ移す・スレッドを閉じるだけ)。

### 10. 判断待ちのセッションへのリンク (2026-11-21 neco 指示)

指示 (原文): 「判断が必要なものについて管制から各セッションへリンクを貼って飛べるようにする」。
まとめで判断待ちや停止を知っても、そのセッションへ自分で探しに行かないと答えられなかったので、管制が出す一覧からそのまま飛べるようにする (UX-CC-SC-W2)。

- リンクの組み立ては `session-link.ts` の純関数 (`controlSessionLink`)。未回答の質問カードがあれば、そのカードの Discord メッセージ URL (`humanTodoQuestionLink`、人間のやることの報告と同じ) を優先する。無ければセッションの Discord チャンネル/スレッドの URL `https://discord.com/channels/<guild>/<channel>`。
- guild はセッションのチャンネル対応表の scope で決める ('' = 本社の guild、`sub:<id>` = その子会社の guild)。対応表に行が無い・id が Discord の snowflake でない (Slack 等) ときはリンク無し。
- 1 時間ごとのまとめ (§7) は、停止・応答なし・人間の判断待ちの各行の末尾に ` / <URL>` を付ける。山括弧は Discord の埋め込みを抑止するため。作業中など一覧に出さない行には付けない。メンションは今どおり含めない (CC-CTL-INV-07)。
- 側セッション (§3) の進捗ボードには `リンク=<URL>` を載せ、判断が必要なセッションを挙げるときはボードのリンクをそのまま添えるよう指示する (リンクを作らせない)。
- `GET /v1/control/board` の各行に `link` を添える。
- 境界: リンクは読むだけで、質問カード・チャンネル対応表・guild 設定の所有者は変えない。照会が例外を投げたらリンク無しにして警告ログに残し、まとめの投稿・側セッションの回答・API を止めない (`safeLinkResolver`)。
- 戻し方: 組み立て (`bootstrap/core.ts`) で `sessionLink` を渡さなければ、リンク無しの従来どおりの本文・応答になる。
- 管制から Muse 等の外部 push 系への連携の状況報告は、対象と状態の読み口が決まっていないので未着手 (人間の判断待ち)。

### 11. dots の連携状況 (2026-11-21 neco 指示)

Actio 106c0bf7-5d2a-4bc9-bfb0-3c02e9f89b60「管制から Muse 等の外部 push 系連携の状況を報告する」。対象は neco 指示 (原文)「3はdotsが対象」で dots (CDGD マネジメント層、spec/feature/cdgd-management.md) に決まった。

- 1 時間ごとのまとめ (§7) の末尾に「dots 連携」を載せる。任務ごとに、dots がまだ処理していない変更の数 (処理済み位置 `acknowledged_seq` より後で、Cc 自身の記録を除く)・最後に判断を記録した時刻・実行中の依頼数・人間の判断待ち・起動失敗を出す。停止中の任務は「停止中」だけ。
- 未処理の変更があるのに、任務の確認間隔の 2 倍を過ぎても判断が記録されていなければ「⚠ dots の判断が止まっています」と付ける (`isDotsStalled`)。dots が呼びに来ているかの記録は持たないので、判断の記録を代わりに使う。
- 任務が 1 件も無ければ何も載せない。読み取りに失敗したら「状況を読めませんでした」とだけ載せ、まとめ本体は止めない。
- 状況は Cc が持つ任務・変更・判断・依頼の記録から読むだけで、書き換えない。読み取りは `src/management/status-snapshot.ts`、表示は `src/control-session/dots-status.ts`。

### 12. 外部連携の状況

Actio `106c0bf7-5d2a-4bc9-bfb0-3c02e9f89b60`、Gen5 統合実装 `f69c01a2-02e0-4969-83c3-88e8d7d296f1`。
管制ボード `GET /v1/control/board` の `external_bridges` と、1 時間ごとの Markdown まとめに以下を表示する。

- Muse 指令ブリッジは `agent_instructions` の最新完了と最新失敗、失敗時の結果要約、保留と実行中の件数を表示する。完了・失敗の参照期間は既存の指令保持期間に従う。
- Conflux 外部通知フックは `build-events` と `integration` の送信台帳を読み、最新成功と最新失敗、失敗時の HTTP コードまたは通信エラーを表示する。
- Playtest Review 受け口は Discord・Slack・Tabula いずれかの最新配送成功と配送先別の失敗種別を示す。動画とテキストで成否が分かれたときは同じ時刻に成功と失敗を記録する。

設定が無ければ「未接続」、設定済みで結果が無ければ「未使用」。最新の失敗が最新成功以降なら「失敗あり」、
最新成功が新しければ「正常」とする。読み出しに失敗した連携は個別に「状況取得失敗」と表示する。
状態は保存済みの結果と現在の設定に基づく。帰還の受付とビルドの進行状況は
[`GET /v1/control/merge-playtest-returns`](merge-playtest-return.md) で確認できる。

## 実装の対応

- `src/control-session/` — 設定の読み出し、singleton の判定 (`singleton-policy.ts`) と保持者 (`holder-store.ts`)、進捗ボード (`board-repo.ts` / `board-projection.ts`)、送ってよい条件 (`instruction-eligibility.ts`)、届け方 (`instruction-dispatch.ts`)、停止の要約 (`stall-digest.ts`)、1 時間ごとのまとめ (`hourly-summary.ts`)、判断待ちのセッションへのリンク (`session-link.ts`)、dots の連携状況 (`dots-status.ts`、読み取りは `src/management/status-snapshot.ts`)、子セッションの片付け (`reaper-policy.ts` / `reaper-facts.ts` / `reaper.ts`)、一括指示の解釈 (`bulk-command.ts`)、側セッション (`side-dialogue.ts`)、作業場所の準備 (`charter.ts`)、巡回 (`supervisor.ts`)、組み立て (`runtime.ts`)。
- `src/api/control-session.ts` — HTTP API。
- `src/discord/control-channel.ts` — 管制チャンネル。
- `src/control/session-classify.ts` — 分類の純関数。`src/control-session/classify-facts.ts` — 分類の入力。`review-status-source.ts` — 審査状況の読み口 (open 一覧の短時間キャッシュ・セッションへの絞り込み・読み取り失敗の連続数)。`confirmation-activity.ts` — 応答待ちの確認を解く判定の入力 (HEAD・審査中 PR)。`patrol-nudge-policy.ts` / `patrol.ts` — 停止への追加指示と応答なしの報告。`ended-log.ts` — 終了したものの記録。`src/control/nudge-skip-record.ts` — 自動確認の見送り理由。
- 既存部品の再利用: 作業状態の表示は `cc_followup_progress` (followup-progress.ts)、待ちの判定は pending-question-blocker / human-wait / human-response-confirmation / stalled-session-nudge の ask 判定、起動は `spawnSession` と pending spawn の相関 ID、側セッションは `runClaude` の会話専用実行。
