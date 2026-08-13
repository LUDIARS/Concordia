---
type: feature
title: "チーム — プロジェクト主単位の可視化・ルールスコープ・Discord カテゴリ"
description: "プロジェクト+タスクを単位とする「チーム」を新設し、Discord カテゴリ (目標/タスクボード/コスト/direction/セッションフォーラム/タスクフォーラム) を自動プロビジョニングする。チーム独自ルール (typed settings + 自然文 harness_rules) を Cc と Lictor に注入し、WebUI で目標・タスク・セッション・ルールを可視化する。上部メニューは左サイドバーへ改修する。"
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
updated: 2026-08-13
---

# チーム — プロジェクト主単位の管理

> 2026-08-13 neco 指示。 GoalAndGo で生まれる Director の監督がユーザから可視化しづらい。
> プロジェクトを主単位とする「チーム」で束ねて管理する。

## 0. 原則

チームは新しい実行機構ではなく、 **既存正本 (director case / taskflow / session /
delegation / cost) を束ねる名前空間**である。 director.md の「正本を複製しない」を維持し、
チームが所有するのは自分の設定とチャンネル参照だけ。

## 1. データモデル

```sql
CREATE TABLE teams (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,          -- 「プロジェクト名+タスク」
  status              TEXT NOT NULL,          -- active | archived
  settings            TEXT NOT NULL,          -- typed settings JSON (§3.1)
  default_supervisor  TEXT,
  discord_category_id TEXT,
  channels            TEXT NOT NULL,          -- {goal, taskboard, cost, direction, session_forum, task_forum}
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

## 2. Discord カテゴリの自動プロビジョニング

チーム作成 (`/co-team-create` / WebUI / `POST /v1/teams`) で Cc がカテゴリ + 6 面を
冪等に用意する (子会社受付チャンネルの自動用意と同パターン):

| 面 | 中身 (既存部品の張り替え先) |
|---|---|
| 目標チャンネル | director_cases の goal/case 状態カード。 プラン設計カード (plan-gate §2.2) |
| タスクボード | taskflow overview の kanban 状態カード (1 メッセージ更新型、 session-status-card パターン) |
| コストチャンネル | cost-observability のチーム畳み込み (日次サマリ + 予算アラート) |
| direction チャンネル | Director 判断ログ (Decision Request / Genius 回答 / ask_human 質問カード)。 セッション契約の未決質問カード (session-contract §3.3)。 チーム設定変更の監査カード |
| セッションフォーラム | 既存 Session forum をチーム配下へ (1 セッション = 1 スレッド、 現行踏襲) |
| タスクフォーラム | discord-forum-migration の 1 run = 1 スレッドをチーム配下へ |

- 既存のグローバル forum は「チーム未所属」用として残す。 チーム側へは新規分から流す
  (既存スレッドの引っ越しはしない)。
- **spawn 時のチーム選択**: セッション契約に `team` フィールド (session-contract §1)。
  repo からチームが一意なら seed で自動確定、 複数候補・新規は契約の未決フィールドとして
  direction チャンネルへ質問カード。 `/co-spawn` にも team オプションを足す。
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

### 4.2 メニュー改修 — 左サイドバー化

- 上部メニュー (ページ 20 枚超で限界) を左サイドバーへ。 デスクトップは常設・折りたたみ可、
  モバイルはハンバーガー → オーバーレイのスライドイン。 foundation.css のトークンで組む。
- セクション分け (案): **チーム** (Teams / Sessions / Taskflow / Delegation) /
  **レビュー・PR** (PrQueue / RevisorConfig / Reports) / **運用** (Monitor / CostFeed /
  SessionLogs / WsCleanup) / **設定** (Settings / Discord / Slack / Staff / Skills /
  Manuals / ModelCatalog / ほか)。
- チーム選択をグローバルフィルタとして他ページに効かせる (チーム主体の可視化)。

## 5. 実装フェーズ

| Phase | 内容 | 依存 |
|---|---|---|
| a | teams / team_repos テーブル + API + Discord プロビジョニング + 契約 `team` フィールド | session-contract |
| b | harness_rules team scope + typed settings + 契約 seed 接続 + Lictor 注入 | a |
| c | WebUI `/teams` + 各ページの team フィルタ | a |
| d | 左サイドバー化 (他と無依存・先行可) | なし |

## 6. 受け入れ基準

- [ ] チーム作成でカテゴリ + 6 面が冪等に用意され、 再実行しても重複しない。
- [ ] spawn 時に repo からチームが seed 確定し、 曖昧なら direction チャンネルに質問カード
      が出て、 回答で契約が埋まる。
- [ ] チーム settings の `revisor_lane` / `worktree` / `test_policy` が契約 seed・ハーネス・
      Revisor 提出経路に効く (MakaiNui 相当の設定で Unity 運用が成立する)。
- [ ] チームの自然文ルールがガードプロンプトと Lictor 注入の両方に載る。
- [ ] WebUI `/teams` で目標・case・セッション・コスト・ルールが 1 画面で管理できる。
- [ ] メニューが左サイドバー化され、 モバイルでスライドイン表示になる。
- [ ] team_id NULL の既存データ・既存フローが無変更で動く (後方互換)。
