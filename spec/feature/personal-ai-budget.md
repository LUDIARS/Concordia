# 個人の AI 予算 — 月間分と報酬分

> 2026-10-02 neco 指示:「報酬として AI 予算をあげる」「(付与先は) 個人」「(本社は) 対象外」
> 「Tabula の取り込みと技術相談課についても報酬を用意」「本社で『〇〇に報酬』で調整できるようにする」
> (〇〇は人)「予算だけど月間分と報酬分で分けて、月間予算から先に消費する」「公開したものに対して報酬」。

- 価値: [UX-CC-W8](../ux/product.md) / シナリオ UX-CC-S9
- 所属: `personal-ai-budget` (支援: 運用・組織)。コアドメインではない。
- 関連: [コスト観測](cost-observability.md) (全体と子会社の日次 budget)、[バグバウンティ](bug-bounty.md)、
  [技術相談](tech-consultation.md)、[対話の前提データ](dialogue-context.md) (依頼者メモ)

A (台帳・消費・払い出しの判定・`/budget`・`/reward`・WebUI) は実装済みで、実装時に確定したことは §13 に書く。
当初はテスト未実行。2026-10-03 の統合・許可された検証の記録は §14 に追記する。
画面と Discord の実機確認・人間による UX 評価は未実施。B (Tabula 公開の報奨) は未実装。
金額の既定値 (§5) は提案値で、neco の確認を受けていない。
[バグバウンティ](bug-bounty.md) §7 の「個人残高」は本書の「報酬分」に置き換える (台帳は本書が持つ)。

## 1. 用語

| 用語 | 意味 | 混同しないもの |
|---|---|---|
| 個人 | 子会社に所属する 1 人。会社・プラットフォーム・プラットフォームのユーザー id の組で識別する (依頼者メモと同じ組) | 本社メンバー (対象外)、セッション |
| 月間分 | 個人が 1 か月に使えるトークン数。月初 (ローカル時刻) に戻る。繰り越さない | 子会社の日次 budget |
| 報酬分 | 報奨で増えるトークン残高。期限なし。月が替わっても残る | 月間分 |
| 個人の消費 | その個人を依頼者とするセッションが使ったトークン | 依頼者の無いセッションの消費 |
| 報奨 | 報酬分への加算。理由 (種類) と根拠を持つ | 月間分の設定変更 |
| 調整 | 本社の権限者が特定の個人の報酬分を増減させること | 自動の報奨 |

## 2. 不変条件

| ID | 条件 | 強制箇所 |
|---|---|---|
| CC-PBUDGET-INV-01 | 個人の消費は月間分から先に引き、月間分が尽きてから報酬分を引く | 消費の割り当て `allocateConsumption` (`src/personal-budget/allocation.ts`) |
| CC-PBUDGET-INV-02 | 月間分・報酬分とも負にならない。両方が尽きた個人のセッションへ新しい作業を払い出さない (実行中は打ち切らない) | 払い出しの判定 `decideDispatch` (`dispatch-policy.ts`)、台帳と累積の保存 (BEGIN IMMEDIATE の中で残高を読んで書く、`src/db/personal-budget-*-repo.ts`) |
| CC-PBUDGET-INV-03 | 全体の日次 budget (停止スイッチ) は個人の予算より優先する | `decideDispatch` の判定の順序 (適用範囲は §13.2) |
| CC-PBUDGET-INV-04 | 同じ根拠の報奨は 1 回だけ付ける | `decideReward` (`reward-policy.ts`)、台帳の一意 index `(entry_type, reward_kind, source_ref)` |
| CC-PBUDGET-INV-05 | 同じ消費を二重に引かない。再起動を跨いでも同じ | `consumptionDelta` と `PersonalBudgetUsageRepo.applyConsumption` (baseline・月間分の累積・`(session_id, period)` の debit を 1 トランザクションで進める) |
| CC-PBUDGET-INV-06 | 調整は本社の権限者だけが行い、誰が・誰に・いくら・なぜを残す。理由の無い調整は受けない | `decideAdjustment` (`adjustment-policy.ts`) と調整 use case (`adjustment-service.ts`) |
| CC-PBUDGET-INV-07 | 本社メンバーと依頼者の無いセッションには個人の予算を適用しない (制限もしない、報奨も付けない) | 個人の解決 `resolveBudgetPerson` (`person-resolution.ts`) |
| CC-PBUDGET-INV-08 | 残高と履歴は本人と本社の権限者にだけ見せる | `/budget`・`/reward` の ephemeral 応答、通知は DM、API は loopback の管理 UI。ログ・監査記録・共有チャンネルの返信に残高を載せない |

