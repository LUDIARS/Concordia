---
type: feature
title: "spec-index — spec frontmatter の機械生成索引"
description: "spec/**/*.md の OKF frontmatter を 1 行 1 ファイルの JSONL に集約する索引と、その成果物を git 管理外に置く運用。追跡していた頃は npm run build のたびに main が dirty になり、Revisor が全 PR のマージを拒否していた。"
service: concordia
domain: tooling
tags:
  - build-artifact
  - spec
  - tooling
status: implemented
related:
  - ../README.md
updated: 2026-07-31
---

# spec-index — spec frontmatter の機械生成索引

`tools/build-spec-index.mjs` が正本。`spec/**/*.md` の OKF frontmatter を集約し、
リポ root の `spec-index.jsonl` に **1 行 = 1 ファイル**の JSON として書き出す。
spec をグラフ的に検索したいとき (どの spec がどのドメイン / タグを持つか) に使う。

- 入力: `spec/**/*.md` の frontmatter (frontmatter が無い / `type` を持たないファイルは skip)
- 出力: `spec-index.jsonl` (リポ root)
- 実行: `npm run build:spec-index` (`npm run build` にも含まれる)
- `spec/tasks/` は索引に含めない (タスクは spec ではないため)

## 成果物は git 管理外 (2026-07-31)

`spec-index.jsonl` は **`.gitignore` 済み**。正本は `spec/**/*.md` の frontmatter で、
索引はそこから決定的に再生成できる派生物だから。

追跡していた頃は、次の連鎖でマージ経路全体が閉じていた:

```
npm run build → build:spec-index が再生成 → main が dirty
  → Revisor が「Cannot advance 'main'; its worktree is no longer clean」
  → 全 PR のマージを拒否
```

**誰か 1 人がビルドするだけで全員のマージが止まる**性質の障害で、実際に
Concordia local PR #11 のマージがこれで止まった。Revisor の清潔判定は untracked を
無視するため、追跡をやめることで再発しない。

索引が要るときはその場で作り直す。コミットしない。

## 参照状況

コードからの参照は無い (生成器自身と spec ドキュメントの言及のみ)。他リポ
(Revisor / Excubitor / Anatomia / Memoria) からも読まれていないことを確認済み。
将来この索引を他サービスから読ませたくなった場合は、**リポにコミットするのではなく**
生成して配る経路 (API なり成果物置き場なり) を用意すること — 派生物の追跡は上記の
障害を再発させる。
