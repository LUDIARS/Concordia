---
type: feature
title: "部署 — 会社の下でセッショングループと処理を分ける"
description: "本社・子会社の下に部署を置き、セッションを部署ごとに束ねる。部署は起動既定値 (テンプレート / provider / model / effort / 担当プロジェクト) と自然文ルールを持ち、起動時と着手前ルール供給で適用する。組織セッション画面を部署ごとに分けて表示する。"
service: concordia
domain: governance
tags:
  - departments
  - organization
  - subsidiary
  - teams
  - harness
  - webui
status: implemented
related:
  - feature/teams.md
  - feature/subsidiary-delegation.md
  - feature/federation-link.md
  - ux/product.md
updated: 2026-09-30
---

# 部署 — 会社の下でセッショングループと処理を分ける

> 2026-09-30 neco 指示:「セッションなんだけど、いまの子会社や本社で区切ってるけどここに部署を作って
> セッショングループと処理を分ける」。設計方向は「推奨案で着手」(同日回答)。Actio task `a488ab8f`。

## 0. 価値とシナリオ

- 価値 ID: **UX-CC-W1** (作業対象と担当を取り違えずに依頼・確認できる — [プロダクト UX](../ux/product.md))。
- 失うと困る利用者の状態: 本社に稼働セッションが 20 本並ぶと、どれが「開発」でどれが「審査」「運用」
  なのかをカードから判別できず、起動のたびに同じ provider / model / 対象プロジェクトを選び直し、
  部署固有の作業ルールを毎回口頭で渡すことになる。
- シナリオ:
  1. 運用担当が本社に「開発部」(既定テンプレート = 実装委託、担当 = Concordia / Lictor) と
     「運用部」(provider = codex、担当 = infra) を作る。
  2. 組織セッション画面の本社カードに「開発部」「運用部」「未配属」の段が並び、各段の起動フォームは
     その部署の既定値で埋まっている。開発部の段から起動したセッションは開発部の段に出る。
  3. 開発部の自然文ルール (例:「main へ直接 push しない。PR は Revisor 経由」) は、そのセッションの
     着手前ルール供給に全体ルールの後・チームルールの前に並ぶ。
  4. 子会社 glab の部署に、glab の関係プロジェクト外のプロジェクトは登録できない。本社の部署を指定して
     glab のセッションを起動することもできない。

## 1. 用語

| 用語 | 意味 | 混同しないもの |
|---|---|---|
| 会社 | 本社 (`subsidiary_id = NULL`) または子会社 (`subsidiaries` 行) | 拠点 (site、連合の PC) |
| 部署 | 会社が所有するセッショングループ。起動既定値と自然文ルールを持つ | チーム (プロジェクト単位の束)、連合の「担当サーバ」 |
| 未配属 | 部署を持たないセッション。部署導入前の全セッションはこれ | 本社所属 (未配属でも会社には属する) |
| 起動既定値 | 部署から起動するとき、明示されなかった項目に入る値 | 強制値 (明示した値が常に優先する) |
| 担当プロジェクト | 部署から起動できるプロジェクトの集合。空なら制限しない | 子会社の関係プロジェクト (会社の範囲) |

連合 (federation) で「部署」と呼んでいた Discord サーバ (guild) は **担当サーバ** へ改称した。
`federation_sites.departments` 列と API 経路名は後方互換のため残す (中身は guild id 配列のまま)。

## 2. 状態所有者

| 状態 | 所有者 | 書き込み口 |
|---|---|---|
| `departments` 行 (名前・既定値・ルール・廃止時刻) | 部署 (governance) | `DepartmentService` (`/v1/departments`) だけ |
| `sessions.department_id` | session-lifecycle | session 登録時の pending spawn claim / 委託 run から 1 回だけ焼く |
| `delegation_runs.department_id` | agent-delegation | `DelegationService` が invoke 受付時に検証して保存 |
| `teams.department_id` | チーム (governance) | `/v1/teams` の作成・更新 |
| `harness_rules.department_id` | ハーネスルール | `/v1/harness-rules` の作成 |

他ドメインは部署行を直接更新しない。起動経路は `resolveDepartmentLaunch` を通して所有・範囲を検証する。

## 3. 不変条件

**Requirement ID: `SPEC-DEPT-OWNERSHIP`**