## 3. 消費

**Requirement ID: `SPEC-PBUDGET-CONSUME`**

- 個人の消費は、依頼者 (session metadata の `discord_requester_user_id` と所属会社) を持つセッションの
  累積トークンの正の差分で数える。既存の使用量サンプルと同じ流儀で、負の差分は 0 にする。
- 割り当て (純関数): 差分を月間分の残りから引き、足りないぶんを報酬分から引く (CC-PBUDGET-INV-01)。
  報酬分から引いたぶんだけ台帳へ `debit` を書く。月間分の消費は `(個人, 月)` の累積で持つ。
- 月間分の上限が 0 の個人は「上限なし」として扱い、報酬分を引かない (既定。現状の動きを変えない)。
- 子会社の日次 budget が超過中は、月間分が残っていても月間分では通さない。報酬分が正の個人だけ通し、
  その間の消費は報酬分から引く (報奨は「チームが上限でも自分は使える」権利でもある)。
- 全体の日次 budget が超過中は誰も通さない (CC-PBUDGET-INV-03)。

| 全体 | 子会社の日次 | 月間分の残り | 報酬分 | 払い出し | 引く先 |
|---|---|---|---|---|---|
| 超過 | — | — | — | 止める | — |
| 余裕 | 余裕 | あり | — | 通す | 月間分 |
| 余裕 | 余裕 | なし | あり | 通す | 報酬分 |
| 余裕 | 余裕 | なし | なし | 止める | — |
| 余裕 | 超過 | — | あり | 通す | 報酬分 |
| 余裕 | 超過 | — | なし | 止める | — |

- 止めるときは理由 (月間分が尽きた / 子会社が上限 / 全体が上限) と、報酬分の残りを依頼者へ返す。
- 月間分の上限は、子会社ごとの既定値と個人ごとの上書きを持つ。設定は本社の WebUI と子会社の管理画面で行う。

状態所有者: 月間分の累積と報酬分の台帳 = personal-ai-budget。全体と子会社の日次 budget = observability (既存)。
personal-ai-budget は払い出しの判定へ「この依頼者を通してよいか・どこから引くか」を答える port を提供し、
observability の表を直接書かない。

## 4. 報奨の種類

**Requirement ID: `SPEC-PBUDGET-REWARD`**

報奨は種類 (`kind`) と根拠 (`source_ref`) を持つ。種類ごとの加算量は設定で変えられ、付与済みのぶんは遡って変えない。

| 種類 | いつ付くか | 根拠 (`source_ref`) | 受取人 | 歯止め |
|---|---|---|---|---|
| `bounty` | バグ報告の反映を確認した時点 ([バグバウンティ](bug-bounty.md) §7) | 報告 id | 報告の受取人 | 重複・自己起因は付けない |
| `tabula` | 相談の公開候補を本人が承認し、Tabula への投稿が成功した時点 | 公開候補 (`consultation_publications`) の id | 相談者 | 1 公開 1 回 |
| `manual` | 本社の権限者が調整した時点 (§6) | 調整の id | 指定した個人 | 理由必須 |

