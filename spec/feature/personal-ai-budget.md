# 個人の AI 予算 — 月間分と報酬分

> 2026-10-02 neco 指示:「報酬として AI 予算をあげる」「(付与先は) 個人」「(本社は) 対象外」
> 「Tabula の取り込みと技術相談課についても報酬を用意」「本社で『〇〇に報酬』で調整できるようにする」
> (〇〇は人)「予算だけど月間分と報酬分で分けて、月間予算から先に消費する」「公開したものに対して報酬」。

- 価値: [UX-CC-W8](../ux/product.md) / シナリオ UX-CC-S9
- 所属: `personal-ai-budget` (支援: 運用・組織)。コアドメインではない。
- 関連: [コスト観測](cost-observability.md) (全体と子会社の日次 budget)、[バグバウンティ](bug-bounty.md)、
  [技術相談](tech-consultation.md)、[対話の前提データ](dialogue-context.md) (依頼者メモ)

本書は設計であり、実装・テスト・人間による UX 評価は未実施。金額の既定値 (§5) は提案値で、neco の確認を受けていない。
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

| ID | 条件 | 強制箇所 (実装時に確定) |
|---|---|---|
| CC-PBUDGET-INV-01 | 個人の消費は月間分から先に引き、月間分が尽きてから報酬分を引く | 消費の割り当て (純関数) |
| CC-PBUDGET-INV-02 | 月間分・報酬分とも負にならない。両方が尽きた個人のセッションへ新しい作業を払い出さない (実行中は打ち切らない) | 払い出しの判定、台帳の CAS |
| CC-PBUDGET-INV-03 | 全体の日次 budget (停止スイッチ) は個人の予算より優先する | budget 判定の順序 |
| CC-PBUDGET-INV-04 | 同じ根拠の報奨は 1 回だけ付ける | 台帳の一意制約 `(kind, source_ref)` |
| CC-PBUDGET-INV-05 | 同じ消費を二重に引かない。再起動を跨いでも同じ | `(session_id, period)` 単位の累積の更新 |
| CC-PBUDGET-INV-06 | 調整は本社の権限者だけが行い、誰が・誰に・いくら・なぜを残す。理由の無い調整は受けない | 調整 use case |
| CC-PBUDGET-INV-07 | 本社メンバーと依頼者の無いセッションには個人の予算を適用しない (制限もしない、報奨も付けない) | 個人の解決 (純関数) |
| CC-PBUDGET-INV-08 | 残高と履歴は本人と本社の権限者にだけ見せる | 応答の宛先、API の認可 |

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
| `personal_budget_people` | id、会社、プラットフォーム、プラットフォームのユーザー id、月間分の上限の上書き (null = 子会社の既定)。`(会社, プラットフォーム, ユーザー id)` で一意 | personal-ai-budget |
| `personal_budget_monthly_usage` | 個人、月 (`YYYY-MM`)、使用トークン。`(個人, 月)` で一意 | personal-ai-budget |
| `personal_budget_session_seen` | session id、最後に数えた累積トークン。二重計上を防ぐ baseline | personal-ai-budget |
| `personal_budget_ledger` | id、個人、種別 (grant / debit / revoke / manual)、トークン数、報奨の種類と根拠、session id と期間 (debit)、操作者と理由 (manual)、時刻。`(kind, source_ref)` と `(session_id, period, 種別)` で一意 | personal-ai-budget |
| `subsidiaries.personal_monthly_token_budget` | 子会社の個人の月間分の既定値 (0 = 上限なし) | personal-ai-budget (列の追加)、行の所有は既存のまま |
| 設定 `personal_budget.reward.*` | 加算量 | configuration |

## 9. 未確認・未決

- 加算量の既定値 (§5)、月間分の既定値 (子会社ごとに人が設定。既定は上限なし)。
- 子会社の budget 判定が 1 か所に集まっているか。複数経路なら、個人の判定を足す箇所を実装時に洗い出す。
- 委託の子セッションが親の依頼者を引き継いでいるか。引き継いでいなければ、子の消費は個人へ帰属しない
  (実装時に確認し、引き継がせるかを報告する)。

## 10. 失敗・中断からの回復

| 場面 | 扱い |
|---|---|
| 報奨の依頼が再送された | `(kind, source_ref)` の一意制約で同じ行を返す |
| 消費の計上中に Cc が再起動 | baseline (`personal_budget_session_seen`) から数え直す。負の差分は 0 |
| 月をまたぐセッション | 差分を数えた時点の月へ計上する |
| 報奨の通知に失敗 | 付与は確定のまま。配送は既存の再送条件に従う |
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

## 12. 分割

| # | リポ | 内容 | task md |
|---|---|---|---|
| A | Cc | 台帳・月間分と報酬分の消費・払い出しの判定・`/budget`・本社の調整 `/reward`・WebUI (§3・§6・§7・§8) | `spec/tasks/2026-10-02-personal-budget-core.md` |
| B | Cc | Tabula 公開の報奨、子会社の公開候補 (§4・§4.1) | `spec/tasks/2026-10-02-personal-budget-consult-tabula.md` |

A はバグバウンティの実装と独立に進められる。バグバウンティ 3/5 (反映確認と報奨) は A のマージ後に進め、
報奨は本書の port へ依頼する。B は A のマージ後。
