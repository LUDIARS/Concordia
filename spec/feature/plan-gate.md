---
type: feature
title: "プランゲート — 設問→設計→承認を Discord 上で行うプランモード"
description: "Claude Code のプランモードを Discord の工程として再現する。分解セッションが設問カードで不明点を解消し、受け入れ条件必須のプランを設計カードとして提示、人間 (または Genius 代理) が承認・修正指示・破棄で判断する。承認までコード編集をハーネスで封鎖し、承認後にプランを task md 群へ確定してワンショット委託を起案する。"
service: concordia
domain: governance
tags:
  - plan
  - director
  - discord
  - harness
  - genius
  - delegation
status: planned
related:
  - feature/session-contract.md
  - feature/director.md
  - feature/director-goal-flow.md
  - feature/task-workflow.md
  - feature/deterministic-teardown.md
updated: 2026-08-24
---

# プランゲート — Discord 上のプランモード

> 2026-08-13 neco 指示。 「設問→設計→修正判断」を Discord 上で回す。
> プランには**タスクの終了条件 (受け入れ条件) を必ず設定する**。

## 0. 位置づけ

- セッション契約 (session-contract) で `mode: "plan"` に判定されたセッションが入る工程。
- Director の case/step (director.md、 実装済み) に **`plan` step** を追加し、 その
  Discord UI として実装する (director.md §4 の「後続工程」の一部)。
- 対応関係: プランモードの読み取り専用調査 = 封鎖述語 / AskUserQuestion = 設問カード /
  ExitPlanMode = 設計カードの承認ボタン / 承認後の編集権限 = ワンショット委託の起案。

## 1. プランの契約 (スキーマ)

プランは自由文ではなく最低限の構造を持つ Markdown:

```markdown
# <タイトル>
## 目的
## 受け入れ条件        ← 必須。空のプランは承認ボタンが出ない
## スコープ (編集可ディレクトリ)
## タスク分解          ← 承認時にそのまま task md 群 (task-workflow §2.1) へ落ちる
```

- **受け入れ条件が空のプランは Cc が決定論で差し戻す** (投稿時に検査し、 欠けていれば
  「受け入れ条件を書いて再提出」を inject する。 承認ボタンは付けない)。
- 受け入れ条件は完了側でも使う: completed 報告の status payload に各条件の自己申告
  (満たした / 未達 + 理由) を含めさせ、 residual 判定と confirm 通知の材料にする
  (deterministic-teardown §3)。

## 2. 工程

```
契約確定 (mode=plan) → [設問] → [設計 v1..vN] → [承認] → task md 確定 → ワンショット委託
                          │           │
                     Genius 代答   修正指示ループ
```

### 2.1 設問フェーズ

- 担当セッションは読み取り調査のみ (封鎖述語 §4 が効いている)。 不明点は自由文の質問では
  なく **Decision Request** (director.md §2、 kind/question/facts/options/impact) で出す。
- Cc は Decision Request をまず Genius へ取り次ぐ (既存 `GeniusClient`)。 `proceed` で
  答えられた分は人間に見せない。 `ask_human` 分だけを**設問カード 1 枚**に束ねて
  direction チャンネル (teams §2。 未導入時はセッションスレッド) へ投稿する。
- 設問カードは既存 `discord_pending_questions` 基盤 (ボタン / セレクト / `[A]` テキスト返信)。
- 実装: `src/director/ask-bridge.ts`。 `DirectorService.onAskHuman` が ask_human 判断を
  step 単位の短い束ね窓 (既定 1.5s) で集め、 1 枚の pending question として発行する
  (複数項目は `Q1:` 前置の選択肢 + 複数選択メニュー)。 カードと判断の対応は
  `director_decisions.pending_question_id` が正本で、 回答 (`question.answered`) は
  `human_answer` / `human_answered_at` へ監査保存し、 工程を blocked → active に戻して
  担当セッションへ inject する。 選択が付かない項目には回答本文をそのまま充てる
  (自由文回答は束ね全体への指示として扱う)。 plan 提出由来の ask_human (設計カード経路)
  は束ねの対象外。個別 Decision Request は Discord と同じ 25 選択肢・ラベル 80 文字を上限とする。
  束ね結果が Discord の 1 カード 25 選択肢上限または本文上限を超える場合は
  複数カードに分け、同じ step の全カードが回答済みになるまで blocked を保つ。
  束ね窓中に停止した未投稿判断と、回答保存後に decision 反映前で停止した行は
  次回起動時に回収する。

### 2.2 設計フェーズ

- セッションがプラン md を書き、 `POST /v1/director/cases/:id/plan` で提出する。
- Cc は受け入れ条件の存在を検査し、 通れば case スレッドへ **設計カード**を投稿:
  プラン全文 (長ければ md 添付) + 要約 embed + ボタン
  `[承認して実行] [修正指示] [破棄]`。
