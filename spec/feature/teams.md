---
type: feature
title: "チーム — プロジェクト主単位の可視化・ルールスコープ・Discord カテゴリ"
description: "プロジェクト+タスクを単位とする「チーム」を新設し、Discord カテゴリ (目標/タスクボード/コスト/direction/管理/セッションフォーラム/タスクフォーラム) を自動プロビジョニングする。チーム独自ルール (typed settings + 自然文 harness_rules) を Cc と Lictor に注入し、WebUI で目標・タスク・セッション・ルールを可視化する。上部メニューは左サイドバーへ改修する。"
service: concordia
domain: governance
tags:
  - teams
  - discord
  - webui
  - harness
  - director
  - cost
status: planned
related:
  - feature/session-contract.md
  - feature/director-goal-flow.md
  - feature/task-workflow.md
  - feature/plan-gate.md
updated: 2026-08-27
---

# チーム — プロジェクト主単位の管理

> 2026-08-13 neco 指示。 GoalAndGo で生まれる Director の監督がユーザから可視化しづらい。
> プロジェクトを主単位とする「チーム」で束ねて管理する。

## 0. 原則

チームは新しい実行機構ではなく、 **既存正本 (director case / taskflow / session /
delegation / cost) を束ねる名前空間**である。 director.md の「正本を複製しない」を維持し、
チームが所有するのは自分の設定とチャンネル参照だけ。

### 0.5 簡素化 (2026-09-01 neco 指示)

> 「チームの動作が今形骸化しており巡回があまり有効でない。チームはチーム内で spawn する
> だけにしよう。あと巡回でディレクターがなんかつぶやくやつ (散歩セッション) だけ適用しよう」。

チームの自動動作を **チーム内 spawn + 散歩セッションだけ**に絞る:

- **残す**: チーム forum / `/spawn team:` / チーム面へのカード投稿・コスト報告など、
  spawn とその可視化。散歩セッション ([curiosity-walk.md](curiosity-walk.md)) は
  稼働中の全チーム (本社 + 子会社所有) を対象に適用する。
- **止める**: teams fanout の定時ジョブ 4 本 (朝礼 `team-standup-daily` / 定例
  `team-review-regular` / 課題スカウト / タスク整理) と、Director 巡回の実装セッション
  自動起動・問診 ([director-patrol.md](director-patrol.md) — status: superseded)。
- 子会社所有チームにも同じ簡素化後の姿を適用する (subsidiary-delegation.md §3.1)。

## 1. データモデル

```sql
CREATE TABLE teams (
  id                  TEXT PRIMARY KEY,
  subsidiary_id       TEXT,                   -- NULL=本社 / 値あり=所有子会社
  name                TEXT NOT NULL,          -- 「プロジェクト名+タスク」
  status              TEXT NOT NULL,          -- active | archived
  settings            TEXT NOT NULL,          -- typed settings JSON (§3.1)
  default_supervisor  TEXT,
  discord_category_id TEXT,
  channels            TEXT NOT NULL,          -- {goal, taskboard, cost, direction, management, session_forum, task_forum}
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE team_repos (
  team_id   TEXT NOT NULL,
  repo_path TEXT NOT NULL,                    -- 複数可・別 org 可 (例: MakaiNui)
  PRIMARY KEY (team_id, repo_path)
);
```

- director_cases / sessions / delegation_runs に `team_id` (nullable) を追加。
  NULL は「チーム未所属」で現行挙動のまま (後方互換)。
- `harness_rules` に `team_id` (nullable) を追加。 NULL = グローバル (現行互換)。
- チームの会社所有権は作成時に固定する。会社間移管は session / Discord surface の可視境界を
  変えるため通常 PATCH では受け付けない。

## 2. Discord カテゴリの自動プロビジョニング

チーム作成 (`/co-team-create` / WebUI / `POST /v1/teams`) で Cc がカテゴリ + 7 面を
冪等に用意する (子会社受付チャンネルの自動用意と同パターン):

