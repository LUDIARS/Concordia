---
type: feature
title: 人格注入 / cc_workflow 注入の opt-in 化
description: セッション開始時に常時 ON だった persona 注入 (#96) と cc_workflow 手続きガイダンス注入 (#276) を、独立した 2 フラグで既定 OFF (opt-in) にする。
service: concordia
domain: persona
tags: [persona, collaboration-context, admin-state, opt-in]
status: draft
related:
  - src/api/sessions/lifecycle.ts
  - src/control/collaboration-context.ts
  - src/admin/state.ts
  - tools/concordia-hook.mjs
updated: 2026-07-06
---

# 人格注入 / cc_workflow 注入の opt-in 化

## 目的 / 背景

Concordia 経由で起動した各セッションには、session-start で 2 系統の内容が **常時 ON** で注入されている。これらを「使いたい人だけ有効化する」opt-in (既定 OFF) にする。

1. **persona 注入 (#96)** — 「誰として振る舞うか」(人格・口調)。`personas.assign()` で排他割当し、hook が `[concordia/persona]` ブロックを stdout 出力。delegation spawn では persona-context が prompt 冒頭に前置き。
2. **cc_workflow 注入 (#276)** — 「どう作業を進めるか」(todo 分割 / task branch / PR / CI 監視の手続きガイダンス)。`buildCollaborationContextPacket` が `cc_workflow` を無条件生成し、hook が `formatCcWorkflow()` で stdout 出力。

両者は**内容もコードパスも独立**なので、**独立した 2 フラグ**にする(片方だけ有効化できる)。

## 現状 (常時 ON の実装位置)

- persona assign: `src/api/sessions/lifecycle.ts:101` `deps.personas.assign(input.id)` (無条件)。レスポンス `persona` 同梱: `lifecycle.ts:149`。hook 出力: `tools/concordia-hook.mjs:188-196`。delegation 経路: `src/delegation/persona-context.ts`。
- cc_workflow: `src/control/collaboration-context.ts:131` `cc_workflow: buildCcWorkflow(session.id)` (無条件)。本体: `collaboration-context.ts:136-160`。hook 出力: `tools/concordia-hook.mjs:168-170, 223-238`。パケット構築呼び出し: `lifecycle.ts:118` と `lifecycle.ts:176` (`GET /:id/context`)。

いずれも env フラグも admin state も無い。hook 側の抑制は共通 `QUIET_STDOUT` のみ。

## 手本パターン (reactionWorkflowEnabled)

「env 既定 → AdminState (DB `schema_meta`) → API トグル」の三段構え。同型で実装する。
- env: `src/bootstrap/core.ts:280` `reactionWorkflowEnabled: process.env.CONCORDIA_REACTION_WORKFLOW === "1"`。
- AdminState: `src/admin/state.ts` の `KEY_REACTION_WORKFLOW` / `getReactionWorkflowEnabled()` / `setReactionWorkflowEnabled()` (既定 false、`getBool(key, defaults.reactionWorkflowEnabled ?? false)`)。snapshot 露出: `state.ts:229,241`。
- 消費側: `resolveReactionWorkflowEnabled ?? (() => ...)` を deps 注入。

## 実装スコープ

### 1. フラグ定義 (既定 OFF)

2 つの独立 bool を追加する。env 名 / AdminState キーは reactionWorkflow に倣う。

| 概念 | env (=="1" で有効) | AdminState getter/setter | schema_meta key | 既定 |
|---|---|---|---|---|
| persona 注入 | `CONCORDIA_PERSONA_INJECT` | `getPersonaInjectEnabled()` / `setPersonaInjectEnabled(b)` | `admin.persona_inject_enabled` | **false** |
| cc_workflow 注入 | `CONCORDIA_CC_WORKFLOW` | `getCcWorkflowEnabled()` / `setCcWorkflowEnabled(b)` | `admin.cc_workflow_enabled` | **false** |

- `src/bootstrap/core.ts` の `AdminState` defaults に `personaInjectEnabled` / `ccWorkflowEnabled` を渡す(env から読む)。`src/chat-worker.ts` は削除済みなので対象外。`cost-worker.ts` は AdminState を持たない場合は不要。
- `src/admin/state.ts`: defaults 型・KEY 定数・getter/setter・snapshot フィールドを追加(reactionWorkflow と同じ構造)。

### 2. persona 注入のゲート

- `lifecycle.ts:101` の `deps.personas.assign(input.id)` を、persona フラグが有効なときだけ実行する。無効なら `assignment = null` とし、`persona.assigned` イベント・metadata 反映・レスポンス `persona` 同梱 (`:149-150`) をスキップ(既存の `assignment ? ... : null` 分岐がそのまま流用できる)。
- deps にフラグ解決関数を渡す(例 `resolvePersonaInjectEnabled?: () => boolean`)。lifecycle の deps 構築箇所 (`src/api/register-*` / `bootstrap/core.ts`) で `() => adminState.getPersonaInjectEnabled()` を注入。
- delegation 経路 `src/delegation/persona-context.ts` は「外注先セッションの作法前置き」なので **本 opt-in の対象外**(delegation は明示的に persona を渡す設計)。ただし persona フラグ OFF 時に delegation の暫定 persona 全文前置きも抑止すべきかは要検討 → **今回は delegation 経路は変更しない**(スコープ外、spec に明記)。

### 3. cc_workflow 注入のゲート

- `buildCollaborationContextPacket` に `ccWorkflowEnabled: boolean`(または解決関数)を渡す。無効なら packet の `cc_workflow` を `null` にする。
- `CollaborationContextPacket["cc_workflow"]` の型を `... | null` に緩める(既に optional でなければ)。
- 呼び出し 2 箇所 (`lifecycle.ts:118`, `lifecycle.ts:176`) で `ccWorkflowEnabled: deps.resolveCcWorkflowEnabled?.() ?? false` を渡す。
- hook 側 `tools/concordia-hook.mjs:168-170` は `res.context_packet.cc_workflow` が falsy なら出力しない実装にする(既にそうなら変更不要 / null ガードを確認)。

### 4. hook (`tools/concordia-hook.mjs`)

サーバが `persona` / `cc_workflow` を省略(null)すれば hook は何も出さない、という **サーバ側ゲートで完結**させる。hook は null ガードのみ確認・補強(persona ブロック `:188-196` / cc_workflow `:168-170`)。hook に新フラグを増やさない。

### 5. API 露出 (admin snapshot + トグル)

- admin snapshot (reactionWorkflow と同じ場所) に `persona_inject_enabled` / `cc_workflow_enabled` を追加。
- トグル API: reactionWorkflow のトグル endpoint に倣って設定変更経路を追加(既存 admin 設定 route に 2 フィールド追加が最小)。Web UI (`web/src/pages/Settings.tsx` 等) にトグルを足すのは任意(最低限 API で切替可能にする)。

### 6. テスト

- `readPersonaInject`/`readCcWorkflow` 相当の env パース(既定 false、"1" で true)。
- AdminState: set→get 往復、既定 false、snapshot 反映。
- lifecycle: persona フラグ OFF で `assign` が呼ばれず response.persona=null / `persona.assigned` 未 emit。ON で従来どおり。
- collaboration-context: ccWorkflow OFF で packet.cc_workflow===null、ON で従来構造。
- 既存テストで cc_workflow / persona が常時前提のものは、フラグ ON を明示するよう更新。

### 7. spec-index

`npm run build:spec-index` を実行し `spec-index.jsonl` を更新。

## 受け入れ条件

- [ ] 既定(env 未設定・DB 未設定)で persona も cc_workflow も **注入されない**(session-start レスポンスに persona=null / cc_workflow=null)。
- [ ] `CONCORDIA_PERSONA_INJECT=1` または AdminState トグルで persona 注入が復活、cc_workflow は独立して OFF のまま。
- [ ] `CONCORDIA_CC_WORKFLOW=1` で cc_workflow 注入が復活、persona は独立。
- [ ] hook はサーバが省いた項目を出力しない。
- [ ] `npm run lint` (tsc x2 + depcruise) と `npm test` が緑。
- [ ] 1 PR (可能なら 1 commit) で squash mergeable。

## スコープ外

- delegation spawn の persona 前置き (`persona-context.ts`) の挙動変更。
- persona 生成ロジック (#96 の signals→heuristic) 自体。
- cc_workflow の PR CI followup pending task 注入 (`src/pr/reconcile.ts:enqueueCiFollowup`) — これは task 管理系で別扱い。今回は触らない。
