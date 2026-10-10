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
updated: 2026-10-09
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
     担当プロジェクトを持たない読み取り専用の相談部署 (技術相談課) は、プロジェクト無しで相談を受ける
     ([技術相談 §6](tech-consultation.md))。

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
| CC-DEPT-INV-09 | Session フォーラムの名前は表示だけで、フォーラムの同定は保存済み channel id が正本 (§9.2) | `ensureDiscordLayout` の `sessionForumName` |

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
- Session フォーラムの名前は既定部署の名前に揃える (2026-09-30 neco 指示「今の汎用の session を
  総務に名前変更」。本社なら「総務」)。既定部署が無い会社・既定を外した・廃止したときは「Session」に戻す。
  - 変えるのは表示名だけで、フォーラムは保存済みの channel id で同定する (CC-DEPT-INV-09)。
    保存済み id を失ったときは、揃えるべき名前 → 旧名「Session」の順に同じフォーラムを探し、
    どちらも無いときだけ作る (改名後に id を失っても二つ目の Session フォーラムを作らない)。
  - 部署の変更通知 (作成・改名・既定の付け外し・廃止・復帰) と、Bot 起動時・定期のレイアウト同期で
    冪等に揃える。Discord の改名制限で失敗したら次の同期で揃え直す。

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
| `intermediate` | 指示 1 回ごとの最後の発言 (最終回答・会話の要約) 以外の途中の発言 (2026-10-02 追加) |
| `inject_transcript` | Cc が送った指令の転記 (task / delegation / system、起動時のタスク本文・起動コンテキスト、作業ポリシー更新・自動確認などの 1 行通知)。off でもエラーの知らせ (審査失敗など) は出す。内容は Cc の WebUI で見る (2026-10-10 neco 指示、discord-session-task-post.md §3.6) |
| `context_usage` | コンテキストの使用量 (サイズ) の表示 |
| `session_end_report` | 終了時の `/session-end` の自動指示と #報告 への独白 (全体設定は無く、inherit は出す。2026-10-02 追加) |
| `working_post` | 作業中にスレッドへ出す「🔄 作業中…」(1 作業 1 通、待機で削除)。全体設定は無く、inherit は出す。エンジニア課は off (2026-10-10 neco 指示、working-indicator.md) |

前提質問 (question) と状態カードはこの方針の外で、常に投稿する。技術相談課は状態カード以外をすべて off にする
(「FINAL ANSWER のみ」「Inject 指令は非表示」「コンテキストサイズも不要」「/session-end 的なのは投稿しなくて良い」、2026-10-02 neco 指示)。

`intermediate` を off にしたセッションは、chat 経路の投稿 (lictor chat・圧縮の通知・終了の独白など) も流さない。
FINAL ANSWER は session.message で届くので、chat 経路はすべて途中の発言として扱う。#報告 などのメタチャンネル宛ても止める
(非公開の相談の中身がそこへ漏れないように)。

### 9.5 起動時の注入

**Requirement ID: `SPEC-DEPT-STARTUP-INJECT`**

- 部署設定 `startup_inject` は `full` (既定) / `initial-only`。
- `initial-only` の部署のセッションには、Cc の作業ポリシー・Cc ワークフローの案内・以後の `[Cc policy update]`・
  プロジェクト規則を送らない。初回指示 (前提データと依頼本文) だけを渡す (技術相談課。「spawn inject は総務用で、
  相談課は初期の Inject のみで良い」2026-10-02 neco 指示)。

### 9.6 自動確認

**Requirement ID: `SPEC-DEPT-AUTO-CHECK`**

- 部署設定 `auto_check` は `on` (既定) / `off`。
- `off` の部署のセッションには、応答が止まったときの自動確認 (`stalled-session-nudge`) と Goal & Go の継続確認を
  送らない (技術相談課。「相談セッションは自動確認しない」2026-10-02 neco 指示)。
- 部署設定 `consult_tools` は `restricted` (既定) / `all`。`all` の相談部署はツールの制限を外す
  (2026-10-06 neco 指示「Consult のハーネスをすべて許可する設定」、選択「ツール制限だけ外す」)。中身は
  [技術相談](tech-consultation.md) §6「ツール制限を外す部署」。設定は部署の API (`settings.consult_tools`) で行う。

### 9.7 月次予算のコスト倍率