- 技術相談は、相談しただけでは報奨を付けない。Tabula へ公開したものにだけ付ける (2026-10-02 neco「公開したものに対して報酬」)。
- 受取人が本社所属、または個人を特定できないときは付けない (CC-PBUDGET-INV-07)。付けなかった理由を記録する。
- 各ドメイン (bug-bounty・consultation) は「この根拠でこの個人へ」と依頼するだけで、加算量と一意性は
  personal-ai-budget が決める。他ドメインから台帳を直接書かない。
- 付与したら受取人へ知らせる (Discord は本人宛て、応答は本人にだけ)。届かなくても付与は取り消さない (CC-INV-06)。
- 根拠が後から無効になった場合 (バグ報告の判定が覆った等) は、未使用ぶんを上限に `revoke` を書く。

### 4.1 子会社の相談でも Tabula へ公開できるようにする

**Requirement ID: `SPEC-PBUDGET-TABULA-SUBSIDIARY`**

現状、公開候補 (`/consult wrap`) は本社の相談にしか出ない ([技術相談](tech-consultation.md) §6)。本社メンバーは報奨の
対象外なので、このままでは `tabula` の報奨を受け取れる人が居ない。子会社の相談にも公開候補を出す。

- 子会社の相談セッションはツールを持たず、候補を自分で提出できない (CC-CONSULT-INV-07)。候補は Cc が
  相談の記録から作る (セッションへは依頼しない)。書き直した要約で、会話の転載・個人・社内固有・秘密を含めない。
- 公開・公開しないを決められるのは相談者本人だけ (CC-CONSULT-INV-04 のまま)。投稿先は本社と同じ Tabula。
- 公開すると子会社の相談の要約が Tabula のメンバー共有に載る。この共有範囲は、判断を求めた報告への neco の回答「よい」
  (2026-10-02) を了承として扱う。

## 5. 加算量の既定値 (提案値・未承認)

| 種類 | 加算トークン | 設定キー |
|---|---|---|
| `bounty` s1 / s2 / s3 / s4 | 2,000,000 / 1,000,000 / 500,000 / 100,000 | `personal_budget.reward.bounty.s1`〜`s4` |
| `tabula` | 300,000 | `personal_budget.reward.tabula` |

`bug-bounty.md` §7.2 の設定キー (`bounty.reward_tokens.*`) は使わず、上のキーに一本化する。

## 6. 本社の調整 (「〇〇に報酬」)

**Requirement ID: `SPEC-PBUDGET-ADJUST`**

- 本社 guild の `/reward user:@〇〇 tokens:<数> reason:<理由>`。`tokens` が負なら減額 (残高は 0 まで)。
  操作できるのは社員名簿の権限者 (既定は管理職以上) だけ (CC-PBUDGET-INV-06)。
- 対象は子会社に所属する個人。同じ人が複数の子会社に居るときは `subsidiary` を指定する (未指定で決まらなければ
  付けずに候補を返す)。本社メンバーへの調整は受けず、理由を返す。
- WebUI の残高ページからも同じ use case で調整できる。
- 調整は台帳に `manual` として残し、対象の本人へ知らせる。

## 7. 見える場所

**Requirement ID: `SPEC-PBUDGET-VIEW`**

- 本人: `/budget` で今月の月間分 (上限・使用・残り)、報酬分の残り、直近の履歴。応答は本人にだけ返す (CC-PBUDGET-INV-08)。
  `bug-bounty.md` の `/bug balance` は作らず、これに一本化する。
- 本社の WebUI「個人の AI 予算」ページ: 個人ごとの月間分と報酬分、台帳 (grant / debit / revoke / manual)、
  月間分の上限の設定、調整。一覧はページングし、台帳は個人単位で取る。
- API: `GET /v1/personal-budget/people`、`GET /v1/personal-budget/people/:id/ledger`、
  `PUT /v1/personal-budget/people/:id/monthly-limit`、`POST /v1/personal-budget/adjustments`。admin auth の配下。

## 8. データ