| 面 | 中身 (既存部品の張り替え先) |
|---|---|
| 目標チャンネル | director_cases の goal/case 状態カード。 プラン設計カード (plan-gate §2.2) |
| タスクボード | taskflow overview の kanban 状態カード (1 メッセージ更新型、 session-status-card パターン) |
| コストチャンネル | cost-observability のチーム畳み込み (日次サマリ + 予算アラート) |
| direction チャンネル | Director 判断ログ (Decision Request / Genius 回答 / ask_human 質問カード)。 セッション契約の未決質問カード (session-contract §3.3)。 チーム設定変更の監査カード |
| 管理チャンネル (`management`) | `@everyone` 非公開。社員名簿の管理職・執行役員だけが閲覧する遅延レポート・調整提案 |
| セッションフォーラム | 既存 Session forum をチーム配下へ (1 セッション = 1 スレッド、 現行踏襲) |
| タスクフォーラム | discord-forum-migration の 1 run = 1 スレッドをチーム配下へ |

- 既存のグローバル forum は「チーム未所属」用として残す。 チーム側へは新規分から流す
  (既存スレッドの引っ越しはしない)。
- 本社 runtime は `subsidiary_id IS NULL`、子会社 runtime は自分の `subsidiary_id` の team だけを
  provision / event route する。物理 Discord Client を共有しても guild 間で team surface を
  混ぜない。子会社の既定 team は subsidiary delegation の起動時に `options.team` へ入る。
- **カードのチーム面ルーティング** (`src/discord/team-card-routing.ts`): プラン設計カード →
  目標、 判断ログ (taskflow.user_decision) / ask_human・契約質問カード → direction。
  team_id 未設定・surface 未プロビジョニング・チャンネル取得失敗は現行チャンネル
  (セッション webhook / セッションチャンネル) へフォールバックする。 プラン設計カードの
  team は case の team_id を正とし、 無ければセッションの team_id で引く。
  taskflow kanban 状態カードとコスト日次のチーム畳み込みは投稿元カード自体が未実装
  (surface 対応 `タスクボード` / `コスト` はルータ側で予約済み)。
- **spawn 時のチーム選択**: セッション契約に `team` フィールド (session-contract §1)。
  repo からチームが一意なら seed で自動確定、 複数候補・新規は契約の未決フィールドとして
  direction チャンネルへ質問カード。 `/co-spawn` にも team オプションを足す。
- **起動時に決める (2026-08-15 neco 指示)**: セッションはほぼ workspace root (Castra) から
  起動されるため、 起動後にチーム・タスクを付け替える運用では取りこぼす。 `/spawn` の時点で
  以下を確定させる。
  - `team` は登録済みチームの autocomplete (`src/discord/team-choices.ts`)。 値は canonical な
    team id なので slug 改名で壊れない。
  - team 未指定なら**実行チャンネルからチームを引く** (`src/discord/team-channel-binding.ts`)。
    優先順位は 実行チャンネル自身が面 → スレッド親が面 → 所属カテゴリ。 どれにも当たらなければ
    チーム未所属のまま (現行動作)。
  - **team 指定 spawn の cwd / forum (2026-08-22 neco 指示)**: 明示 `project` / `cwd` が
    無い場合、チームに登録された repo が一意ならそのローカル project root を cwd とする。
    repo が 0 件または複数なら誤選択せず、`project` / `cwd` の明示を要求する。起動した direct
    session はチームの「セッション」forum、delegation run は「タスク」forum に作成する。
    対応面が未プロビジョニングなら既存 global forum へフォールバックする。
    チーム forum には global forum と同じ必須タグ (状態タグ + `Cc管理`) を
    `team-provision.ts` が冪等に用意する。 これが無いと `createForumSessionThread` が
    throw し、 `onSessionRegistered` がそれを握り潰すため面が一切作られない。
  - `task` オプションで **Memoria の未完了タスク**を選べる (`src/discord/memoria-task-cache.ts`、
    Discord の 3 秒制限に合わせて stale-while-revalidate)。 選んだタスクは
    ①`current_task` に登録 ②`details` を初回 prompt へ注入 ③`metadata.memoria_task_id` に記録。
  - **正常終了時のみ** Memoria タスクを done にする (`end-session-flow.ts`)。 `session.lost`
    (クラッシュ・切断) では done にしない — 落ちただけで残作業が消えるのを避ける。
