---
task: kaizen-parttimer-astra
project: Cc
kind: change
created: 2026-09-08
memory_links: []
---

# カイゼンのパートタイマーをAstraへ変更する

## 目的
カイゼンを指定されたAstraで起動し、難易度に応じて実装と委託を分担する。UX-CC-AD-W1。

## 対応範囲
agent-delegationのkaizen-daily seedのprovider/modelをCodex/gpt-6-astraへ変更する。
仕様: spec/feature/delegation.md。

## 受け入れ条件
- 新規および既存テンプレートへのseed適用でAstraが設定される。
- スケジュール、call_name、調査対象を維持する。
- 高難度はAstra自身が実装、低難度はプロジェクト指定の実装モデルへ委託する。
- 判断に困るものはタスク化し、DBに人間判断待ちを残して、その回のセッションを終了する。
- 進行中runを変更せず、配備と設定反映を区別する。

## 検証
既存Sonnetテンプレートへの再seed契約を確認する。テスト・起動の実行は人間の明示許可に従う。
