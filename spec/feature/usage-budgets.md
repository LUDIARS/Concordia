# ユーザーとチームの月次予算

> 2026-10-02 neco 指示:「それぞれのユーザーに上限予算があり、相談等はその予算内で出来る。またチームに予算をつけ、
> チームで起動したセッションはチームの予算を消費する」。設計案 (月次・トークン・上限では知らせるだけ) を示し、
> 「実装も着手」(同日)。
>
> 同日の追加指示:「それぞれのAI作業の途中で各ユーザが予算を使い切った場合、フックで途中で止める。相談等の場合は
> セッションを保存し作業再開できるようにする」(選択「全部保存・再開」= 全部署のセッション)、「いわゆる -resume です。
> また他のユーザーが助けに入った場合はそのユーザーの予算を使います」、「相談はモデルが固定されているので、予算消費を
> 本来のコストの1/4で考えてください。ユーザーの属性と部署それぞれにそのようなコスト倍率があります」。
>
> 2026-10-03 neco 指示:「これはロールで倍率変えられるようにしてほしい」→ 選択「Discord のロール」(複数ロールはいちばん低い
> 倍率)、「特定のロールを持つ人 (新入部員、メンター) などに 0.5 などの倍率をかける」。属性の倍率を社員名簿の役職から
> Discord のロールへ置き換えた。
>
> 同日の追加指示:「AIコストをどれくらい消費したかはCcの各ユーザの管理画面で見れる。複数人で共有をしているセッションは、
> 発言を確認したユーザのその数ごとに消費額を計算する。本社も含む。」→ 選択「指示した人数で割る」、続けて「指示の回数で
> 重みつけます」(同じ区間に A が 2 回・B が 1 回指示したら A に 2/3、B に 1/3)。区間の切り方を AI の応答 1 回ごとに変え、
> 各ユーザーの今月の消費を社員名簿に出した (Actio `actio:6ad0d1fb-2b42-44ad-a074-3782d5574c2a`)。

- 価値: [UX-CC-W4](../ux/product.md) (通知を見れば今必要な判断が分かる — 上限接近を知らせる) と、
  [UX-CC-W1](../ux/product.md) (権限外の操作が進まない — 予算外の起動・作業が進まない)。
- 失うと困る利用者の状態: 相談やセッションをどれだけ使ってよいかが人ごと・チームごとに決まっておらず、
  一部の人の使いすぎで全体の上限 (日次 budget) に達して他の人の仕事まで止まる。止まってから理由が分かる。
  予算を使い切った作業を止めたとき、その続きから再開できない。
- 関連: [コスト観測](cost-observability.md) (全体の日次 budget)、[子会社の日次予算](subsidiary-delegation.md) §7、
  [部署](departments.md) §9.7 (部署の倍率)、[社員名簿](staff-roster.md) (再開を押せる管理者 = 執行役員)、
  [バグバウンティ](bug-bounty.md) (個人残高。本予算とは別の台帳で、報奨の付与先として将来つなぐ余地がある)。

## 1. 用語

| 用語 | 意味 |
|---|---|
| 月次予算 | ユーザーまたはチームに割り当てた、暦月 (local) あたりの上限トークン。行が無ければ無制限 |
| 消費 | その月に始まったセッションの provider ログ累積トークンに倍率を掛けた額 (§3) |
| 帰属先 | 消費を引き受ける予算。起動時はチームで起動したならチーム、それ以外は依頼者 (Discord ユーザー) |
| 起動者 | セッションを起動した Discord ユーザー (`metadata.discord_requester_user_id`) |
| 助けに入った人 | 起動者以外で、そのセッションに Discord から指示を出した人 |
| 倍率 | 部署の倍率 (部署設定) と属性の倍率 (Discord のロールごと)。どちらも既定 1 |
| 中断 | 予算切れでツールを止め、会話を保存してセッションを終えた状態 (§5.2) |

## 2. 不変条件