| テーブル / 列 | 内容 | ドメイン |
|---|---|---|
| `personal_budget_people` | id、会社、プラットフォーム、プラットフォームのユーザー id、表示名 (一覧と通知の文面用)、月間分の上限の上書き (null = 子会社の既定)。`(会社, プラットフォーム, ユーザー id)` で一意 | personal-ai-budget |
| `personal_budget_monthly_usage` | 個人、月 (`YYYY-MM`)、使用トークン。`(個人, 月)` で一意 | personal-ai-budget |
| `personal_budget_session_seen` | session id、最後に数えた累積トークン。二重計上を防ぐ baseline | personal-ai-budget |
| `personal_budget_ledger` | id、個人、種別 (grant / debit / revoke / manual)、トークン数、報奨の種類と根拠、session id と期間 (debit)、操作者と理由 (manual)、時刻、本人への通知の状態 (none / pending / delivered / failed) と試行回数。トークン数は報酬分の増減を符号付きで持ち、残高は合計。`(種別, kind, source_ref)` と `(session_id, period, 種別)` で一意 | personal-ai-budget |
| `subsidiaries.personal_monthly_token_budget` | 子会社の個人の月間分の既定値 (0 = 上限なし) | personal-ai-budget (列の追加)、行の所有は既存のまま |
| 設定 `personal_budget.reward.*` | 加算量 | configuration |

## 9. 未確認・未決

- 加算量の既定値 (§5)、月間分の既定値 (子会社ごとに人が設定。既定は上限なし)。
- 子会社の budget 判定が 1 か所に集まっているか → 実装時に確認した (§13.1)。全体の日次 budget を子会社の受付で
  全員に適用するかは未決 (§13.2)。
- 委託の子セッションが親の依頼者を引き継いでいるか → 引き継いでいない (§13.3)。引き継がせるかは未決。
- 受付チャンネル経由の依頼は依頼者を session に残していない (§13.3)。残すかは未決。
- 本社メンバーが子会社の guild で依頼した場合の扱い (§13.4)。

## 10. 失敗・中断からの回復

| 場面 | 扱い |
|---|---|
| 報奨の依頼が再送された | `(kind, source_ref)` の一意制約で同じ行を返す |
| 消費の計上中に Cc が再起動 | baseline (`personal_budget_session_seen`) から数え直す。負の差分は 0 |
| 月をまたぐセッション | 差分を数えた時点の月へ計上する |
| 報奨の通知に失敗 | 付与は確定のまま。台帳の行に通知待ちが残り、本社の Bot が周期で再送する。5 回試して届かなければ再送をやめる (本人は `/budget` で確認できる) |
| 個人を特定できない | 制限も報奨もしない。理由を記録する |

## 11. 実装の境界

```text
src/personal-budget/            割り当て・払い出しの判定・報奨の可否 (純関数)、消費の計上 / 報奨 / 調整の use case
src/db/personal-budget-*-repo   台帳と累積の保存・CAS
src/api/personal-budget*        HTTP 境界
src/discord/commands/reward、src/discord/commands/budget
web/src/pages/PersonalBudget*   WebUI
```

判断は Discord SDK・Hono・DB 接続・`process.env` に依存させない。払い出しの判定 (`src/cost/` と chat / delegation の経路) へは
port を渡すだけにする。

A の実装での配置:

