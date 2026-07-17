---
task: remove-persona
project: Concordia
kind: 実装
status: done
created: 2026-07-17T00:00:00.000Z
source_session: lictor-340dbfff-25a8-4bd0-9a66-8ba0a0ceb69e
memoria_task_id: 539
actio_task_id: null
memory_links: []
---
# Persona 系実装の全撤去

## 目的
neco 指示 (2026-07-17): Persona の Inject が機能していないため、この機構を捨てる。
Concordia の実装から Persona 系の実装 (生成・割り当て・注入・表示・API・DB DDL) を全て取り外す。

## 完了条件
- src/personas/、src/db/personas-repo.*、src/api/personas.ts、web/src/pages/Personas.tsx、
  tests/persona-inject-optin.test.ts、tests/blackbox-chat.test.ts、persona 専用 spec 2 件が削除されている
- schema.ts から personas / persona_assignments / persona_feedback_log の DDL とマイグレーション 3 件が消えている
  (既存 DB の孤児テーブルは放置。テーブル drop はしない)
- pr_records.persona_id / persona_name カラムは残し、書き込みは null 固定
- roleLabel (role_label) は別概念として維持
- persona.* イベント、persona-inject admin API、chat/render.ts の PersonaVoice/renderChat、
  delegation の persona 選択、discord/slack の persona 表示が除去されている
- `npx tsc -p tsconfig.json --noEmit` 緑 + `npx vitest run` 全緑 + web 型チェック緑

## スコープ (編集可ディレクトリ)
- src/ web/ tests/ tools/ spec/