要件の正本は [月次予算](usage-budgets.md) §3.1 (`SPEC-USAGE-BUDGET-MULTIPLIER`)。部署側の設定は次のとおり。

- 部署設定 `budget.cost_multiplier` (0 より大きく 10 以下、既定 1)。この部署のセッションの消費は
  本来のトークン × この倍率 × 消費した人の属性 (Discord のロール) の倍率で月次予算から引く ([月次予算](usage-budgets.md) §3.1)。
  「相談はモデルが固定されているので、予算消費を本来のコストの 1/4 で考えてください」(2026-10-02 neco 指示)。
- 相談課の 0.25 はデータ設定 (PATCH `/v1/departments/:id`) で入れる。コードに部署ごとの値を持たない。
- WebUI の部署設定に「月次予算 → コスト倍率」の入力欄を置く。範囲外は保存しない。

### 9.8 話し方 (非エンジニアモード)

**Requirement ID: `SPEC-DEPT-AUDIENCE`**

> 2026-10-09 neco 指示:「Ludellus の AI総務に『非エンジニアモード』を用意し、説明から技術用語を噛み砕いたり、
> やった事/判断してほしい事などをまとめて簡潔に表示するようにしたい」。方式は「出力を変える」を選択 (同日)。

価値は UX-CC-W4「通知を見れば今必要な判断が分かる」。失うと困る状態は、エンジニアでない依頼者が
返信を読んで「何が終わったか」「自分が何を決めればよいか」を専門語を調べずに分かること。

- 部署設定 `audience` は `standard` (既定) / `non-engineer`。既存の部署は `standard` のまま変わらない。
- `non-engineer` の部署で起動したセッションには、初回指示の前提データに「話し方: 非エンジニア向け」の節を足す。
  ユースケースの有無にかかわらず足す (総務はユースケース無しでも動くため)。文面は `src/dialogue/audience-guidance.ts` が持つ。
- 方式は**セッションの出力そのものを変える**。Discord へ出す前に LLM で言い換える後処理は作らない。
  - 言い換えると、承認依頼・危険度・範囲の制約・`ask` マーカーの意味や形が崩れ、人が答える文と作業している文が別物になる。
  - 「やったこと／決めてほしいこと」は作業している本人しか正確に書けない。後から推測で補わせない。
  - 発言ごとに `claude -p` を挟む遅れと失敗点を足さない。
- 節の中身:
  - 日常の言葉で話し、専門用語が必要ならその場で一言で言い換える。ファイル名・関数名・コマンドは必要なときだけ添える。
  - 途中経過は今していることを一言で。作業ログを並べない。
  - 人に決めてもらうときは「何を決めればよいか」と推奨・理由を短く書く。
  - 返信の最後に「やったこと／決めてほしいこと／残っていること」の 3 項目を付ける。無い項目は「なし」と書く。
    完了・審査中・反映済み・未確認を区別し、未確認を成功と書かない。
  - 選択肢の `ask` マーカーなど、決まった形の出力は形を崩さず、中の文だけを平易にする。
- 変えるのは人に向けた言葉だけ。PR の説明・コミット・引き継ぎ資料は従来どおり技術的に書く。
  作業規則・承認・テスト・公開・サービス操作の許可範囲は、説明を簡単にすることを理由に省かない (CC-PLAN-03 と同じ)。
- Cc が自動で出すもの (状態カード・自動確認の転記・コンテキスト使用量など) はこの設定では変えない。見せ方は
  出力方針 (§9.4) で絞る。子会社の総務は既定で最終回答のみ。
- 限界: LLM がこの話し方に従うことは機械的に保証しない。会話の圧縮後に節が残ることも保証しない。
- WebUI の部署設定に「話し方」(標準 / 非エンジニア向け) の選択を置く。API は `settings.audience`。

## 10. 検証

- 純関数: 所有・廃止・チーム整合・担当プロジェクト・既定値の適用・ルールの重ね方。
- repository: 会社ごとの slug 一意性、廃止/復帰の冪等性、会社別一覧。
- API: 作成・更新・廃止、所有者の変更拒否、子会社の関係プロジェクト外の拒否。
- 起動経路: 部署の既定値適用、会社不一致・廃止済み・範囲外の拒否、pending claim で session に焼けること。
- WebUI: 部署ごとのグループ化 (未配属・廃止済みを含む)。