| ファイル | 役割 | 要件 |
|---|---|---|
| `src/personal-budget/allocation.ts`、`dispatch-policy.ts`、`person-resolution.ts`、`session-facts.ts` | 割り当て・払い出しの判定・個人の解決 (純関数) | `SPEC-PBUDGET-CONSUME` |
| `src/personal-budget/reward-policy.ts`、`reward-settings.ts` | 報奨の可否と加算量 (純関数) | `SPEC-PBUDGET-REWARD` |
| `src/personal-budget/adjustment-policy.ts` | 調整の可否と対象の会社 (純関数) | `SPEC-PBUDGET-ADJUST` |
| `src/personal-budget/format.ts` | 本人へ見せる文面 (純関数) | `SPEC-PBUDGET-VIEW` |
| `src/personal-budget/consumption-service.ts`、`dispatch-service.ts`、`reward-service.ts`、`adjustment-service.ts`、`view-service.ts`、`notification-service.ts` | use case | 上の各要件 |
| `src/personal-budget/ports.ts` | use case が要求する保存の port | — |
| `src/personal-budget/composition.ts` | repository を use case の port へつなぐ組み立て。Cc 本体と Bot が同じ use case を得る | `SPEC-PBUDGET-CONSUME` ほか |
| `src/personal-budget/periodic.ts` | 消費の計上と通知の配達の周期実行 (前の周期と重ねない、停止は重ねて呼んでも安全) | `SPEC-PBUDGET-CONSUME`、`SPEC-PBUDGET-REWARD` |
| `src/discord/personal-budget-discord.ts` | Discord の語彙 (guild の在籍・DM) と use case の間の adapter | `SPEC-PBUDGET-ADJUST`、`SPEC-PBUDGET-VIEW` |
| `web/src/pages/PersonalBudget.tsx` | WebUI「個人の AI 予算」。一覧 (ページング)・個人単位の台帳・月間分の上限の上書き・調整 | `SPEC-PBUDGET-VIEW`、`SPEC-PBUDGET-ADJUST` |
| `web/src/pages/subsidiaries/SubsidiariesSection.tsx` | 子会社の設定画面。個人の月間分の既定値 (`personal_monthly_token_budget`) の入力欄を持つ | `SPEC-PBUDGET-CONSUME` |

## 12. 分割

| # | リポ | 内容 | task md |
|---|---|---|---|
| A | Cc | 台帳・月間分と報酬分の消費・払い出しの判定・`/budget`・本社の調整 `/reward`・WebUI (§3・§6・§7・§8) | `spec/tasks/2026-10-02-personal-budget-core.md` |
| B | Cc | Tabula 公開の報奨、子会社の公開候補 (§4・§4.1) | `spec/tasks/2026-10-02-personal-budget-consult-tabula.md` |

A はバグバウンティの実装と独立に進められる。バグバウンティ 3/5 (反映確認と報奨) は A のマージ後に進め、
報奨は本書の port へ依頼する。B は A のマージ後。

## 13. A の実装で確定したこと (2026-10-02)

Actio タスク参照: `actio:43f50e26-20db-4483-a69a-01bf74d06a2b`。当初の実装時はテスト未実行。

### 13.1 払い出しを止める既存の経路

| 見ている budget | 経路 | 個人の予算の port |
|---|---|---|
| 子会社の日次 | `evaluateSubsidiaryRequest` (`src/subsidiary/gate.ts`)。子会社の受付チャンネルと Session forum の起動が共有する 1 か所 | 通す (`SubsidiaryGateDeps.personalBudget`)。Cc 本体と chat-worker の両方で配線 |
| 全体の日次 | `/v1/spawn` (`src/api/spawn.ts`)、雑務 (`src/chores/service.ts`)、CDGD マネジメント (`src/management/dispatcher.ts`)、ルール提案 (`src/bootstrap/core.ts` の `rulesDisabled`) | 通さない。どれも子会社の個人を依頼者に持たない経路で、個人を解決できない |

子会社の相談 (`/consult`) と `/v1/admin/spawn-session`、委託の起動 (`/v1/delegation/invoke`) は、全体・子会社のどちらの
budget も見ていない (現状のまま)。ここへ個人の判定を足すかは未決。

### 13.2 全体の日次 budget の適用範囲

子会社の受付は、導入前は全体の日次 budget を見ていなかった。「月間分の上限が 0 の個人では現状の動きを変えない」ため、
全体の超過で止めるのは個人の予算が効いている人 (月間分の上限が 1 以上、または報酬分が 1 以上) だけにした。
効いていない人は従来どおり子会社の日次 budget だけで決まる。§3 の表の 1 行目を全員へ適用するには、子会社の受付へ
全体の停止を足す判断が要る。

### 13.3 依頼者の帰属

