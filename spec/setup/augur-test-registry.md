---
title: Augur テスト台帳
type: setup
---

# Augur テスト台帳

`.augur/tests.jsonl` は Revisor が読む追跡対象の台帳である。既存テストは `node tools/augur-register-existing.mjs` で `spec/domains/*.domain.json` の membership に従って再登録する。`src/**/*.test.ts` と `tests/**/*.test.ts` の双方を対象にし、business と program には同じ宣言済み domain 名を使う。各テストが import する `src/` モジュールは Anatomia の anchor に解決して登録する。解決できない import は anchors を空のまま保持し、推測した anchor は登録しない。実行後は `node E:/Document/Ars/Augur/bin/augur.mjs tests lint --repo .` で整合を確認する。

## web/ のテストと worktree

台帳には `web/src/**/*.test.tsx` も載っており (22 件、2026-10-13)、Revisor はルートの vitest 設定でまとめて走らせる。
そのためルート `vitest.config.ts` から `web/**` を除外しない (除外すると登録済みの web テストが審査で走らなくなる。
2026-10-13 #2782 で除外を試し、未実行として審査が止まった)。

web のテストは `react/jsx-runtime` などを `web/node_modules` から解決する。task worktree には `web/node_modules`
が無いので、ルートで web のテストを含めて走らせる前に、次のどちらかを行う。

- `npm --prefix web ci` で worktree に web の依存を入れる。
- 本体 checkout の `web/node_modules` へ junction を張る (`New-Item -ItemType Junction -Path web/node_modules -Target <本体>/web/node_modules`)。
  junction は `.gitignore` 対象。stage はパス指定で行い、`git add -A` で巻き込まない。片付け時は `rmdir` で junction だけを外す。

変更箇所のテストだけを走らせるときは、`web/` を含まないファイルを指定すれば依存は要らない。

## Praeforma scenario の対応表

`.augur/praeforma.json` は Concordia project (`01M1XZZMEXWTFCN4HKW8K7TJKM`) を参照する。2026-09-16 の GET `/api/projects/<projectId>/ux-design/scenarios` では scenario が 0 件だったため、`scenarios` は空である。これは体験確認済みを意味しない。

Pf 側で UX-CC-W1〜W5 に対応する scenario を登録した後、GET `/api/projects/<projectId>/ux-design/scenarios` で ID を確認する。`scenarios` に各価値 ID をキーとして `{ "scenarioId": "<Pf scenario id>", "useCaseId": null }` を追加し、必要なら use case ID を指定する。Pf への登録・編集はこのリポジトリから行わない。

PR では通常、変更 anchor に対応した runtime テストだけを選ぶ。`always` の command レコードは登録しない。全体 `vitest run` は PR バンドルの代替にせず、必要な変更箇所だけを実行する。
