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
updated: 2026-11-17
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
  | 審査・委託の結果待ち (`awaiting_result`) | session か branch が一致する審査中 (open) の Revisor PR、このセッションが親の実行中の委託 run。PR 一覧を読めないときもここ | PR 番号と checkStatus / run id |
  | 作業中 (`working`) | 最終活動が 20 分以内、または最終活動を観測できない | 何分前に活動 |
  | 終了候補 (`end_candidate`) | 担当作業が終わった (委託 run の終了を親が受信済み、または担当ブランチの Revisor PR が merged) かつ未コミットの変更が無い | 根拠と無活動分 |
  | 応答なし (`unresponsive`) | 最後の活動以降に巡回の追加指示が 3 回届いた、または届けた追加指示が猶予 (3 分) 後も会話に現れない | 回数 / 会話に入っていない疑い |
  | 停止 (`stalled`) | 上のどれでもない (待つ理由なし・無活動 20 分以上) | 無活動分・未コミットの変更の有無・未反応の回数 |

- transcript・git・Revisor を読む照会は、無活動が 20 分を超え人間待ちでないものだけに行う (Revisor の PR 一覧は 1 巡回で 1 回)。
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
| CC-CTL-INV-08 | 管制が閉じるのは、他セッションの作業指示で Cc が起動した子 (親子の記録があるもの) と、親の記録が無くても担当ブランチの PR がマージ済みのセッション。人間の判断待ち・審査中の PR・testing claim・未保存の変更があるか、どれかを照会できなければ閉じない。先に案内を 1 回送り、猶予後も同じなら既存のセッション終了経路で閉じる (プロセスを直接 kill しない)。終了の結果が分からなければ再送しない |

## API

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/v1/control/status` | 設定・保持者・管制セッションの生死 |
| GET | `/v1/control/board` | 進捗ボード全件 |
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

## 実装の対応

- `src/control-session/` — 設定の読み出し、singleton の判定 (`singleton-policy.ts`) と保持者 (`holder-store.ts`)、進捗ボード (`board-repo.ts` / `board-projection.ts`)、送ってよい条件 (`instruction-eligibility.ts`)、届け方 (`instruction-dispatch.ts`)、停止の要約 (`stall-digest.ts`)、1 時間ごとのまとめ (`hourly-summary.ts`)、子セッションの片付け (`reaper-policy.ts` / `reaper-facts.ts` / `reaper.ts`)、一括指示の解釈 (`bulk-command.ts`)、側セッション (`side-dialogue.ts`)、作業場所の準備 (`charter.ts`)、巡回 (`supervisor.ts`)、組み立て (`runtime.ts`)。
- `src/api/control-session.ts` — HTTP API。
- `src/discord/control-channel.ts` — 管制チャンネル。
- `src/control/session-classify.ts` — 分類の純関数。`src/control-session/classify-facts.ts` — 分類の入力。`patrol-nudge-policy.ts` / `patrol.ts` — 停止への追加指示と応答なしの報告。`ended-log.ts` — 終了したものの記録。`src/control/nudge-skip-record.ts` — 自動確認の見送り理由。
- 既存部品の再利用: 作業状態の表示は `cc_followup_progress` (followup-progress.ts)、待ちの判定は pending-question-blocker / human-wait / human-response-confirmation / stalled-session-nudge の ask 判定、起動は `spawnSession` と pending spawn の相関 ID、側セッションは `runClaude` の会話専用実行。
