---
task: inject-manuals
project: Concordia
kind: 実装
status: pending
created: 2026-07-17T00:00:00.000Z
source_session: lictor-340dbfff-25a8-4bd0-9a66-8ba0a0ceb69e
memoria_task_id: 543
actio_task_id: null
memory_links: []
---
# kind 別 Inject マニュアル (WebUI 調整可) + ルート切替不問のハーネス文言

## 目的

neco 指示 (2026-07-17): 設計/レビュー/実装/テストで Inject の中身を変えたい。
kind ごとに Inject パラメータ (= 「マニュアル」) を別に持ち、WebUI で調整できるようにする。
例: レビューや設計では worktree 生成やブランチ切替は不要なので消す。
レビューは main 最新やブランチ/worktree 指定で動く。

あわせて「ルートフォルダのブランチ切り替えはチェックしない」旨のハーネス文言修正を同梱する。

## 完了条件

- 新テーブル `inject_manuals` (kind PK / content / updated_at) が schema に追加される
- `src/db/inject-manuals-repo.ts` に list / get / upsert が実装される
  (kind 語彙 = 設計相談 | 実装 | レビュー | テスト | 雑用)
- boot 時に既定マニュアルを冪等 seed する (既存行の content は上書きしない —
  ユーザ編集尊重、harness-seed.ts と同パターン)
- API: GET /v1/admin/inject-manuals、PUT /v1/admin/inject-manuals/:kind
  (未知 kind は 400、content 32KB 上限)
- delegation invoke 経路でテンプレから kind を解決し (`resolveManualKind`、純関数)、
  該当マニュアルを `buildDelegationContext` の協調コンテキスト先頭付近に
  「## 作業マニュアル (kind: …)」節として差し込む
- WebUI: `web/src/pages/Manuals.tsx` (kind ごと textarea + 保存)、ナビに「マニュアル」追加、
  `web/src/api.ts` に injectManualsList / injectManualUpdate 追加
- ハーネス文言: harness-seed.ts の「作業ブランチ + worktree 必須」builtin に
  「ルートフォルダのブランチ切り替え自体は判定対象にしない」旨を追記、
  spec/feature/task-workflow.md §1.1 にも同趣旨の注記を 1 行追加
- テスト: repo ユニット / API (GET/PUT/400) / resolveManualKind / persona-context 差し込み
- 検証: tsc --noEmit + vitest 全件 + web 型チェック すべて緑

## スコープ (編集可ディレクトリ)

- src/db/ (schema.ts, inject-manuals-repo.ts)
- src/control/ (inject-manual-seed.ts)
- src/api/ (inject-manuals.ts + mount 箇所)
- src/bootstrap/core.ts
- src/delegation/ (persona-context.ts, service.ts)
- src/subsidiary/harness-seed.ts
- web/src/ (pages/Manuals.tsx, App.tsx, api.ts)
- spec/feature/task-workflow.md
- tests/
