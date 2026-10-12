---
task: worktree-add-hook-failure
project: Concordia
kind: 実装
status: review
created: 2026-10-12T00:00:00.000Z
source_session: lictor-9244e20e-f528-4815-8559-92e65391b59c
memory_links:
  - actio:170865b7-b083-4ec0-9cfe-3b0377f678b2
  - actio:b946be86-944a-4b39-a04b-66b1f8c2d53e
---

# 委託 worktree 作成の post-checkout 失敗を正しく扱う (#32)

## 要件

spec/feature/delegation-spawn-target-validation.md §2.5

## 分解

- [x] `src/control/worktree-add-failure.ts`: 非 0 終了後の登録状態から adopt / cleanup を決める純関数
- [x] `src/control/spawn-target.ts`: add 失敗時に判定を呼び、adopt は warning 付き成功、cleanup は作りかけを除去
- [x] 契約 `wtadd-C-1` (augur.contracts.json + 述語モジュール)
- [x] 単体テスト (純関数 / git 呼び出しを差し替えた prepareSpawnTarget)
- [x] spec §2.5、cc.acceptance.json の implementations

## 範囲外

実際の worktree 作成を伴う動作確認、Cc 実行環境の PATH に git-lfs があるかの確認。