- 消費を個人へ帰属できるのは、session metadata に `subsidiary_id` と `discord_requester_user_id` の両方があるセッション。
  Session forum の起動 (`forum-spawn.ts`)、`/consult`、`/spawn` はこれを満たす。
- 委託の子セッションは親の依頼者を引き継がない。`/v1/delegation/invoke` は依頼の body の
  `requester_discord_user_id` だけを使い、親セッションの metadata を読まない。子の消費は個人へ帰属しない。
- 受付チャンネル経由の依頼 (`processSubsidiaryRequest`) は起動に `requester_discord_user_id` を渡していない。
  払い出しの判定は効くが、その後の消費は個人へ帰属しない。渡すと起動通知で依頼者へメンションが飛ぶようになるため、変えていない。
- Slack の依頼者は session に残らない (判定は効くが、消費は帰属しない)。

### 13.4 個人と本社メンバーの判定

- 個人は「会社・プラットフォーム・ユーザー id」の組。会社を持たない (本社の) 依頼・セッション・受取人は対象外にする。
  本社内 desk の依頼者も本社として扱う。
- 本社メンバーが子会社の guild で依頼すると、その子会社の個人として数える (組で識別するため)。月間分の既定は
  上限なしなので、設定しない限り制限は掛からない。
- `/reward` の対象の会社は、社員名簿ではなく子会社の guild の在籍で確かめる ([社員名簿 §9](staff-roster.md))。
  どの子会社にも在籍しない人は本社メンバーとして断る。在籍を確かめられないときは付けずに理由を返す。
- 個人の行は、子会社の受付で依頼したとき・報奨や調整を受けたとき・消費を数えたときに作る。行より前から動いていた
  セッションの累積は数えない (導入前の消費を今月へ一括計上しない)。

### 13.5 見える場所

- 払い出しを止めたときの返信は共有チャンネルへ出るので、理由だけを返し、報酬分の残りは `/budget` (本人にだけ表示) へ案内する。
- 付与・調整・取り消しの通知は本人への DM。`/reward` の応答は操作者にだけ返す。
- `/budget` は子会社の guild にも出す (その会社の分だけ)。`/reward` は本社の guild だけ。
- 付けなかった報奨の理由はログへ種類と理由だけを残す (専用の表は持たない)。
- API は他の管理 API と同じ loopback の信頼境界に置く (`/v1/admin/*` も実体は同じ境界で、専用の認可 middleware は無い)。

## 14. main 統合と検証 (2026-10-03)

人間指示「Cc片っ端からマージで」に基づき、同じ Actio A の変更を local main e9c52b5dへ統合する。
単体・登録回帰、メモリ内migrationとbackend/web型の実行は今回許可済み。サービス操作・公開pushは子で実施しない。

migration採番の競合では、main123〜126とその凍結checksumを保持し、未マージPB123を127へ変更。
全migrationをmemory DBへ適用して測定した127 checksumは
`10d26bc6fa8af257fd0176135a2570811b9f4f67d7fa7612b8eb9b64ee9661d3`、schema fingerprintは
`7e9f47c38630a6b586120232f1ac81ecf00894da37791efde8235706c542bdee`。
旧版126から127への移行は既存usage budget行と旧台帳を保持し、再適用は重複しないことを回帰に記述。
本番DBを開かず、凍結済みmainのchecksumや本文を再定義しない。

契約台帳のmain50件と受入台帳の482行 (重複source行を含む) を保持し、PBの5契約・32対応行を追記。
Augur登録も既存IDを保持してPB22件を統合。Discordはmainの毎朝9時の相談整理を維持し、
PB本人DMの本社限定通知loopと停止対だけを追加する。bootstrap/API/子会社gateは既存機能の配線を残す。
仕様13.2〜13.4の未決政策 (全員への全体budget適用・委託/受付依頼者継承等) は変えない。
未回答判断 task `2348bee8-b58e-4f12-8553-63984e1a4909` を解除せず、再審査は親が正規経路で行う。

