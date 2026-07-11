---
type: feature
title: "Skill snapshot と履歴レビュー"
description: "各 repository の SKILL.md snapshot を受け取り、content hash、成長、poison signal を解析して SQLite に履歴保存し、最新一覧と最大50件の履歴を UI/API へ公開する。"
service: concordia
domain: analysis-core
tags:
  - skill
  - snapshot
  - history
  - sqlite
  - api
  - monitoring
status: implemented
updated: 2026-07-11
---

# Skill snapshot と履歴レビュー

## 目的

各 agent session の hook から repository ごとの `SKILL.md` 内容を snapshot として受け取り、
サイズ・節数・growth・poison signal の変化を追跡する。同一内容の重複保存を避け、Web UI から
最新状態と履歴を確認できるようにする。

API は [`src/api/skills.ts`](../../src/api/skills.ts)、解析は
[`src/skills/analyzer.ts`](../../src/skills/analyzer.ts)、永続化は
[`src/db/skills-repo.ts`](../../src/db/skills-repo.ts)。

## snapshot 処理

入力は次の shape。

```text
{
  repo_origin?: string | null,
  repo_path: string,
  skill_name: string,            // 1..64 chars
  content: string,               // 0..200000 chars
  source?: setup|self-update|external|hook  // default hook
}
```

同じ `(repo_path, skill_name)` の直前 snapshot と比較し、`concordia` skill だけは同梱
`src/skills/concordia.md` も baseline として解析する。解析結果は content hash、bytes、lines、
sections、poison score/reasons、growth score/notes。

直前と `content_hash` が同じ場合は insert せず
`{ skipped:"no_change", snapshot }` を返す。変化があれば `skill_snapshots` に full content と
解析値を保存し、`skill.snapshot` event を emit する。

## API

mount path は `/v1/skills`。

| メソッド | path | 契約 |
|---|---|---|
| POST | `/snapshot` | snapshot を検証・解析し、同一 hash は skip、変化時は保存 |
| GET | `/` | 各 `(repo_path, skill_name)` の最新 snapshot 一覧 |
| GET | `/history` | `repo_path` 必須、`skill_name` 既定 `concordia`、新しい順で最大 50 件 |

API response は full content を返さず、先頭 1,500 文字の `content_preview` を返す。preview が
切り詰められた場合は末尾に `…` を付ける。poison reasons と growth notes は JSON parse し、
壊れた保存値は raw string のまま返す。

## 永続化

`skill_snapshots` は append 型履歴。各 row は repo、skill、timestamp、hash、full content、
構造量、source、poison/growth の値を持つ。最新一覧は `(repo_path, skill_name)` ごとの最大
`ts`、履歴は `ts DESC` で取得する。

## 制約

- full skill content は SQLite に保存される。API preview が短いことは保存データの秘匿を
  意味しないため、secret を skill 本文へ含めない。
- 同一秒に複数 snapshot が入ると `MAX(ts)` join で複数 row が最新一覧に現れ得る。
- 本機能は診断結果を表示するだけで、skill 内容を自動修正しない。

## 関連

- [data/schema.md](../data/schema.md)
- [testing traffic](./testing-traffic.md)