| ID | 条件 | 強制箇所 |
|---|---|---|
| CC-BUDGET-INV-01 | 消費は二重に数えない。区間の消費を指示の回数で按分した各人の額は合計が区間の消費に等しく、各人の額はチーム・起動者・その人のどれか 1 つの予算だけを消費する | `attributeUsage` / `splitByInstructionCount` / `attributeTotal` |
| CC-BUDGET-INV-02 | 予算を使い切った帰属先の新しい起動は始めない。理由は本人にだけ返す | admin spawn (`budget_exhausted`、402)、`/consult` の受付前確認 |
| CC-BUDGET-INV-03 | 予算の無い帰属先は今までどおり起動・作業できる (導入で既存の利用を止めない) | `checkLaunch` / `decideBudgetGate` |
| CC-BUDGET-INV-04 | 80% / 100% の知らせは帰属先・月・閾値ごとに 1 回。配送に失敗したら記録を戻して出し直す | `usage_budget_notices` + `sweepNotices` |
| CC-BUDGET-INV-05 | 予算から引く額 = 本来のトークン × 部署の倍率 × 消費する人の属性の倍率。部署ごとの値をコードに持たない | `chargedTokens` |
| CC-BUDGET-INV-06 | 作業中でも、その時点の帰属先の予算が尽きたらツールを止め、中断を 1 回だけ記録してから終える | `UsageBudgetGate` |
| CC-BUDGET-INV-07 | 再開は予算が戻ってから、起動者・助けに入った人・管理者だけが行える。同じ中断を二度起動しない | `resumeSuspendedSession` |
| CC-BUDGET-INV-08 | 属性の倍率は、その人が持つロールのうち倍率を設定したロールのいちばん低い倍率。該当なし・ロールが引けないときは 1 (数え方の不調で倍率を上げない) | `lowestRoleMultiplier` / `DiscordRoleMultiplierResolver` |

## 3. 消費の数え方

**Requirement ID: `SPEC-USAGE-BUDGET-POLICY`**

- 期間は local の暦月。月の途中で予算や倍率を変えたら、その月に始まったセッションをすべて数え直す (遡って適用)。
- 起動時の帰属は起動時に焼かれたセッションの `team_id` と `metadata.discord_requester_user_id` から決める。どちらも無い
  セッション (端末から直接起動したもの等) はどの予算も消費しない。

### 3.1 倍率

**Requirement ID: `SPEC-USAGE-BUDGET-MULTIPLIER`**

- 予算から引く額 = 本来のトークン × 部署の倍率 × 消費する人の属性の倍率。80% / 100% の判定・知らせ・起動時の判定・
  作業中の判定 (§5.2) はすべてこの額で行う。
- 部署の倍率: 部署設定 `budget.cost_multiplier` (0 < x ≤ 10、既定 1。[部署](departments.md) §9.7)。セッションの
  `department_id` の部署を使う。部署が無い・設定が読めなければ 1。
- 属性の倍率: Discord のロール (guild ごとのロール id) ごとの倍率表 (`usage_budget_role_multipliers`)。指示を出した人が持つ
  ロールのうち、倍率を設定したロールの**いちばん低い倍率**を使う (新入部員 0.5・メンター 0.8 の両方を持つ人は 0.5)。
  倍率を設定したロールを 1 つも持たない人は 1。
  - 人のロールは Discord Bot (本社・子会社。同じ token の Client は共有) が在籍する全 guild の member から引く
    (`src/discord/member-roles.ts`)。@everyone は除く。在籍しない guild (Unknown Member) は飛ばす。
  - cost 層は Discord を import しない。bootstrap が「Discord user id → ロール id の一覧」を返す関数を差し込み、
    `DiscordRoleMultiplierResolver` (`src/cost/budget-role-multiplier.ts`) が人ごとに 5 分キャッシュする。
  - Bot が動いていない・取得に失敗したときは 1 に倒し、その結果はキャッシュしない (次の集計で引き直す)。倍率表が空なら
    Discord に問い合わせない。倍率を API で変えたらロールのキャッシュと集計のキャッシュを捨てる。
- 消費する人: その区間に指示を出した人 (§3.2)。複数いれば按分した額ごとに、その人の属性の倍率を掛ける
  (按分した額 × 部署の倍率 × その人のロールの倍率)。指示が無い区間は起動者。チームの予算から引くときも、指示を出した人の
  属性の倍率を使う。
- 相談課 2 部署の 0.25 はデータ設定 (部署の PATCH) で入れる。

### 3.2 指示を出した人ごとの帰属

