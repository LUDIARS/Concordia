---
task: delegation-inject-bundle
project: Concordia
kind: 実装
created: 2026-09-01
memory_links: []
---
# 実装委託 seed に着手時バンドル 6 手 (ドメイン→再利用探索→テスト計画→実装→検証→回帰) を組み込む

## 目的
neco 指示 (2026-09-01) の 4 規約 (ドメイン先行 / 再利用探索 / テスト対計画 / 回帰) は
AIFormat `HARNESS.md` §2.0 の着手時バンドルとして規約化済み (PR #1179 マージ)。
Codex には harness hook が効かないため、委託先への伝達経路は seed 本文だけ。現状の
`src/delegation/implementation-inject.ts` は「Anatomia の解析グラフから引く」1 行のみで、
再利用探索の採否記載・`augur plan` によるテスト計画・ドメイン先行の順序が入っていない。

## 完了条件
- `buildImplementationInject()` の「着手前の把握」節に「着手時バンドル」小節を足し、
  6 手をこの順で番号付きで出す:
  1. ドメインを定義する前にコードを書かない (`anatomia where` → `membership.pathPattern` 追加 or
     `spec/domains/<name>.domain.json` を先に書く、同じ PR に含める)
  2. 再利用できる実装を解析グラフから探す (`anatomia find` / `context` / `callers`、採否と理由を
     PR 説明に 1 行、見つけたら必ず使うではない)
  3. テストを対で計画する (Anatomia `test-suggestions` → `augur plan`、減らすときは理由を書く)
  4. 実装 (src と tests を同じ変更単位で)
  5. 検証 (`git diff | anatomia verify`、Revisor gate は enforced、解析不能は fail)
  6. 回帰 (変更種別の既存テスト)
- 完了条件チェックリストに「着地ドメインを Anatomia に登録した」「再利用探索の採否と理由を
  PR 説明に書いた」「テスト計画 (`augur plan`) に沿って対のテストを実装した」の 3 行を足す。
- `implementation-inject.test.ts` に 6 手の存在・順序・チェックリスト 3 行を固定するテストを足す。
- `npm test` (vitest, isolate:false) が green。Revisor local PR を提出する。
- マージ後は Concordia の build + Excubitor 再起動が必要 (dist 実行) なことを報告に含める。

## スコープ (編集可ディレクトリ)
- `src/delegation/implementation-inject.ts` / `src/delegation/implementation-inject.test.ts`
- 文言の正本化が必要なら `src/taskflow/task-instructions.ts` (task-workflow spec §2.1 の集約先)