- **セッション終了時のチームコスト報告**: team 所属セッションが終了したら、 そのセッション 1 本の
  消費と当日のチーム累計をチームの `コスト` 面へ投稿する (`src/discord/team-cost-report.ts`、
  カード種別 `cost-session`)。 集計は `team-metrics-repo` の既存 read model を畳むだけで、
  新しい集計正本は作らない (§0)。 チーム未所属・面未プロビジョニングなら投稿しない
  (個人セッションのコストを無関係なチャンネルへ流さない)。
- phase-compaction の message link 索引は、 チーム面の各カードへのリンクになる
  (「不明点は Discord を遡る」の遡り先が構造化される)。

## 3. チームルール (二層)

MakaiNui (Unity・private・別 org・Revisor push ルール別) を成立させる分解:

### 3.1 A 層 — typed settings (機械で強制)

`teams.settings` に型付きで持ち、 下流が読む:

```jsonc
{
  "revisor_lane":   "local" | "github",     // Revisor 提出経路 (MELPOT=github の既存判断)
  "pr_rules":       { "base": "develop", "push": "revisor" },
  "test_policy":    "confirm-queue" | "custos-unity",
  "worktree":       "allowed" | "repo-root-only",   // Unity は repo-root-only
  "visibility":     "public" | "private",           // 対外資料の秘匿判定に使う
  "vibes_defaults": { "claim_sec": 3600 }
}
```

- **セッション契約の seed 値はチーム settings から引く** (session-contract §3.1)。
  ハーネス述語・delegation invoke・Revisor 提出経路も同じ settings を読む。

### 3.2 B 層 — 自然文ルール (harness_rules の team scope)

- ガードプロンプト組み立て時に「グローバル (team_id NULL) + 当該チーム」をマージして
  列挙する。
- **Lictor への注入**: spawn 時に契約と一緒にチームルール文書を Lictor へ渡し、
  system-reminder 相当でセッションに供給する (Lictor の既存 persona / skill 配布経路に
  載せる。 Lictor 側タスクは Lictor リポの task md)。
- チーム設定・ルールの変更は direction チャンネルへ監査カードを投稿する
  (誰が・いつ・何を変えたか)。

## 4. WebUI

### 4.1 `/teams` ページ

- 一覧: チームカード (目標数 / 進行中 case / active セッション / 今日のコスト)。
- 詳細タブ: **目標・case kanban** (director-goal-flow §3 の `/director` ページ構想を
  チーム詳細タブとして吸収) / **セッション一覧** / **コストグラフ** / **ルールエディタ**
  (A 層 typed form + B 層自然文リスト。 harness_rules エディタの流用)。
- すべて read model。 既存 Sessions / Taskflow / CostFeed のクエリに team フィルタを
  足すのが実装の大半で、 新しい集計正本は作らない。
- 実装 (2026-08-14, teams-webui): カードメトリクスは `GET /v1/teams` が
  `metrics` (src/db/team-metrics-repo.ts の read model) を同梱。 コストグラフは
  `GET /v1/teams/:id/cost` = cost_usage_samples の累積 cost_tokens をセッション毎
  差分でバケット化したチーム畳み込み。 kanban は `GET /v1/director/cases?team_id=`、
  セッションは `GET /v1/sessions?team_id=`、 B 層は `GET /v1/harness-rules?team_id=`
  (グローバル + 当該チームのマージ)。 チーム選択はヘッダ常設の
  `web/src/lib/TeamFilterContext.tsx` (localStorage 永続) で、 Sessions / Taskflow /
  CostFeed が購読する。 Taskflow の team 帰属は run.team_id → session.team_id の順。
