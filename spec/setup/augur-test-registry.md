---
title: Augur テスト台帳
type: setup
---

# Augur テスト台帳

`.augur/tests.jsonl` は Revisor が読む追跡対象の台帳である。既存テストは `node tools/augur-register-existing.mjs` で `spec/domains/*.domain.json` の membership に従って再登録する。実行後は `node E:/Document/Ars/Augur/bin/augur.mjs tests lint --repo .` で整合を確認する。

PR では通常、変更 anchor に対応した runtime テストだけを選ぶ。`always` の command レコードは登録しない。全体 `vitest run` は PR バンドルの代替にせず、必要な変更箇所だけを実行する。
