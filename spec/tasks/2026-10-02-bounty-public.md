---
task: 2026-10-02-bounty-public
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# バグバウンティ 4/5 — 公開読み出し API (Cc) と Actio の公開面

設計正本: `spec/feature/bug-bounty.md` §8 (`SPEC-BOUNTY-PUBLIC`)。価値 UX-CC-W7。ドメイン `bug-bounty` (支援)、
`bounty_public` の列は project-code-registry。前提: `2026-10-02-bounty-triage-fix` がマージ済み (公開用の要約が要る)。
2026-10-02 neco 指示「プロジェクトが public のものは Actio の認証なしオープンな領域で報告者と合わせて確認できる」。

## 目的

公開プロジェクトの採用済みの報告を、書き直した要約と公開名で誰でも見られるようにする。原文・非公開プロジェクト・
反映前の機微な報告は出さない。

## 完了条件 (Cc)

- [ ] `project_codes.bounty_public` (0 / 1、既定 0) を migration で足し、`/projects` の画面と API で設定できる。
- [ ] 公開してよいかの判定を純関数で持つ (公開プロジェクト・採用・機微なら反映済み)。判定できなければ出さない (CC-BOUNTY-INV-07)。
- [ ] `GET /v1/bounty/public-reports?project=<code>`: 返す項目は spec §8 の一覧だけ。原文・受付口・プラットフォームの id・
      判定の内部理由を返さないことをテストで固定する。
- [ ] 単体・結合テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。実行は指示があるまでしない。

## 完了条件 (Actio — Actio リポの PR)

- [ ] `/public/bounty` (ページ) と `/api/public/bounty/reports` (JSON) を、ローカルモードの境界と認証の外に置く。GET だけ。
      `project` はコードの形式で検証する。
- [ ] Actio のサーバが Cc の公開読み出し API を読み、60 秒までメモリに持つ。DB に保存しない。Cc に届かなければ
      「取得できません」を返し、古い内容を成功として出さない。
- [ ] `POST /api/tasks` が `source: "concordia.bounty.v1"` を受ける (既存の source / sourceRef の一意制約と所有の検査のまま)。
- [ ] Actio の spec (`spec/feature/`) に公開面の節を足す。フロントエンドとバックエンドを同じ PR で揃える。

## 実装に含めないもの

- 公開 URL の該当パスを Cloudflare Access の対象から外す設定 (Cloudflare 側の運用作業。neco の実行が必要)。

## スコープ (編集可ディレクトリ)

- Cc: `src/bounty/`、`src/api/bounty*.ts`、`src/db/schema.ts`、`src/db/project-codes-repo.ts`、`web/src/pages/ProjectCodes.tsx`、
  `web/src/api.ts`、`tests/`、`cc.acceptance.json`、`spec/feature/bug-bounty.md`
- Actio: `src/app.ts`、`src/auth/local-mode.ts`、新設の公開モジュール、`modules/task/` (source の受け入れ)、`frontend/`、`spec/feature/`