- `修正指示` → Modal (自由文 TextInput) → 内容を担当セッションへ inject → セッションが
  プラン v(n+1) を再提出 → 新しい設計カードを投稿 (旧カードは「v(n) — 改訂済み」に編集)。
- プランの全版と判断は `director_decisions` に監査保存する。

### 2.3 承認と実行

- `承認して実行` → プランの「タスク分解」節を task md 群として対象リポ `spec/tasks/` に
  確定 (分解保存はセッションに inject して書かせる — md 正本の原則を維持)、
  taskflow reconciler が拾い、 **ワンショット委託** (deterministic-teardown §4 の再キュー
  レーン) を起案する。
- `破棄` → case を cancelled にし、 担当セッションへ通知。 封鎖は解除しない
  (次の指示を待つ)。

### 2.4 Genius 代理承認レーン (後続)

- スコープが小さいプラン (編集ファイル数・対象リポ数が閾値内、 かつ 権限/スコープ/破壊的
  操作を含まない) は Genius が代理承認できる。 director.md の原則どおり `authority` /
  `scope` を含むものは Genius 不在でも **ask_human 固定**。
- 代理承認は監査カード (「Genius が代理承認しました + 根拠カード」) を必ず投稿する。
- 初期実装ではこのレーンは作らず、 全プランを人間承認とする (Phase 分割)。

## 3. Director への差分

- step 種別に `plan` を追加 (`decompose` の前段。 既存 `decompose` は plan 承認後の
  task md 確定処理として plan step の完了に吸収してよい)。
- `director_decisions` にプラン版 (`plan_version`, `plan_md_ref`) を持たせる。
- 遷移: case 起案 → `plan` active → (設問/設計ループ) → 承認 → `delegate` 起案。

## 4. 封鎖 (ハーネス)

- session-contract の `contract-incomplete` 述語と共用の枠組みで、 新述語
  `plan-unapproved` (**deny**): 契約 `mode: "plan"` のセッション (および同じ case に
  紐づく委託子) は、 case に承認済みプランが無い間コードファイルの編集を deny。
- .md / spec / docs は対象外 (プラン自体・調査メモは書ける)。

## 5. vibes からの昇格 / plan からの降格

- vibes 作業中に「大ごと」と判明したら、 契約更新 (task-change 再判定 or 人間ボタン) で
  `mode: "plan"` へ昇格 → testing claim を release → 設問フェーズに入る。
- plan の設問・設計中に「実は軽微」と判明したら、 人間承認でのみ vibes へ降格できる
  (自動降格はしない — 封鎖を開ける方向は常に人間)。

### 実装 (contract-mode-switch)

- 切替は `src/contract/mode-switch.ts` が契約更新 (human tier) として行い、
  `preserveHumanDecisions` で task-change 再シードでも保持される。
- 昇格: vibes-file-limit の質問カード回答 (`startModeSwitchAnswers` が消費)、 または
  `POST /v1/sessions/:id/contract/mode-switch {target:"plan"}` で即時適用。 適用時に
  testing claim release + `plan_approved=false` で plan gate (`plan-unapproved`) を立て直す。
  カードの Stop 回答は claim release + session blocked。
- 降格: `POST /v1/sessions/:id/contract/mode-switch {target:"vibes"}` は承認カードを
  投稿するだけで契約を変更しない。 人間の承認回答だけが vibes へ書き換え、 確定時に
  testing claim を自動取得する。 汎用 `PATCH /v1/sessions/:id/contract` は `mode` を
  受け付けない (`mode_switch_required`) — 無承認降格の抜け道を残さない。
- 切替カードの状態遷移は明示した選択肢の回答だけを受理し、自由入力は承認や Stop として
  解釈しない。
- Discord のセッションチャンネルでは `/co-mode target:<plan|vibes>` を同じ API へ接続する。
  コマンド経由でも plan→vibes の人間承認を迂回しない。

## 6. 受け入れ基準

- [ ] mode=plan のセッションは承認済みプランが出るまでコード編集が deny される。
- [ ] 受け入れ条件の無いプランは承認ボタンが表示されず、 差し戻し inject が飛ぶ。
- [x] 設問カードの ask_human 分だけが人間に届き、 Genius が答えた分はカードに載らない
      (監査ログには残る)。
- [ ] 修正指示 Modal の内容がセッションへ inject され、 v2 の設計カードが投稿される。
- [ ] 承認でプランのタスク分解が task md 群として保存され、 ワンショット委託が起案される。
- [ ] プラン全版・全判断が director_decisions から追跡できる。
- [ ] `[A]` テキスト返信 (Lictor relay 経由) で設問・承認が完結する。
