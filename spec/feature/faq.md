---
type: feature
title: "Concordia FAQ"
description: "Concordia 開発時によく出る疑問・紛らわしい構成についての Q&A 集。worktree/ブランチ整理や周辺ディレクトリの扱いなど、spec の他ドキュメントに書くほどではないが繰り返し確認が要る事項を記録する。"
service: concordia
domain: session-coordination
tags:
  - faq
  - worktree
  - rwf
  - reaction-workflow
status: implemented
related:
  - feature/discord-ui.md
  - plan/refactor-3axis-architecture.md
updated: 2026-07-09
---

# Concordia FAQ

## `E:/Document/Ars/Concordia-RWF` ディレクトリは何か？削除してよいか？

**削除しない。** Reaction-WorkFlow (RWF) 機能を管理する独立リポジトリ
(`LUDIARS/Concordia-RWF`) のクローン。Concordia 本体からは
[`plugins/concordia-rwf/`](../../plugins/concordia-rwf/README.md) として
ランタイム動的 import される「ユーザカスタマイズプラグイン」の開発元。

- 現状は submodule 化されており、`Concordia` フォルダ以下で開発できる構成になっている。
- worktree 整理 (2026-07-09) の際、独立 clone のため `git worktree list` には出ず、
  かつ現行 `main` より古いコミットで止まっていたため一見孤立ディレクトリに見えるが、
  意図して残されている前提で扱うこと。
- 関連: [plan/refactor-3axis-architecture.md](../plan/refactor-3axis-architecture.md) §軸B
  （チャット連携 + RWF）。

## worktree/ブランチが大量に残っているのは正常か？

正常ではない。Codex/Claude の作業用 worktree は使い終わったら
`git worktree remove --force` + `git branch -D` で作り捨てる運用
([[worktree-hygiene]] skill 参照)。放置すると `git worktree list` /
`git branch -vv` が肥大化し、どれが生きているか分からなくなる
(2026-07-09 時点で worktree 15→1、ローカルブランチ 37→3 に整理した実績あり)。
削除前に「対象コミットが `origin/main` の祖先か (`git merge-base --is-ancestor`)」
「未コミット差分が無いか (`git status --short`)」を必ず確認してから作り捨てること。
