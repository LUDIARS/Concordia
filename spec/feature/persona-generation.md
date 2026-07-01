---
type: feature
title: "Persona 動的生成 (投稿者シグナル → 人格)"
description: "投稿者の活動シグナル (ツール使用・ファイル種別・チャット発言) を収集し、Claude CLI を用いて人格を動的生成してセッションに割り当てる機能。固定 seed 割り当てと並走する追加経路として設計され、`POST /v1/personas/generate` エンドポイントと SQLite への冪等 upsert (SCHEMA_VERSION 19) で構成される。"
service: concordia
domain: session-coordination
tags:
  - persona
  - llm
  - typescript
  - sqlite
  - claude
  - hono
  - rest-api
  - lifecycle
  - state-machine
status: planned
updated: 2026-06-30
---


# Persona 動的生成 (投稿者シグナル → 人格)

## 目的

従来の persona は `seeds.ts` の固定 10 体からランダム / 履歴で割り当てるだけだった。
本機能は **投稿者 (= AI 作業セッション、 ひいてはそれを操作している人間) の活動シグナルを
収集し、 その働き方を反映した人格を 1 体動的に生成して割り当てる** 経路を追加する。

> 関連メモリ: 既存の seed 割り当て・session-end 学習 (`personas/feedback.ts`) は維持。
> 本機能はそれを置き換えず、 「後から API で人格を作り直す」 導線として並走する。

## 全体像 (3 モジュール + 1 メソッド + 1 エンドポイント)

| 役割 | 場所 |
|------|------|
| シグナル収集 | `src/personas/signals.ts` — `collectSignals(deps, session, events)` |
| 人格合成 (LLM + heuristic) | `src/personas/generate.ts` — `generatePersonaDraft(signals)` |
| skill_template 描画 (seed と共通) | `src/personas/skill-template.ts` — `buildSkillTemplate(p)` |
| DB upsert + 排他 assign | `src/db/personas-repo.ts` — `createGenerated(draft, session_id)` |
| API | `POST /v1/personas/generate` (`src/api/personas.ts`) |

### データフロー

```
POST /v1/personas/generate { session_id }
  → sessions.findSession + recentEvents(200)
  → collectSignals()  ── chat / events / session メタ → PersonaSignals
  → generatePersonaDraft()  ── claude CLI (fallback: heuristic) → PersonaDraft
  → personas.createGenerated()  ── personas に upsert (generated=1) + 排他 assign
  → session.metadata.role_label/persona_id 反映 + persona.assigned emit + feedback log
  → { persona, reused, signals }
```

## 収集するシグナル (PersonaSignals)

- `role_label`: `role/predict.ts` の rule ベース推定 (合成のたたき台)
- `repo_base` / `branch` / `provider` / `current_task`
- `prompt_count` / `edit_count` / `dominant_tools` (上位5) / `file_focus` (test/infra/spec/src)
- `voices`: そのセッションの chat に出た発言者名 (system 除く)
- `chat_samples`: 直近 chat 抜粋 (時系列昇順, 最大 20)

PII は持たない (AIFormat §5)。 platform handle / 本名等は収集対象外、 chat の author_label の表示名のみ。

## 生成 (generate.ts)

- 主経路: claude CLI に signals を渡し `{name, display_name, description, traits[], speech_style}` を 1 体生成
- fallback: `CONCORDIA_DISABLE_CLAUDE=1` または claude 失敗 / 出力 unparseable 時は
  signals だけから heuristic 生成 (常に有効な draft を返す = fail-safe)
- `skill_template` は seed と同じ `buildSkillTemplate` で描画 (二重管理しない)

## 永続化 / 割り当ての方針

- `personas` に 2 カラム追加: `generated INTEGER DEFAULT 0` / `origin_session_id TEXT`
  - 冪等 ALTER (`schema.ts` COLUMN_ADDITIONS)、 `SCHEMA_VERSION` 18 → 19
- 生成人格の id は `gen-<session_id>` で **セッションに対し安定**
  → 再生成は同じ行を更新するだけで人格が増えない (膨張防止)
- `assign()` のランダム自由枠から `generated=1` を除外
  → 生成人格は他セッションに配られない。 出自セッションへの復帰は既存の履歴優先ロジックが担う
- `createGenerated` は persona upsert と assignment 切替を 1 transaction で原子的に実行
  (既存 seed/別生成 assignment は release してから生成人格へ)

## まだやっていない (将来)

- session 開始時の自動生成 (今は明示 API 呼び出しのみ。 起動時 seed 割り当ては従来通り)
- 生成人格の retention / GC (origin セッション ended 後の掃除)
- Web UI からの生成ボタン / 生成人格バッジ表示 (API は `generated` フラグを返す)