- `GET /v1/teams` は本社 team、`GET /v1/teams?subsidiary_id=<id>` は指定子会社の team を返す。
  子会社編集画面から `subsidiary_id` 付きで作成でき、最初の team は既定へ設定する。
- spawn / delegation が `subsidiary_id` と `team` を同時に受け取る場合は所有者の一致を
  canonical 起動境界で検証する。本社用 `/v1/spawn` は子会社所有 team を受け付けない。

### 4.2 メニュー改修 — 左サイドバー化

- 上部メニュー (ページ 20 枚超で限界) を左サイドバーへ。 デスクトップは常設・折りたたみ可、
  モバイルはハンバーガー → オーバーレイのスライドイン。 foundation.css のトークンで組む。
- セクション分け (案): **チーム** (Teams / Sessions / Taskflow / Delegation) /
  **レビュー・PR** (PrQueue / RevisorConfig / Reports) / **運用** (Monitor / CostFeed /
  SessionLogs / WsCleanup) / **設定** (Settings / Discord / Slack / Staff / Skills /
  Manuals / ModelCatalog / ほか)。
- チーム選択をグローバルフィルタとして他ページに効かせる (チーム主体の可視化)。

## 4.5 一時停止 + チーム管理チャンネル (2026-08-27 neco 指示)

> 「作業していないチームは一時的に止められるようにする」+「チーム管理用のチャンネルを用意」。

- `teams.suspended_at` (epoch-ms, NULL = 稼働中)。 **アーカイブではない** — 手動 spawn・
  チーム面・設定・カード投稿はそのまま生きる。 止まるのは定時 fanout だけ。
- 一時停止中のチームは cron の teams fanout (朝礼 `team-standup-daily` / 定例
  `team-review-regular` / `director-issue-scout-weekly` / `director-task-organize-daily`)
  の対象から外れる (`scheduler/cron-fanout.ts` が `suspended_at` で filter)。
- API: `POST /v1/teams/:id/suspend` / `POST /v1/teams/:id/resume` (id / slug 可、 冪等)。
  状態が変わったときだけ `team.changed` (fields: `["suspended_at"]`) を流す。
- Discord: 「状態」カテゴリに **チーム管理** チャンネル (`team_admin_channel_id`) を
  自動プロビジョニング (子会社 slim 構成では作らない)。 1 メッセージ更新型のパネル
  (`team-admin-panel.ts`) にチーム一覧 (🟢 稼働 / ⏸ 一時停止中) と一時停止 / 再開
  ボタンを出す。 再描画は boot と `team.created` / `team.changed` 起点。
- ボタンの権限は社員名簿の `session_end` capability (管理職以上)。 セッションを止められる
  役職がチームの定時ジョブも止められる、 という対応。 未配線は deny (fail-closed)。

## 5. 実装フェーズ

| Phase | 内容 | 依存 |
|---|---|---|
| a | teams / team_repos テーブル + API + Discord プロビジョニング + 契約 `team` フィールド | session-contract |
| b | harness_rules team scope + typed settings + 契約 seed 接続 + Lictor 注入 | a |
| c | WebUI `/teams` + 各ページの team フィルタ | a |
| d | 左サイドバー化 (他と無依存・先行可) | なし |

## 6. 受け入れ基準

- [ ] チーム作成でカテゴリ + 7 面が冪等に用意され、 再実行しても重複しない。
- [ ] spawn 時に repo からチームが seed 確定し、 曖昧なら direction チャンネルに質問カード
      が出て、 回答で契約が埋まる。
- [ ] チーム settings の `revisor_lane` / `worktree` / `test_policy` が契約 seed・ハーネス・
      Revisor 提出経路に効く (MakaiNui 相当の設定で Unity 運用が成立する)。
- [ ] チームの自然文ルールがガードプロンプトと Lictor 注入の両方に載る。
- [ ] WebUI `/teams` で目標・case・セッション・コスト・ルールが 1 画面で管理できる。
- [ ] メニューが左サイドバー化され、 モバイルでスライドイン表示になる。
- [ ] team_id NULL の既存データ・既存フローが無変更で動く (後方互換)。
