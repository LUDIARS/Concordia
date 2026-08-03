---
type: plan
title: "Phase 4 タスク指示書 — ディレクトリ再編 (任意・最後)"
description: "3軸分離リファクタリングの Phase 4 実装指示。境界が dependency-cruiser で守られた後にのみ実施する src/core・src/chat・src/cost へのディレクトリ再編。git mv による履歴保持、import 全追随、depcruise ルールのパス更新。npm workspaces 化はしない。"
service: concordia
domain: architecture
tags:
  - refactoring
  - task-instructions
  - directory-structure
status: planned
related:
  - README.md
  - ../refactor-3axis-architecture.md
updated: 2026-07-02
---

# Phase 4 タスク指示書 — ディレクトリ再編 (任意・最後)

**着手条件 (すべて満たすまで開始禁止):**
- Phase 1〜3 の全タスク完了、 depcruise 許容リストが空
- 直近 2 週間に main で安定性起因の hotfix が無いこと (再編 diff は
  hotfix の cherry-pick を難しくするため、 落ち着いてから行う)
- 人間の GO 判断 (このタスクだけは着手前に明示承認を得ること)

---

## T4-1: `src/core|chat|cost` ディレクトリ再編 {#t4-1}

### 目的
lint で守られた論理境界を物理配置に一致させ、 新規コードの置き場所を
自明にする (計画 §5 Phase 4)。

### 対象 (移動マップ)

| 現在 | 移動先 |
|---|---|
| `src/{api,control,db,delegation,harness,providers,subsidiary,testing,pr,work,personas,report,rules,mcp,model-catalog,library,skills,session-logs,daily,stat,morning,metrics,anatomia,auth,admin,processes,triggers,role}` | `src/core/…` |
| `src/{sweeper,dispatcher,events,errors}.ts` | `src/core/…` |
| `src/{discord,slack,platform,chat}`, `src/chat-actionable.ts` | `src/chat/…` (既存 `src/chat/` は `src/chat/responder/` 等へ整理) |
| `src/cost` | `src/cost` (そのまま) |
| `src/shared` | `src/shared` (そのまま) |
| `src/{server,app,chat-worker,cost-worker}.ts`, `src/bootstrap` | ルート直下のまま |

> `daily` / `morning` / `stat` は chat 向け出力を含むが、 スケジューラ本体は
> core 扱いとする (T2-3 で registrar 分割済みのため配置は core で矛盾しない)。
> 迷うモジュールが出たら depcruise のルール定義に従う (ルールが正、
> 配置が従)。

### 手順
1. **1 コミット = 1 トップレベル移動** (`git mv` 必須。 履歴追跡を壊さない)。
   各コミットで import 追随 + `npm run lint` green を維持する
   (bisect 可能な状態を保つ)。
2. `.dependency-cruiser.cjs` のパス正規表現を新配置へ更新 — ルールの
   **意味** は変えない (この時点で許容リストは空のはず)。
3. `tsconfig.json` / `vitest.config.ts` / `package.json` scripts /
   `.github/workflows/*.yml` のパス参照を追随。
4. `tools/sync-skill.mjs`, `tools/build-spec-index.mjs` など tools/ の
   src 参照を確認・追随。
5. hook (`.claude/hooks/*.mjs`) や外部プラグイン (`CONCORDIA_RWF_PLUGIN_PATH`)
   が src パスを直接参照していないか grep で確認 (HTTP 経由なら影響なし)。
6. `spec/` 各文書のコード参照パス (「正本は src/db/schema.ts」等) を更新。

### 受け入れ条件
- [ ] `npm run build` / `npm test` / `npm run lint` / `npm run depcruise` 全 green
- [ ] `git log --follow` で移動ファイルの履歴が追える (代表 3 ファイルで確認)
- [ ] `npm run dev` / `npm run chat:worker` / `npm run cost:worker` 起動確認
- [ ] spec 文書のパス参照更新 (`spec-index.jsonl` は git 管理外の派生物なのでコミットしない)

### やらないこと
- **npm workspaces 化・パッケージ分割はしない** (計画 §5 Phase 4:
  junction 問題 #261 の再来回避、 単一 node_modules の運用簡便性優先)。
- 移動に乗じたファイル内容の変更 (rename 以外の diff を出さない)。
- barrel file (`index.ts` re-export 集約) の新設 — 循環依存の温床になるため。