| ID | 条件 | 強制箇所 |
|---|---|---|
| CC-DEPT-INV-01 | 部署の所有会社は作成時に固定し、以後変えない | `PatchSchema` が `subsidiary_id` を受け付けない |
| CC-DEPT-INV-02 | 起動・委託で指定した部署の会社と、起動する会社が一致しなければ起動しない | `checkDepartmentOwnership` (spawn / delegation 全経路) |
| CC-DEPT-INV-03 | 子会社の部署の担当プロジェクトは、その子会社の関係プロジェクトの部分集合 | `checkDepartmentProjects` (作成・更新) |
| CC-DEPT-INV-04 | 担当プロジェクトが設定された部署からは、その外のプロジェクトや生 cwd で起動しない | `applyDepartmentLaunchDefaults` |
| CC-DEPT-INV-05 | 明示した起動値は部署の既定値で上書きしない | `applyDepartmentLaunchDefaults` |
| CC-DEPT-INV-06 | 廃止した部署からは新しく起動しない。既存セッションの所属は消さない | `checkDepartmentOwnership` / 廃止は論理削除 |
| CC-DEPT-INV-07 | チームが部署に属するとき、起動時に指定したチームと部署は一致する | `checkTeamDepartment` |
| CC-DEPT-INV-08 | 部署未指定の起動・既存セッションは従来どおり動く (未配属) | 全経路で `department` は任意 |

## 4. データモデル

**Requirement ID: `SPEC-DEPT-STORE`**

```sql
CREATE TABLE departments (
  id            TEXT PRIMARY KEY,               -- dept_<uuid hex>
  subsidiary_id TEXT,                           -- NULL = 本社
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}',     -- §5 の起動既定値と担当プロジェクト
  rules_text    TEXT NOT NULL DEFAULT '',       -- 自然文ルール (§6)
  sort_order    INTEGER NOT NULL DEFAULT 0,
  archived_at   INTEGER,                        -- epoch-ms。NULL = 稼働中
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_departments_org_slug ON departments(COALESCE(subsidiary_id, ''), slug);
ALTER TABLE sessions        ADD COLUMN department_id TEXT;
ALTER TABLE delegation_runs ADD COLUMN department_id TEXT;
ALTER TABLE teams           ADD COLUMN department_id TEXT;
ALTER TABLE harness_rules   ADD COLUMN department_id TEXT;
```

slug は会社ごとに一意 (本社と子会社で同じ slug を使える)。

## 5. 起動既定値と担当プロジェクト

**Requirement ID: `SPEC-DEPT-LAUNCH`**

`settings_json`:

```json
{
  "launch": { "template": "claude-opus-impl", "provider": "claude", "model": "opus",
              "reasoning_effort": "high", "project": "Concordia" },
  "projects": ["Concordia", "Lictor"]
}
```

- 既定値は **起動要求で明示されなかった項目だけ** に入る (CC-DEPT-INV-05)。template と provider は
  排他で、要求が provider を明示した場合は部署の template を使わない。
- `projects` が空でないとき、要求の project (無ければ既定 project) が集合内でなければ拒否する。
  生 cwd 指定もプロジェクト照合できないため拒否する (CC-DEPT-INV-04)。`launch.project` は
  `projects` の要素でなければならない (保存時に検証)。
- 適用経路: `POST /v1/admin/spawn-session` (WebUI・Discord)、`POST /v1/delegation/invoke`
  (`department` 指定時は所有・状態の検証と run への記録だけを行う。委託はテンプレートが起動値を
  持つため既定値は入れない)。
- 本社 token API の `POST /v1/spawn` は部署を扱わない (project 名の解決を持たず、担当プロジェクトを
  照合できないため)。この経路の起動は未配属になる。

## 6. ルールの重ね方

**Requirement ID: `SPEC-DEPT-RULE-LAYERS`**

- 自然文ルールは 2 種: 部署の `rules_text` と、`harness_rules.department_id` で部署に絞った行。
- 着手前ルール供給 (`POST /v1/harness/context`) と per-prompt 意図判定 (`POST /v1/harness/intent`) の順序は
  **全体 → 部署 → チーム**。部署の `rules_text` は「部署ルール: <部署名>」の 1 項目として部署層の先頭に入る。
- 子会社のガード (Sonnet guard) の共通ハーネスルールは従来どおり子会社受付だけに効き、部署は関与しない。

## 7. API