復旧は新しいmigrationを適用する通常の再起動照合に従う。適用後の127台帳を旧123と読み替えたり、
残高・消費履歴を削除したりしない。コードを戻す場合も永続台帳を維持して互換版で照合する。
実画面・Discord DM配送・権限実機評価、Tabula報奨Bは未検証/未実装のまま。

統合の自動mergeで `bootstrap/core.ts` の readSessionUsage importが二重になりTS2300。
main既存importを残してPB追加の重複1行だけ除去し、backend型を再確認して合格。web型も合格。
test型はbaseから未変更の startup-policy-check.test.ts:50 / usage-budget-spawn.test.ts:27の
claude/ProviderName不一致2件が残る (本変更では直さない)。

第1検証: migration2files25件、PB policy/usecase11files98件、DB/API5files28件、gate5files36件合格。
Discord/settings7filesは103件合格/1件失敗。settings coverageがmain既存の未登録env4件
(CONCORDIA_CODEX_MODEL_CATALOG_EXECUTABLE / CONCORDIA_CONSULT_ASTRA_TEMPLATE /
CONCORDIA_CONSULT_OPUS_TEMPLATE / CONCORDIA_TEAM_ID)を検出。PB追加のDB設定はcoverage合格。
web2files7件は失敗:継承NODE_ENV=productionでReact19がactをexportしない。
react/index.jsのproduction分岐とReact.act=undefinedを確認。テスト環境を明示して再検証する。
最初の失敗を隠さず、結果不明や再試行だけの合格を原因修正とは記さない。

最終統合: local main75f952da (#2357表示抑止・#2358相談返信)へ追加rebase。
main51契約/485受入行/793登録行を全内容保持し、PB5契約/32対応行/22登録を維持した。
migration SQL/順序は初回統合から変わらず、checksum/fingerprintは上記memory測定値のまま。

登録回帰の最小追補は別の一括管理task `actio:ec877263-c52b-4ecd-89f3-f2595c80a2b4` の
「登録テスト失敗を解消し修正再審査を継続」と人間指示に対応する。PB機能自体は元Actio Aが所有する。
実設定3件をLLMのenv専用・readonly・DBキー無しで登録し、既定をnull/astra-mid/opus-5-5-movableに固定。
TEAM_IDは既存の子への書出識別子群へ理由付き追加 (新しい検査除外分類やスキャン緩和なし)。
値の出所、既定、DB上書き不可、更新拒否/無書込をregistry testに、TEAMの意味をcoverage testに追加。
configuration所属/specRef・source/tests対応を併記し、consumerの挙動/新政策は変えない。

最終成功の異なるケース名で集計: backend35files394件、WebUI2files7件、計37files401件。
実行ログの成功延べ435件にはsettings registry/coverageの初回34件の再確認が含まれる。
当初のcoverage1件失敗とproduction環境のweb7件失敗を成功数へ混ぜない。
最終追補/交差回帰7files138件合格 (6.44秒)、webはNODE_ENV=testを当該コマンドだけへ設定して
2files7件合格 (5.44秒)。Webで既存act環境未設定warningは出るがassertionは全合格。
テストが再試行だけで直ったとは記さず、最初の環境原因を上記の通り保持する。
backend型・web型合格、追補後backend型も合格。旧test型2件は最新版mainからも未変更。
Augur台帳lint valid、PB登録22filesの存在と対応を静的照合。独立した本番observe契約実測は未実施。
既存sourceの登録回帰の和集合は広いbootstrap/botを含むため72filesだったが、
今回のbudget/migration/直接交差境界を分割実施し、無関係な全量を実施済みとは扱わない。
ログ名: cc-pb-migration / policies / db-api / gates / discord-settings / web-test-env / followup.log (実行環境TEMP)。
テスト基盤全域の変更・timeout延長・回帰削除・risk hold手動解除は行っていない。
実DB、実画面、実Discord/Slack配達、サービスbuild/restart、稼働への反映は子では未実施。
