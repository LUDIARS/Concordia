---
task: delegate-agent-spawn
project: Concordia
kind: 実装
created: 2026-08-09
memory_links: []
---
# Agent 起動を delegation へ委譲させる

## 目的

セッション内で subagent (Agent / Task tool) を直接起動されると、Concordia からは
子の存在・コスト・成果物が見えない。delegation 経路なら子セッションに面と状態カードが付き、
PR まで追跡できる (2026-08-09 neco 指示)。

## 完了条件

- ハーネス builtin ルールに「Agent 起動は delegation へ委譲」がある (ユーザ明示指示は例外)。
- セッション開始時の cc-workflow inject にも同じ規範が載る。
- Castra 側にスキルとメモリが用意されている (別リポなのでこの PR 外)。

## スコープ (編集可ディレクトリ)

- `src/subsidiary/harness-seed.ts`, `src/control/collaboration-context.ts`

## 補足

builtin ルールは title 一致で冪等投入されるため、新規行は稼働中 DB にもそのまま入る
(既存行の文言は上書きしない仕様なので migration は不要)。
