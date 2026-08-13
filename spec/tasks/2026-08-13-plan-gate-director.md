---
task: plan-gate-director
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/plan-gate.md
  - spec/feature/director.md
---
# Director plan step + プラン版管理 + 承認 API

## 目的
プランゲートの進行正本を Director に持たせる (plan-gate §2.2, §3)。

## 完了条件
- director step 種別に `plan` が追加され、case 起案 → plan active → 承認 → delegate 起案
  の遷移が動く。
- `POST /v1/director/cases/:id/plan` が受け入れ条件の存在を決定論で検査し、欠落は
  差し戻し (承認不可) になる。
- プラン版 (`plan_version` / `plan_md_ref`) と全判断が `director_decisions` に監査保存
  され、追跡できる。
- 承認 / 修正指示 / 破棄の状態遷移 API が揃う (Discord UI は別タスク)。
- 遷移・検査・版管理の単体テストが green。

## スコープ (編集可ディレクトリ)
- src/director/
- src/api/
- src/db/
