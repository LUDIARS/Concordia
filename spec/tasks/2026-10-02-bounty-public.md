---
task: 2026-10-02-bounty-public
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# バグバウンティ 4/5 — 公開読み出し API (Cc) と Actio の「パブリックイシュー」

設計正本: `spec/feature/bug-bounty.md` §8 (`SPEC-BOUNTY-PUBLIC`)。価値 UX-CC-W7。ドメイン `bug-bounty` (支援)、
`public_issues` の列は project-code-registry。前提: `2026-10-02-bounty-triage-fix` がマージ済み (公開用の要約が要る)。
2026-10-02 neco 指示「プロジェクトが public のものは Actio の認証なしオープンな領域で報告者と合わせて確認できる」
「Actio のバグバウンティのバグは『パブリックイシュー』とし、他のバウンティがない公開物も見れるようにする」
「正確にはバグ等のイシュー的なタスク」。

## 目的

公開プロジェクトのイシューを、認証なしで誰でも見られるようにする。並べるのは、採用済みのバグ報告 (報告者の公開名と報奨つき) と、
バウンティのないイシュー (Actio の種別がイシューのタスク)。原文・非公開プロジェクト・反映前の機微な報告・担当者は出さない。

## 完了条件 (Cc)

- [ ] `project_codes.public_issues` (0 / 1、既定 0) を migration で足し、`/projects` の画面と API で設定できる。
- [ ] 公開してよいかの判定を純関数で持つ (公開プロジェクト・採用・機微なら反映済み)。判定できなければ出さない (CC-BOUNTY-INV-07)。
- [ ] `GET /v1/bounty/public-reports?project=<code>`: 返す項目は spec §8 の一覧だけ。原文・受付口・プラットフォームの id・
      判定の内部理由を返さないことをテストで固定する。対応する Actio タスクの参照 (報告 id) を返す。
- [ ] `GET /v1/projects/public-issues`: 公開プロジェクトのコード一覧。
- [ ] バウンティ由来の Actio タスクを種別 `issue` で作る (タスク 2 の作成処理へ 1 項目足す)。
- [ ] 単体・結合テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。実行は指示があるまでしない。

## 完了条件 (Actio — Actio リポの PR)

- [ ] タスクの種別に `issue` を足す (既存は `task` / `goal`)。作成・更新 API と画面で選べる。`public_hidden` (公開しない) と
      `public_summary` (公開用の要約、任意) を足す。
- [ ] `/public/issues` (ページ) と `/api/public/issues` (JSON) を、ローカルモードの境界と認証の外に置く。GET だけ。
      `project` はコードの形式で検証する。
- [ ] 並べるもの: Cc の公開読み出し API から取ったバウンティのイシューと、公開プロジェクトの `kind: "issue"` で `public_hidden` でない
      タスク。`source: concordia.bounty.v1` のタスクはバウンティの行にまとめ、二重に並べない。
- [ ] バウンティのないイシューで出すのは題名・公開用の要約・状態・優先度・作成と完了の時刻だけ。本文・要件・担当者・作成者を
      出さないことをテストで固定する。
- [ ] Cc から読んだ内容は 60 秒までメモリに持ち、DB に保存しない。Cc に届かなければバウンティの欄は「取得できません」、
      公開プロジェクトの一覧も取れなければ何も出さない。
- [ ] `POST /api/tasks` が `source: "concordia.bounty.v1"` を受ける (既存の source / sourceRef の一意制約と所有の検査のまま)。
- [ ] Actio の spec (`spec/feature/`) にパブリックイシューの節を足す。フロントエンドとバックエンドを同じ PR で揃える。

## 実装に含めないもの

- 公開 URL の該当パスを Cloudflare Access の対象から外す設定 (Cloudflare 側の運用作業。neco の実行が必要)。

## スコープ (編集可ディレクトリ)

- Cc: `src/bounty/`、`src/api/bounty*.ts`、`src/db/schema.ts`、`src/db/project-codes-repo.ts`、`web/src/pages/ProjectCodes.tsx`、
  `web/src/api.ts`、`tests/`、`cc.acceptance.json`、`spec/feature/bug-bounty.md`
- Actio: `src/app.ts`、`src/auth/local-mode.ts`、`src/db/` (tasks の列と migration)、新設の公開モジュール、`modules/task/`、`frontend/`、`spec/feature/`
