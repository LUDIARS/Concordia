---
type: feature
title: "パートタイマー inject — タスク本文を先頭に置き、終わり方を 1 系統にする"
description: "category=parttimer の委託は実装委託と別書式で渡す。タスク本文を prompt file の先頭にそのまま置き、Concordia が足すのは「本文が全文」「迷っても止まらない」「報告 → status → 退勤」の 3 点だけ。実装マニュアル・why・着手時バンドル・完了条件チェックリスト・Memoria 起票・コミット代行は載せない。完了判定の feature branch 要求もパートタイマーには適用しない。"
service: concordia
domain: governance
tags:
  - delegation
  - inject
  - parttimer
  - lifecycle
status: implemented
related:
  - delegation.md
  - delegation-implementation-inject.md
updated: 2026-09-03
---

# パートタイマー inject

> 2026-09-03 neco 指示。 「パートタイマーが仕事をしないことが多い。 パートタイマーの inject
> 文章に問題があると考えている。 タスクの内容だけ投げて後の指示はいらないのではないか」
> 「『なぜ』とか実装でないタスクに『実装』とか、 後からタスク内容投げるぜみたいな流れで文中に
> タスク内容があるのが原因かな？ ハーネス文章が多すぎるのもあるけど 1 番はパートタイマーの
> inject の自由度のないフォーマットだと思う。 LLM の思考で一度全部書き直して欲しい。
> あと最後必ずセッション終了するようにして欲しい」「全パートタイマーそれぞれで文面考えてほしい」

## 1. 何が起きていたか

`resolveManualKind` は call_name / title の語だけで Inject マニュアルの kind を決めていて、
既定が「実装」だった。 パートタイマーの名前には実装系の語が入らない (「メール監視」
「日次依存関係点検」「Vultus 女優カタログ日次更新」「チーム朝礼」) ので、
**19 本のうち 14 本が既定で「実装」に落ちていた**。 その結果、

1. 前置きに実装マニュアル (`作業ブランチを確定 → worktree を生成 → … → PR 作成まで行う`) が付く
2. `buildImplementationInject` が本文を `## 実装タスク` の枠へ入れ、 `### なぜ (why)`、
   `### 着手前の把握`、 `#### 着手時バンドル` (ドメイン定義 → 再利用探索 → `augur plan`)、
   `### Memoria タスク`、 `### 完了条件` (仕様更新 / Anatomia ドメイン登録 / テスト /
   Revisor local PR 提出) を前後に重ねる
3. さらに「作業対象は … のみです」ブロックが `サービスの起動・再起動・起動テストはしない` を足す
4. 末尾にコミット代行 (`.concordia-commit.json`) の案内が付く

`quaestor-mail-sweep` の実物は prompt file 195 行のうちタスク本文が 29 行 (15%) で、
本文の「Excubitor 経由で `quaestor` を start し、 health が返るまで待つ」と
前後の「サービスの起動・再起動・起動テストはしない」が正面衝突していた。
`deps-sweep-daily` は本文が「commit、 push、 PR 作成はしない」と明記しているのに、
完了条件は「Revisor local PR を提出した」を要求していた。

終わり方も 2 系統あった。 本文の途中 (`### 完了時 (必須)`) で「退勤する」と言った 30 行あとに
「報告まで終わったら**このセッションは終了**します」が来る。

### 実害

`POST /v1/delegation/runs/:id/status` の completed は `verifyCompletionEvidence` で
feature branch を要求していたため、 コードを触らないパートタイマーの completed が
`completed rejected: no completion evidence (spawned checkout has no recorded feature branch)`
で failed へ落とされていた。 2026-09-02〜03 の quaestor-mail-sweep (4 件) / kaizen-daily /
deps-sweep-daily / vulnerability-response-daily / genius-ingest-daily はすべてこれ。
quaestor-mail-sweep は completed 0 件だった。

加えて `MENTION_ADMIN_STEP` の `<@${mention_user_id}>` はテンプレ変数展開で空へ潰れ、
委託先には `<@> ` という壊れた文字列が届いていた。

## 2. どうしたか

### 2.1 書式を分ける

`DelegationDefinition` に `category` を通し、 `resolveManualKind` は
**category = parttimer を語より優先して「雑用」**へ落とす。 `DelegationService.launch` は
parttimer を実装委託の経路から外す:

| | 実装委託 (employee / freelancer / test-qa) | パートタイマー |
| --- | --- | --- |
| Concordia コンテキスト前置き | 付ける | 付けない |
| Inject マニュアル | 実装 / レビュー / 設計相談 / テスト | 雑用 (`### 運用ルール` として本文内) |
| Genius command-pattern | 照会して差し込む | 照会しない |
| 本文の枠 | `buildImplementationInject` | `buildParttimerInject` |
| Memoria 追跡タスク | 起票する | 起票しない |
| `## Args` / `## Runtime Options` | 出す | 出さない (args は本文へ展開済み) |
| コミット代行の案内 | 出す | 出さない |
| prompt file 先頭 | `# Delegation: <call_name>` | `# <template title>` → **タスク本文** |
| run のメタ情報 | 先頭 | 末尾 1 行 |

