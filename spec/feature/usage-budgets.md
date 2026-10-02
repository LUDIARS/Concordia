# ユーザーとチームの月次予算

> 2026-10-02 neco 指示:「それぞれのユーザーに上限予算があり、相談等はその予算内で出来る。またチームに予算をつけ、
> チームで起動したセッションはチームの予算を消費する」。設計案 (月次・トークン・上限では知らせるだけ) を示し、
> 「実装も着手」(同日)。

- 価値: [UX-CC-W4](../ux/product.md) (通知を見れば今必要な判断が分かる — 上限接近を知らせる) と、
  [UX-CC-W1](../ux/product.md) (権限外の操作が進まない — 予算外の起動が進まない)。
- 失うと困る利用者の状態: 相談やセッションをどれだけ使ってよいかが人ごと・チームごとに決まっておらず、
  一部の人の使いすぎで全体の上限 (日次 budget) に達して他の人の仕事まで止まる。止まってから理由が分かる。
- 関連: [コスト観測](cost-observability.md) (全体の日次 budget)、[子会社の日次予算](subsidiary-delegation.md) §7、
  [バグバウンティ](bug-bounty.md) (個人残高。本予算とは別の台帳で、報奨の付与先として将来つなぐ余地がある)。

## 1. 用語

| 用語 | 意味 |
|---|---|
| 月次予算 | ユーザーまたはチームに割り当てた、暦月 (local) あたりの上限トークン。行が無ければ無制限 |
| 消費 | その月に始まったセッションの provider ログ累積トークン (子会社の日次予算と同じ数え方) |
| 帰属先 | セッションが消費する予算。チームで起動したならチーム、それ以外は依頼者 (Discord ユーザー) |

## 2. 不変条件

| ID | 条件 | 強制箇所 |
|---|---|---|
| CC-BUDGET-INV-01 | 1 セッションはチームか依頼者のどちらか片方の予算だけを消費する (二重に数えない) | `subjectForLaunch` / `subjectForSession` |
| CC-BUDGET-INV-02 | 予算を使い切った帰属先の新しい起動は始めない。理由は本人にだけ返す | admin spawn (`budget_exhausted`、402)、`/consult` の受付前確認 |
| CC-BUDGET-INV-03 | 予算の無い帰属先は今までどおり起動できる (導入で既存の利用を止めない) | `checkLaunch` |
| CC-BUDGET-INV-04 | 80% / 100% の知らせは帰属先・月・閾値ごとに 1 回。配送に失敗したら記録を戻して出し直す | `usage_budget_notices` + `sweepNotices` |

## 3. 消費の数え方

**Requirement ID: `SPEC-USAGE-BUDGET-POLICY`**

- 期間は local の暦月。月の途中で予算を変えたら、その月に始まったセッションをすべて数え直す (遡って適用)。
- 帰属は起動時に焼かれたセッションの `team_id` と `metadata.discord_requester_user_id` から決める。どちらも無い
  セッション (端末から直接起動したもの等) はどの予算も消費しない。
- 動いているセッションは止めない (回答の途中で切らない)。上限に達したら知らせ、次の起動を止める。

## 4. データ

**Requirement ID: `SPEC-USAGE-BUDGET-STORE`**

| テーブル | 内容 |
|---|---|
| `usage_budgets` | 対象の種類 (user / team)・対象 id・月の上限トークン・更新者・時刻 (migration 123) |
| `usage_budget_notices` | 対象・月 ("YYYY-MM")・閾値 (80 / 100)・通知時刻。同じ知らせを二度出さない |

状態所有者: 予算と通知の記録 = observability (`src/cost/usage-budget*.ts`、`src/db/usage-budgets-repo.ts`)。

## 5. 起動の止め方と知らせ

**Requirement ID: `SPEC-USAGE-BUDGET-NOTICE`**

- admin spawn (Session / 部署フォーラム・`/consult`・`/spawn` が通る起動口) で、帰属先の予算に残りが無ければ
  `402 { error: "budget_exhausted: <本人向けの文面>" }` を返す。フォーラムは文面をスレッドへ返す。
- `/consult` はチャンネルを作る前に `GET /v1/usage-budgets/check?user=` で確かめ、使い切っていれば本人にだけ伝えて止める。
- Cc 本体が 10 分ごとに予算を見回り、80% / 100% に達したら `usage_budget.notice` を出す。ユーザーは本社 Bot が
  本人へ DM、チームはチームを持つ Bot がチームのコスト面へ投稿する。

## 6. API と画面

**Requirement ID: `SPEC-USAGE-BUDGET-API`**

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/v1/usage-budgets` | 予算の一覧と今月の消費・割合・使い切りか |
| PUT | `/v1/usage-budgets/:scope/:targetId` | `{ limit_tokens, updated_by? }` 設定 |
| DELETE | `/v1/usage-budgets/:scope/:targetId` | 外す (無制限) |
| GET | `/v1/usage-budgets/check?team=&user=` | 起動前の確認 (`allowed`、使い切りなら `notice`) |

- WebUI: 社員名簿の各行 (Discord の人) とチームのコスト画面に「月の予算 (トークン)」を置く。空欄は無制限。

## 7. 既知の問題 (本設計の外)

- 子会社の日次予算 (`subsidiary/budget.ts`) は日の範囲をミリ秒で渡しているが、`sessions.started_at` は秒のため、
  当日のセッションを 1 本も数えていない (消費が常に 0 で予算が効かない)。直すと既存の子会社 (日次予算を設定済みのもの)
  が実際に止まり始めるため、人の判断を待つ。月次予算はこの換算を adapter で行っている。
