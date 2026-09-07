---
task: detect-provider-context-capacity
project: Concordia
kind: 実装
created: 2026-09-07
memory_links: []
---

# コンテキスト使用量と実効上限を検知する

## 目的

necoの218k・83% usedという報告と、Ccの既定分母200kの乖離を解消する。218k÷83%の約263kは仮説であり上限として固定しない。

## 完了条件

- セッションに紐付いた計測元から現在使用量・実効上限・取得時刻・取得元を取得する。
- Codexのmodel_context_window等を確認し、API最大値とCLI実効設定、累積量と現在占有量を区別する。
- キャッシュ内包量を二重加算しない。未登録transcript・古い計測・上限不明は明示的な未確定状態にし、自動圧縮を発火させない。
- 表示・警告・自動判定を同じ計測根拠に統一し、218k報告との照合結果を別の調査記録に残す。

## スコープ (編集可ディレクトリ)

src/cost/、src/control/、src/discord/、関連するsrc/shared/・src/db/とspec/。Lictor変更が必要なら別プロジェクトのタスクとして分離する。

テスト・起動・再起動は明示許可なしに実行しない。成果と進行状態は別の記録およびCc DBで管理し、このtask mdには書き戻さない。