**Requirement ID: `SPEC-DEPT-API`**

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/v1/departments?subsidiary_id=<id>&include_archived=1` | 無指定は本社。子会社は明示 query のみ。`all_organizations=1` で全会社 (組織セッション画面用) |
| GET | `/v1/departments/:id` | 1 件 (id または slug は使わない。会社ごとに slug が重なるため) |
| POST | `/v1/departments` | 作成。`subsidiary_id` は作成時のみ |
| PATCH | `/v1/departments/:id` | name / slug / description / settings / rules_text / sort_order |
| POST | `/v1/departments/:id/archive` | 廃止 (冪等) |
| POST | `/v1/departments/:id/restore` | 復帰 (冪等) |

起動系は `department` (部署 id) を受け付ける。`GET /v1/sessions?department_id=` で絞り込める。
チームは `POST/PATCH /v1/teams` の `department_id` で部署に所属させる (同じ会社の稼働中の部署だけ)。
ハーネスルールは `POST /v1/harness-rules` の `department_id` で部署に絞る (`team_id` と排他)。
`GET /v1/harness-rules` は既定で部署行を返さない。`department_id=<id>` でその部署の行を足し、
`scope=all` で全部署の行を含める。
変更は `department.changed` イベント (action = created / updated / archived / restored) で配る。
エラーコード: `department_not_found` / `department_archived` / `department_not_owned_by_requested_organization`
/ `department_project_out_of_scope` / `department_cwd_not_allowed` / `team_department_mismatch`
/ `department_projects_outside_subsidiary_scope` / `department_slug_taken`。

## 8. WebUI

**Requirement ID: `SPEC-DEPT-WEBUI`**

- 組織セッション (Monitor): 会社カードの中を部署ごとの段に分ける。段の並びは `sort_order`, 名前、
  最後に「未配属」。各段に active sessions と、その部署の既定値で埋まった起動フォーム
  (起動要求に `department` を付ける)。廃止済み部署に残る稼働セッションは「(廃止)」付きの段に出す。
- 部署管理 (`/departments`): 会社 (本社 / 各子会社) を選び、部署の作成・編集・廃止・復帰を行う。
  既定値・担当プロジェクト・ルール本文を編集できる。

## 9. 部署ごとに「やること」と出力を分ける (v2、2026-09-30 neco 指示)

> 「各部署でやることを全く分ける。今の spawn は『総務』で何でもやる雑用。『技術相談課』は質問を
> 投げて回答を返してくれる。カードの投稿や途中の思考の投稿とかも各部署で制御したい」。
> 入口は「部署ごとにフォーラム」(同日回答)。

### 9.1 ユースケース

部署は `use_case_id` でユースケース ([対話の前提データ](dialogue-context.md)) を 1 つ参照する。
ユースケースが部署のセッションの「やること」(概要・作業モード・事前データ) を決める。
部署の起動既定値 (§5) とルール (§6) はそのまま併用する。

### 9.2 既定部署

**Requirement ID: `SPEC-DEPT-DEFAULT`**

- 会社ごとに既定部署を 1 つまで持てる (`departments.is_default`)。部署を指定しない起動は既定部署に入る。
  既定部署が無い会社は従来どおり未配属 (CC-DEPT-INV-08)。
- 本社の既定部署は「総務」(フォーマット: 雑用) を想定し、今の起動と同じ動きにする。
- 既定部署の Discord 面は既存の Session フォーラムをそのまま使う (新しいフォーラムを作らない)。
  Session フォーラムへの投稿で起動したセッションは既定部署に入る。

### 9.3 部署フォーラム

**Requirement ID: `SPEC-DEPT-FORUM`**

- 既定部署以外の部署は、所有会社の guild の「部署」カテゴリに部署名のフォーラムを 1 つ持つ
  (`departments.discord_forum_id`)。作成・改名・復帰で Bot が冪等に用意する (チームの面と同じ流儀)。
  必須タグ (セッション状態・Cc 管理) も揃える。
- フォーラムへの投稿は、その部署のセッションを起動する (承認・聞き返し・子会社ガードは Session
  フォーラムと同じ)。部署に担当プロジェクトが無ければプロジェクトを聞き返さない。部署の起動既定値が
  テンプレートか provider を持てばモデルを聞き返さない (投稿に明示があれば明示が優先)。
- 部署に属するセッションのスレッドは、チームのフォーラム → 部署のフォーラム → Session フォーラムの順で
  置き場を決める。
- 廃止した部署のフォーラムは残すが、投稿からは起動しない (理由をスレッドへ返す)。

### 9.4 出力方針

**Requirement ID: `SPEC-DEPT-OUTPUT`**

`settings.output` の各項目は `inherit` (全体設定に従う) / `on` / `off`:

| 項目 | 対象 |
|---|---|
| `thinking` | 途中の思考 (transcript の thinking frame) の保存・中継 |
| `status_card` | 状態カード |
| `session_info_card` | スレッドのセッション情報表示 (off なら 1 行の簡易表示にする。webhook 面は残す) |
| `cost_report` | 終了時のコスト報告 |

## 10. 検証

- 純関数: 所有・廃止・チーム整合・担当プロジェクト・既定値の適用・ルールの重ね方。
- repository: 会社ごとの slug 一意性、廃止/復帰の冪等性、会社別一覧。
- API: 作成・更新・廃止、所有者の変更拒否、子会社の関係プロジェクト外の拒否。
- 起動経路: 部署の既定値適用、会社不一致・廃止済み・範囲外の拒否、pending claim で session に焼けること。
- WebUI: 部署ごとのグループ化 (未配属・廃止済みを含む)。