### 2.2 Concordia が足す 3 点だけ

**Requirement ID: `SPEC-DELEGATION-PARTTIMER-INJECT`**

`buildParttimerInject` (delegation/parttimer-inject.ts) が出すのは次だけ。

1. **タスク本文** — 加工せず先頭に置く。
2. **進め方** — 「上の本文が依頼の全文」「書かれていない手順を足さない」「迷っても止まらない」
   「ポートは Excubitor catalog で解決」「人が読む文は日本語」。
3. **終わり方** — 報告 → `POST /v1/delegation/runs/:id/status` → `POST /v1/shutdown`。
   `completed` / `partial` / `failed` の 3 形を示し、 **結果にかかわらず 2 と 3 を必ず通す**
   と明記する。「やることが無かった / 設定未投入 / 途中で失敗した」でも同じ閉じ方をする。

管理者メンションは Cc が `admin.mention_user_id` を解決して具体値を埋める。
委託先に `GET /v1/admin/state` を引かせる手順は無くなり、 `<@>` に潰れる経路も消えた。

### 2.3 完了判定

`requiresCompletionEvidence(category)` が parttimer を対象外にする。
feature branch は実装委託の自己申告を疑うためのガードなので、 成果がコードでない run には
適用しない。 実装委託 (category 不明の run も含む) は従来どおりガードする。
判定には現在のテンプレートではなく、起動時に `delegation_runs.category` へ保存した snapshot を使う。
このため、同名の子会社委託や実行中のテンプレート編集で完了ポリシーが変化しない。

### 2.4 全 19 本の本文を書き直した

本文は `delegation/parttimer-prompts.ts` が持つ (seed.ts から分離)。 方針:

- 見出し (`# <title>`) は inject が付けるので、 本文はタイトルを繰り返さず「何をする回か」から始める。
- 終わり方 (退勤・メンション・status) は本文に書かない。 正本は footer 1 箇所。
- 手順・秘匿・レート制御・「信頼できない入力」の扱いは落とさない。
- 「人間の返事を待って止まる」を残さない。 判断が要るものは提示して報告へ回す。

書き直しで直した個別の欠陥:

| テンプレ | 直したこと |
| --- | --- |
| `morning-tasks` | 重い実装の委託先を「Agent tool (model=opus)」から `delegation_invoke` の `sol-mid` へ。 判断待ちで ask して止まる手順を「保留にして次へ進む」へ。 末尾の `/session-end` を footer へ移した |
| `team-review-regular` | 「neco から終了の指示が出るまでセッションを閉じない」を削除し、 返信が来なければ「未実施 (返信待ち)」として報告して退勤する形へ |
| `genius-ingest-daily` / `genius-ingest-tier2-nightly` | 共通手順の壊れた括弧 (`genius.config.json`。応答が無い … )` を修復し、 両者で共有する `GENIUS_INGEST_COMMON` に集約 |
| `claude-sonnet-5-walk` | 本文中の独自「完了時 (必須)」ブロック (メンション + shutdown) を削除 |
| レビュー系 3 本 | 「ローカル `refs/heads/<default-branch>` から detached の一時 worktree」の作り方を `LOCAL_MAIN_REVIEW_WORKTREE` に集約 |
| director 系 2 本 | Memoria タスク取得手順を `MEMORIA_TASK_PULL_PROCEDURE` として共有 (seed.ts から移動) |

`MENTION_ADMIN_STEP` は参照が無くなったので削除した。 「パートタイマーのテンプレ本文に
終わり方を書かない」という不変条件は seed のテストが守る。

## 3. 適用

`prompt_template` は boot 時の `upsertTemplate` で上書きされるので、 build + 再起動で反映される。
kind「雑用」の既定マニュアルは migration 82 (`parttimer-chore-manual`) が
既定文のままの行だけ差し替える (WebUI で編集済みの行は触らない)。

## 4. `ai-note-biweekly-review` を seed へ取り込んだ

この 1 本だけ seed に無い DB 専用行で、 title / description / 本文がすべて文字化けしていた
(`AI?????????`)。 さらに `model` が未設定で、 claude CLI の spawn は `--model` を固定しないと
上限切れの巻き添えで即 exit する。 内部 cron (`ai-note-biweekly-review`、 毎月 1 日・15 日) が
call_name をコードで持っているのだから、 テンプレも seed が持つ形にした
(`model: claude-sonnet-5` を他のパートタイマーと揃えて固定)。 本文は
`E:\\Document\\Ars\\fable\\ai-note-review\\INSTRUCTIONS.md` から書き起こし、
cron 起動で Notion MCP の OAuth が継がれず落ちる既知の失敗 (未認証なら何も変えずに報告して終わる) を
前提確認として先頭へ置いた。 boot の upsert で文字化け行が上書きされる。
