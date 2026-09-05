---
task: rwf-skill-entries
project: Concordia
kind: 実装
status: in_progress
created: 2026-09-05T00:00:00.000Z
source_session: lictor-bee0548e-952a-436a-8602-57349bc280a9
memoria_task_id: 2102
pr_number: null
actio_task_id: null
memory_links: []
---
# RWF を「絵文字 → スキル」に揃え、委託 seed をドメイン先行にする (C-2 / C-7〜C-11)

設計正本: `E:/Document/Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md`
(§5 の C-2 / §9.2 の C-7 / §10 の C-8〜C-10 / §11 / §12.3-12.4 の C-11)。
第 3 PR の後半にあたる Concordia 側の実装。 Castra の `.claude/` (スキル本体) は
2026-09-05 に取り込み済み (`E:/Document/Ars` の `301cae4`) で、 本 PR では触らない。

## 目的

1. **RWF の写像を「絵文字 → スキル」の一本に揃える**。 これまで Cc のコード
   (`reaction-workflow.ts` の `case` 群) に埋まっていたプロンプト本文を Castra の
   スキル (`.claude/skills/<name>/SKILL.md` / `.claude/commands/<name>.md`) 側の正本へ寄せ、
   Cc は「どの絵文字がどのスキルを、 どの mode / model / cwd で呼ぶか」だけを持つ。
   同じ文面が 2 箇所にある状態 (Cc のコード + スキル) を解消する。
2. **ドメインレビューを RWF から起動できるようにする** (📑 = 情報投稿 / 🪬 = 対話レビュー)。
3. **委託の指示書をドメイン先行にする**。 委託前に横断ドメインマップで対象プロジェクトを
   確定し、 OKF ドメイン計画を指示書の先頭へ織り込む。 委託される側は plan を走らせて
   いない新しいセッションなので、 ドメインの説明・所有パス・既存のデータ定義が
   一緒に来ないと「正しいドメインに置け」を実行できない。

## 完了条件

- [x] **C-8 スキル一覧**: `.claude/skills/*/SKILL.md` と `.claude/commands/*.md`、
      `~/.claude/skills` を走査して `{ name, description, path, source, rwf }` を返す。
      起動時に走査し `POST /v1/skills/refresh` で再走査。 表示名は frontmatter
      `description` の先頭 1 文、 frontmatter が無いファイルは先頭見出し。
      走査は指定ルート配下に限定し、 `..` やパス区切りを含む名前を弾く。
      SKILL.md の中身は他人が書いたテキストとして扱い、 一覧は列挙しかしない。
- [x] **C-9 スキル種別のエントリ**: `CustomWorkflowEntry` に
      `{ emoji, kind: "skill", skill, args?, mode, model?, cwd?, action? }` を足す。
      `inject` は `/<skill> <args>` を session へ、 `headless` は **SKILL.md 本文を
      システム文脈として** `claude -p` に渡す。 `--model` は必ず固定する。
      非 active セッションでは inject 指定でも headless へ落ちる。
- [x] **C-7 📑 / 🪬**: 📑 = headless sonnet で `domain-review --report-only`、
      🪬 = active へ inject / 非 active は headless opus。
      `project_codes.domain_review` が OFF のプロジェクトでは 🪬 は「設定 OFF」と返し、
      📑 は止めない。 **列がまだ無い環境では判定不能として扱い発火を止めない**
      (列を足す PR とのマージ順に依存しない)。
- [x] **C-10 設定画面**: 「スキル割り当て」表 (絵文字 × スキル × mode × model × cwd) を
      追加し、 保存先は既存 customWorkflows JSON。 スキルの description をヘルプに流す。
      「組み込み写像をスキルへ移行」ボタンから移行 API を叩ける。
- [x] **§11.2 の 2 移行**: `POST /v1/reaction-workflow/migrate-builtin` が組み込み写像を
      seed に「絵文字 → skill エントリ」を JSON へ書き出す。 `classifyReactionWorkflow` は
      スキルエントリを先に引き、 残った組み込みだけ従来分岐。 移行できた `case` の
      プロンプト本文は削除。 **取りこぼした絵文字が無いこと**をテストで機械的に固定する
      (`WORKFLOW_EMOJI` の全キーが「skill エントリ」か「組み込み据え置き」に属する)。
- [x] **§11.2 の 3**: model / cwd はスキル側 frontmatter (`metadata.rwf`) を既定にし、
      設定画面で上書き可能。 env `CONCORDIA_REACTION_MODEL_*` は互換のため残す。
      異体字セレクタの有無で取りこぼさない (正規化してテストで固定)。
- [x] **C-2 + C-11 委託 seed**: invoke 前に `GET /api/domain-map/search` でプロジェクトを
      確定し、 `POST /api/plan { okf: true }` の OKF 出力を指示書の先頭へ埋め込む。
      0 件なら「索引に無い」と書いて人間の確認を促す。
      **Anatomia が落ちている / 索引に無い / ドメイン定義が無いときは織り込みを飛ばして
      従来どおりの指示書を出す (委託を止めない)**。
      テンプレ本文の 3 行を `where → 紐づけ → verify` から `plan → 紐づけ → verify` へ。
- [x] spec `spec/feature/reaction-workflow.md` §1 の表をスキル名で書き直す。
- [x] 追加・変更したテストが緑 (`src/platform` / `src/skills/catalog` /
      `src/delegation/domain-preamble` / `tests/skills-catalog-api`)。

## スコープ (編集可ディレクトリ)

- `src/platform/` (RWF: 語彙 / 契約 / スキル写像 / JSON store / Runner)
- `src/skills/` (スキルカタログの走査とキャッシュ)
- `src/anatomia/` (domain-map / plan の読み取りクライアント)
- `src/delegation/` (ドメイン先行の前置き、 テンプレ本文)
- `src/api/` (`/v1/skills` / `/v1/admin/reaction-skill-workflows` / 移行 API)
- `src/db/project-codes-repo.ts` (`domain_review` の後方互換な参照)
- `src/bootstrap/core.ts` / `src/app.ts` / `src/discord/bot.ts` / `src/slack/bot.ts` (配線)
- `web/src/pages/settings/sections/` (スキル割り当て表)
- `spec/feature/reaction-workflow.md` / `spec/tasks/`

## やらないこと

- Castra の `.claude/` (スキル本体・hook) の変更 — 別委託で取り込み済み。
- `project_codes.domain_review` 列の追加と `/projects` UI、 Discord へのドメイン情報投稿
  (C-3〜C-6) — 別 PR (Revisor local PR #1405)。 本 PR は列が無い場合のフォールバックだけ持つ。
- Anatomia 側 (A-12〜A-14) — マージ済み。

## 前提未確定

- `project_codes.domain_review` 列は本 PR の時点で main に無い。 参照側は
  `PRAGMA table_info` で列の有無を見て、 無ければ「判定不能 = 止めない」に倒している。
  #1405 がマージされた後は、 列の値がそのまま効く。
- 委託テンプレの `default_cwd` が worktree を指す場合、 map 検索のプロジェクト確定は
  basename の先頭一致で拾う。 `.wt-<Code>-...` 形式の worktree 名は拾えないので、
  その場合は最上位ヒットのプロジェクトを使う。