- 消費は時刻つきで読む (Claude Code は transcript の assistant 行の `timestamp` と usage、Codex は `token_count` の
  累積の増分)。指示を出した人は session events の inject の `source` (`discord:<user id>:…`) と時刻から取る。
- **区間** = AI の応答 1 回。前の AI の最終回答の直後から、次の AI の最終回答まで (最終回答の消費を含む)。最後の最終回答
  より後 (応答中) は開いた区間。最終回答の印は provider ログから取る (2026-10-03 に実データで確認):
  - Claude Code: transcript の assistant 行の `message.stop_reason` が `tool_use` / `pause_turn` 以外 (`end_turn` 等)。
    ツールを呼ぶ途中の応答は `tool_use`。1 つの message は content ごとに同じ `message.id` の複数行に分かれ、どの行に
    `stop_reason` があっても印にする。`stop_reason` が無い (null) 行は印にしない。
  - Codex: rollout の `event_msg` で `payload.type` が `task_complete` の行 (消費 0 の印。直前の `token_count` までが区間)。
  - 印が 1 つも無いログ (古い transcript 等) はセッション全体が 1 つの区間になる。
- **区間の指示** = その区間の時刻に入る人の指示 (inject の時刻 ≦ 区間の最終回答。最初の区間は最初の最終回答までのすべて)。
- **配分**: 区間の消費を、その区間に各人が出した指示の回数で按分する。A が 2 回・B が 1 回なら A に 2/3、B に 1/3。
  1 人なら全額。読んだだけ (指示を出していない) の人には付けない。按分した各人の額の行き先は:
  - 起動者 → 起動時の帰属先 (チームで起動したならチーム、それ以外は起動者のユーザー予算)。
  - 起動者以外の人 (助けに入った人) → その人のユーザー予算。
  - 倍率は按分した額に人ごとに掛ける (§3.1)。
- 指示が無い区間 (起動時の初回指示への応答、指示なしに続けた応答) → 起動時の帰属先 (チーム → 起動者)、倍率は起動者。
- 次のときは区間を分けず、合計を起動時の帰属先へ付ける (従来の数え方に倒す):
  - 時刻つきの消費が読めない (codex-sdk、transcript が無い・信頼できる置き場所に無い)。
- 起動者が分からない (チームだけで起動した等) セッションは、助けに入った人を区別できないため、按分した額をすべて起動時の
  帰属先に付ける (倍率だけ按分した各人のものを使う)。
- Slack からの指示と Cc の制御 inject は「人の指示」として扱わない。
- 作業中の判定 (§5.2) は区間の集計を待たず、その時点の直前に指示を出した人の帰属先で判定する (`responsibleAt`)。
- 実装: 区間の切り方と按分 `src/cost/instruction-split.ts` (`turnSegments` / `splitByInstructionCount`)、帰属先への振り分け
  `src/cost/usage-attribution.ts` (`attributeUsage`)、最終回答の印 `src/cost/usage-timeline.ts`。

## 4. データ

**Requirement ID: `SPEC-USAGE-BUDGET-STORE`**

| テーブル / 置き場所 | 内容 |
|---|---|
| `usage_budgets` | 対象の種類 (user / team)・対象 id・月の上限トークン・更新者・時刻 (migration 123) |
| `usage_budget_notices` | 対象・月 ("YYYY-MM")・閾値 (80 / 100)・通知時刻。同じ知らせを二度出さない |
| `usage_budget_role_multipliers` | Discord のロール id・その guild id・倍率 (0 < x ≤ 10)・更新者・時刻 (migration 125 で役職から置き換え。旧値は捨てた — 本番は未設定で 0 件)。行が無いロールは 1 |
| 部署設定 `budget.cost_multiplier` | 部署の倍率 (departments.settings_json) |
| `sessions.metadata.budget_suspension` | 中断の記録 (§5.2)。時刻・帰属先・会話 id・作業ディレクトリ・再開を押せる人・再開の記録 |

状態所有者: 予算・通知・倍率表 = observability (`src/cost/usage-budget*.ts`、`src/cost/budget-*.ts`、
`src/db/usage-budgets-repo.ts`、`src/db/usage-budget-multipliers-repo.ts`)。部署の倍率 = 部署 (governance)。
人のロール・guild のロール一覧 = Discord (chat-platforms、`src/discord/member-roles.ts`。読むだけで保存しない)。
中断の記録 = セッション (`sessions.metadata`、書くのは `UsageBudgetGate` と `resumeSuspendedSession` だけ)。

