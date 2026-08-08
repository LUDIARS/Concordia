---
task: utf8-payload-and-upstream-attribution
project: Concordia
kind: 実装
created: 2026-08-09
memory_links: []
---
# 細かい修正まとめ (2026-08-09)

## 目的

neco 指摘の細かい不具合を 1 本にまとめる。

1. **testing claim の note が文字化けする** — シェルに日本語 body を直書きする案内文が原因。
   Concordia に届いた時点で `?` に潰れており復元不能なので、案内を直して発生源を断つ。
2. **test-forum reconcile の `fetch failed` が原因不明** — Excubitor catalog 参照と Revisor
   要求の 2 段があるのに、どちらが落ちたのかログから読めない (実際は Revisor の停止だった)。

## 完了条件

- `src/skills/concordia.md` と起動時ガイダンス (`src/testing/branch-watch.ts`) が
  「日本語 body はファイル経由」を明示している。
- Revisor クライアントの失敗が「Excubitor catalog lookup / Revisor request (宛先つき)」に
  切り分けられ、undici の `cause` (ECONNREFUSED 等) と timeout 判定が文言に載る。

## スコープ (編集可ディレクトリ)

- `src/skills/concordia.md`, `src/testing/branch-watch.ts`, `src/pr/revisor-test-workflow-client.ts`

## 関連 (このリポ外)

- Castra `.claude/skills/cc-test` / `cc-deploy` を同じ方針へ修正済 (main 直コミット)。
- Revisor 本体が crash loop (24h 稼働率 70.9%、memory-leak 警告) — 別件として neco へ報告済み。