## 5. 止め方・知らせ・再開

### 5.1 起動を止める・知らせる

**Requirement ID: `SPEC-USAGE-BUDGET-NOTICE`**

- admin spawn (Session / 部署フォーラム・`/consult`・`/spawn` が通る起動口) で、帰属先の予算に残りが無ければ
  `402 { error: "budget_exhausted: <本人向けの文面>" }` を返す。フォーラムは文面をスレッドへ返す。
- `/consult` はチャンネルを作る前に `GET /v1/usage-budgets/check?user=` で確かめ、使い切っていれば本人にだけ伝えて止める。
- Cc 本体が 10 分ごとに予算を見回り、80% / 100% に達したら `usage_budget.notice` を出す。ユーザーは本社 Bot が
  本人へ DM、チームはチームを持つ Bot がチームのコスト面へ投稿する。

### 5.2 作業の途中で止める

**Requirement ID: `SPEC-USAGE-BUDGET-SUSPEND`**

- ハーネスの gate (`POST /v1/harness/gate`、ツール実行前のフックが呼ぶ) で、その時点の消費を引き受ける帰属先
  (§3.2。直前に指示を出した人で決まる) の予算が倍率込みで尽きていれば、ツールを deny する (rule `usage-budget`)。
  理由は「予算を使い切ったので作業を止めます。予算が戻ったら再開できます。」。予算が無い帰属先は判定しない。
- 月の消費の集計は重いので 3 分キャッシュする (ツール実行ごとにログを読まない)。予算・倍率を API で変えたら捨てる。
  判定に失敗したらツールを止めない (集計の不調で全作業を止めない)。
- 初めて尽きたときに 1 回だけ、セッションの metadata に中断の記録 (`budget_suspension`: 時刻・帰属先・会話 id・
  会話を始めた作業ディレクトリ・起動者と指示を出した人) を残し、admin stop と同じ通常の終了手順でセッションを終える
  (`stopWrappedSession`、`stopped_by: "budget"`)。記録したあとのツールも止め続ける。
- 会話 id は Claude Code の transcript のファイル名 (`<会話 id>.jsonl`、`claude --resume` に渡せる id)。作業ディレクトリは
  transcript 先頭の `cwd` (claude は起動した cwd の project フォルダから会話を探すため)。読めなければ `repo_path`。
- フックは Lictor が `--settings` で渡すので、相談の専用設定フォルダ (`CLAUDE_CONFIG_DIR`) でも効く。
- 実装: 判定と中断の記録 `src/cost/budget-suspension.ts` (`decideBudgetGate` / `readSuspension` / `conversationIdFromTranscript`)、
  判定サービス `src/cost/usage-budget-gate.ts`、会話 id と作業ディレクトリ `src/cost/conversation-launch.ts`、
  終了手順 `src/control/wrapped-session-stop.ts`、gate への差し込み `src/api/harness-session.ts` (`budgetGate`)。

### 5.3 再開

- Cc 本体が通知の見回り (10 分ごと) の後に中断を見回り、止めた帰属先の予算が戻っていれば (月が替わった・上限を
  上げた・予算を外した) `usage_budget.resumable` を 1 回だけ出す。そのセッションを持つ Bot が、セッションのスレッドへ
  「再開」ボタンを出す。
- ボタンを押すと Bot が `POST /v1/usage-budgets/suspensions/:sessionId/resume { actor_user_id }` を呼ぶ。押せるのは
  中断したセッションの起動者・助けに入った人・管理者 (社員名簿の執行役員)。予算がまだ尽きていれば 402。
- 再開は同じ作業ディレクトリ・同じテンプレート (`delegation_call_name`)・同じ部署・同じチーム・同じ依頼者・同じモデルと
  effort で `claude --resume <会話 id>` を起動する。プロジェクトを持たない相談部署は相談専用の設定フォルダとツール制限を
  同じに付ける。初回指示は渡さない。起動の前に再開の記録を確保し、起動に失敗したら戻す (二度押しでも 1 回だけ起動)。
- 実装: 見回りと再開の判断 `src/cost/budget-resume.ts` (`offerBudgetResumes` / `resumeSuspendedSession`)、押せる人・再開できる状態
  `src/cost/budget-suspension.ts` (`canResumeSuspension` / `isResumable`)、起動指示 `src/control/budget-resume-launch.ts`、
  Discord のボタン・押下・配送 `src/discord/budget-resume.ts`。

## 6. API と画面

**Requirement ID: `SPEC-USAGE-BUDGET-API`**

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/v1/usage-budgets` | 予算の一覧と今月の消費 (倍率込み)・割合・使い切りか |
| PUT | `/v1/usage-budgets/:scope/:targetId` | `{ limit_tokens, updated_by? }` 設定 |
| DELETE | `/v1/usage-budgets/:scope/:targetId` | 外す (無制限) |
| GET | `/v1/usage-budgets/check?team=&user=` | 起動前の確認 (`allowed`、使い切りなら `notice`) |
| GET | `/v1/usage-budgets/users` | ユーザーごとの今月の消費 (`{ month, users: [{ user_id, consumed_tokens, team_tokens, budget }] }`、§6.1) |
| GET | `/v1/usage-budgets/role-multipliers` | Discord のロールごとの倍率 (`role_id` / `guild_id` / `multiplier`) |
| GET | `/v1/usage-budgets/discord-roles` | 倍率を設定できるロール (`guilds: [{ guild_id, guild_name, roles: [{ id, name }] }]`。@everyone と連携アプリのロールを除き上位から。Bot 停止中は空) |
| PUT | `/v1/usage-budgets/role-multipliers/:roleId` | `{ guild_id, multiplier, updated_by? }` 設定 (0 < x ≤ 10。id は数字) |
| DELETE | `/v1/usage-budgets/role-multipliers/:roleId` | 外す (1 に戻す) |
| GET | `/v1/usage-budgets/suspensions` | 予算切れで中断したセッション (未再開) |
| POST | `/v1/usage-budgets/suspensions/:sessionId/resume` | `{ actor_user_id }` 再開 (403 / 402 / 409 / 502) |

### 6.1 各ユーザーの今月の消費

- 「各ユーザーの管理画面」は社員名簿 (`web/src/pages/Staff.tsx`) の各人の行とする。Cc の WebUI で人ごとに予算・役職を
  管理している唯一の場所で、本社・子会社どちらの Discord の人も LLM に触れた時点で自動で載る。
- 社員名簿の Discord の人の行に「今月の消費 (倍率込み)」を出す (`web/src/pages/staff/UserMonthlyUsageCell.tsx`)。予算を
  設定していない人・本社の人にも出す。今月まだ消費していない人は 0。
- 消費 = その人が消費する人として付いた額の合計 (§3.2 で按分した額 × 部署の倍率 × その人のロールの倍率)。チームで起動した
  セッションの起動者の指示ぶん (チーム予算から引いた額) も含め、その内訳を「うちチーム」として添える。
- 予算があれば割合も出す。割合は隣の「月の予算」欄が、ユーザー予算から引いた額 (チームのぶんを含まない) で出す。
- `GET /v1/usage-budgets/users` の行: `consumed_tokens` = 上の消費、`team_tokens` = うちチーム予算ぶん、`budget` =
  ユーザー予算があるときだけ `{ limit_tokens, consumed_tokens, ratio, exhausted }` (consumed_tokens はユーザー予算から引いた額)。
  今月消費した人は予算の有無に関係なく全員、ユーザー予算を持つ人は消費が 0 でも行を持つ。消費の多い順。
- 起動者も指示を出した人も分からないセッション (端末から直接起動したもの等) の消費は、どの人にも付かない (§3)。
- 実装: 集計 `UsageBudgetTracker.monthlySnapshot` (`src/cost/usage-budget-tracker.ts`)、行の組み立て
  `src/cost/user-monthly-usage.ts` (`userMonthlyUsageRows`)、API `src/api/usage-budgets.ts`。

### 6.2 予算の設定画面

- WebUI: 社員名簿の各行 (Discord の人) とチームのコスト画面に「月の予算 (トークン)」を置く。空欄は無制限。
  社員名簿に「月の予算のコスト倍率 (Discord のロールごと)」を置く (`web/src/pages/staff/BudgetRoleMultipliers.tsx`)。
  guild ごとにロールを名前つきで並べ、ロールごとに倍率を入力する。空欄は 1。倍率を設定したのに一覧に無いロール (消された
  ロール・Bot 停止中) も「一覧に無いロール」として出し、外せるようにする。
  部署設定に部署の倍率を置く (`web/src/pages/departments/DepartmentEditor.tsx`)。

## 7. 制約と既知の問題 (本設計の外)

- 作業中の判定 (§5.2) はハーネスのフックが掛かるセッションだけに効く。Astra (codex) の相談は専用の CODEX_HOME の
  hooks.json の PreToolUse から同じ gate を呼ぶ ([技術相談](tech-consultation.md) §6)。ただし codex は新しいフックを人が
  信頼するまで実行しないため、CODEX_HOME へのログイン時に `/hooks` で信頼しておく必要がある (未信頼の間は起動時の判定だけ)。
  それ以外の codex セッションにはツール実行前のフックが無く、起動時の判定 (§5.1) だけになる。フックが Cc に届かないとき
  (Cc 停止中のオフライン判定) も予算では止めない。
- 属性の倍率は Bot が在籍する guild のロールで決まる。Bot が在籍しない guild だけに居る人のロールは数えない。
- 再開できるのは Claude Code のセッションだけ (`claude --resume`)。codex / codex-sdk は中断の記録は残るが再開ボタンは
  会話 id が無いため出ない。
- 相談専用の設定フォルダ (`CLAUDE_CONFIG_DIR`) で動く claude の transcript は `~/.claude/projects` の外にあるため、
  `resolveTrustedTranscriptPath` が読まず、消費が数えられない (倍率 0.25 も効かない)。置き場所の信頼範囲を広げるかは
  人の判断を待つ。
- 子会社の日次予算 (`subsidiary/budget.ts`) は日の範囲をミリ秒で渡しているが、`sessions.started_at` は秒のため、
  当日のセッションを 1 本も数えていない (消費が常に 0 で予算が効かない)。直すと既存の子会社 (日次予算を設定済みのもの)
  が実際に止まり始めるため、人の判断を待つ。月次予算はこの換算を adapter で行っている。
- 区間の指示は inject の時刻で決まる。AI の応答中に出した指示は、AI がそれを次の応答で処理しても、出した時刻の区間 (応答中の
  区間) の指示として数える。次の応答の区間に指示が無ければ、その区間は起動時の帰属先に付く。

## 8. 検証

- 純関数: 倍率の換算 (`chargedTokens`)、ロールの倍率 (`lowestRoleMultiplier`、Augur `budget-role-C-1`)、指示ごとの帰属 (`attributeUsage` / `responsibleAt`)、区間の切り方と
  指示の回数での按分 (`turnSegments` / `splitByInstructionCount`、Augur `budget-C-6`)、時刻つきの消費と最終回答の印の読み出し、
  ユーザーごとの今月の消費の行 (`userMonthlyUsageRows`、Augur `budget-C-7`)、
  作業中の判定 (`decideBudgetGate`)、再開できる人・状態 (`canResumeSuspension` / `isResumable`)、再開の起動指示
  (`planBudgetResumeLaunch`)。Augur の observe 契約 `budget-C-1`〜`budget-C-7`。
- 集計: 区間ごとの按分と人ごとの倍率、人ごとの今月の消費 (うちチーム)、キャッシュと数え直し (`UsageBudgetTracker`)。
- WebUI: 社員名簿の今月の消費 (`UserMonthlyUsageCell`、client を使わない表示部品)。
- 中断: gate の deny・中断の記録が 1 回だけ・助けに入った人の予算での判定 (`UsageBudgetGate`)、gate API の `usage-budget` hit。
- 再開: 見回りが 1 回だけ出す、押せる人・予算・二度押し・起動失敗の戻し (`resumeSuspendedSession`)、Discord のボタン。
- API: 倍率の編集と集計への反映 (ロールのキャッシュを捨てる)、ロール一覧、中断の一覧と再開の受け渡し。
- Discord: 人のロールの集め方 (@everyone・在籍しない guild を除く)、guild のロール一覧 (`member-roles.ts`)、
  キャッシュと失敗時の 1 (`DiscordRoleMultiplierResolver`)。WebUI のロールごとの入力。
