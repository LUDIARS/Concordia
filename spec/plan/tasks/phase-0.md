---
type: plan
title: "Phase 0 タスク指示書 — 安全網 (依存境界 lint / テスト補充 / lag 計測)"
description: "3軸分離リファクタリングの Phase 0 実装指示。dependency-cruiser の導入と既存違反 14 件の許容リスト化、テスト空白モジュール (providers / testing / delegation) へのユニットテスト先行追加、event-loop lag サンプラーの追加。全タスク挙動変更なし・相互独立で並行着手可。"
service: concordia
domain: architecture
tags:
  - refactoring
  - task-instructions
  - testing
  - lint
  - metrics
status: planned
related:
  - README.md
  - ../refactor-3axis-architecture.md
updated: 2026-07-02
---

# Phase 0 タスク指示書 — 安全網

共通ルールは [README.md](README.md) を先に読むこと。
**Phase 0 は全タスク挙動変更なし**。 プロダクションコードの動きが変わったら失敗。

---

## T0-1: dependency-cruiser 導入 + 既存違反の許容リスト化 {#t0-1}

### 目的
軸間 import (計画 §4.1 の依存規則) を CI で機械的に強制する。 以後の全タスクの
「違反を 1 つ消したら許容リストから 1 行削る」ratchet の土台 (計画 §5 Phase 0)。

### 対象
- 新規: `.dependency-cruiser.cjs`, `package.json` (devDependencies + scripts)
- CI: `.github/workflows/ci.yml` に step 追加

### 手順
1. `npm i -D dependency-cruiser` を追加。
2. `.dependency-cruiser.cjs` に以下のルールを定義する
   (module 群の定義は path 正規表現で行う):
   - `core-no-chat`: `src/{api,control,db,delegation,harness,providers,subsidiary,testing,pr,work,personas,report,rules,mcp,model-catalog}/**` および `src/{sweeper,dispatcher,events}.ts` から `src/{discord,slack}/**` への import を **error**
   - `core-no-cost-write`: 同上 core 群から `src/cost/**` への import を **error** (許容リストで現状の合法参照を除外: `report/generator.ts`, `control/auto-compaction.ts`, `rules/claude-runner.ts`, `subsidiary/budget.ts` — これらは計画 §4.1 で「関数契約として残す」対象)
   - `chat-no-core-runner`: `src/{discord,slack}/**` から `src/rules/claude-runner.ts` と `src/control/**` への import を **error**
   - `cost-no-chat`: `src/cost/**` から `src/{discord,slack}/**` への import を **error**
   - `cost-no-subsidiary`: `src/cost/**` から `src/subsidiary/**` への import を **error**
   - `slack-no-discord`: `src/slack/**` から `src/discord/**` への import を **error**
   - `no-circular`: 循環依存を **error**
   - 例外: `src/server.ts`, `src/app.ts`, `src/discord-worker.ts` (コンポジションルート) は全ルールから除外。 `*.test.ts` も除外。
3. 現状の違反 (計画 §3 の V1〜V14 のうち import レベルのもの) を
   ルールごとの `pathNot` あるいは専用の「known-violations」コメント付き
   例外として列挙する。 **例外 1 件ごとに `// V番号` コメントを付ける**。
4. `package.json` に `"depcruise": "depcruise src --config .dependency-cruiser.cjs"` を追加し、
   `lint` スクリプトの末尾に `&& npm run depcruise` を連結。
5. `.github/workflows/ci.yml` の lint 相当 step で実行されることを確認
   (lint スクリプト経由なら追加作業なし)。

### 受け入れ条件
- [ ] `npm run depcruise` が現状の main で **exit 0** (既存違反は全て許容リスト化)
- [ ] 検証: `src/cost/` 配下の任意ファイルに `import "../discord/bot.js"` を
      一時追加すると exit 非 0 になる (確認後に戻す)
- [ ] 許容リストの各行に V 番号コメントが付いている
- [ ] `npm test` / `npm run lint` green

### やらないこと
- 違反の修正 (Phase 1 の仕事)。 このタスクは検出網の設置のみ。

---

## T0-2: `providers/` ユニットテスト追加 {#t0-2}

### 目的
モデル抽象化層 (計画 §2 軸A) はテスト 0 本。 Phase 2 以降で bootstrap 分割の
影響を受けるため、 現挙動を先に固定する。

### 対象
- 新規: `src/providers/index.test.ts`, `src/providers/claude-code.test.ts`
  (必要なら `codex-cli.test.ts`, `gemini-cli.test.ts`)

### 手順
1. `src/providers/types.ts` の `AgentProvider` インターフェースと
   `index.ts` のレジストリ (`getProvider`) を読む。
2. `index.test.ts`: `getProvider("claude-code" | "gemini-cli" | "codex-cli")` が
   実装を返すこと、 `"local-llm"` / `"unknown"` / 未知文字列が null (degrade)
   になることを検証。
3. `claude-code.test.ts`: transcript パスのエンコード規則
   (cwd → `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`) と、
   JSONL パース (`parseTranscript`) の代表ケース
   (tool_use / assistant response / 壊れた行の skip) を fixture 文字列で検証。
   **実ファイルシステムに依存させない** (パス計算は純関数として、 読み取りは
   fixture 注入 or tmpdir)。
4. テスト配置規約は README §開発規約に従い co-located (`src/**/x.test.ts`)。

### 受け入れ条件
- [ ] `npx vitest run src/providers` が green で、 assert が「現挙動の写し」に
      なっている (実装を変更していない)
- [ ] レジストリの全 provider 種別と null degrade がカバーされている
- [ ] `npm run lint` green (tsconfig.test.json 含む)

### やらないこと
- provider 実装の変更・リファクタ。 テストのみ。

---

## T0-3: `testing/` ユニットテスト追加 {#t0-3}

### 目的
テスト・ブランチ衝突検知 (branch-watch) はコアの安定性通知に直結するが 0 本。

### 対象
- 新規: `src/testing/branch-watch.test.ts`, `src/testing/notify.test.ts`

### 手順
1. `src/testing/branch-watch.ts` を読む: 30 秒ポーリングで session の branch
   変化を検出 → active な testing claim が無い session に通知 inject、
   クールダウン 1 時間。
2. タイマーは `vi.useFakeTimers()`、 repo/eventBus は fake を注入して:
   - branch 変化 → 通知が emit される
   - claim 保持中の session → 通知されない
   - クールダウン内の再変化 → 通知されない
   - branch 不変 → 何も起きない
3. `notify.ts` は `eventBus` の `session.inject` emit 形状 (payload 構造) を検証。

### 受け入れ条件
- [ ] `npx vitest run src/testing` green、 上記 4 分岐 + emit 形状をカバー
- [ ] 実装変更なし・`npm run lint` green

### やらないこと
- ポーリング間隔・クールダウン値の変更。

---

## T0-4: `delegation/` テスト補充 {#t0-4}

### 目的
Delegation は `service.test.ts` 1 本のみ。 T2-2 (bootstrap 分割) と
T3-2 (chat-worker) の両方が `DelegationService` の配線を触るため補強する。

### 対象
- 既存: `src/delegation/service.test.ts` の拡充
- 新規: `src/delegation/portable.test.ts` (import/export があるため)

### 手順
1. `service.ts` の未カバー分岐を `npx vitest run --coverage` 相当で特定
   (coverage ツールが無ければ目視で分岐列挙)。 最低限:
   - `renderTemplate` / `validateArgs` の異常系 (未定義変数・必須欠落)
   - `invoke()` と `invokeDefinition()` の分岐差
     (グローバル template vs subsidiary 所有 copy)
   - persona 文脈注入の有無による prompt 差
2. spawner (`control/spawner.ts`) はモック注入し、 **プロセスを実際に起動しない**。
3. `portable.ts` は export → import の round-trip が同値になることを検証。

### 受け入れ条件
- [ ] `npx vitest run src/delegation` green、 上記分岐カバー
- [ ] 実装変更なし・`npm run lint` green

### やらないこと
- Delegation の仕様変更・template seed の変更。

---

## T0-5: event-loop lag サンプラー追加 {#t0-5}

### 目的
Phase 3 の分離効果 (計画 §7: lag p99 改善) を測る物差しを先に置く。
cost 起因ブロック (#255/#257) の再発検知も兼ねる。

### 対象
- 新規: `src/metrics/event-loop-lag.ts`
- 変更: `src/metrics/loop.ts` または `collector.ts` (既存の収集周期に載せる)、
  `src/db/schema.ts` は**触らない** — 既存 `host_metrics` の JSON ペイロードに
  フィールド追加で収まるならそれを使い、 収まらなければ in-memory リングバッファ
  + `/v1/stat` 系の既存レスポンスへの追加で済ませる。

### 手順
1. Node 標準の `perf_hooks.monitorEventLoopDelay()` を薄く包む
   `EventLoopLagSampler` を作る (`enable/disable/snapshot { mean, p50, p99, max }`)。
2. 既存 metrics ループ (`src/metrics/loop.ts`) の収集タイミングで snapshot →
   既存の格納経路に載せ、 `reset()` する。
3. logger に閾値超過 warn を 1 本 (`p99 > 200ms` で warn、 値は定数)。
4. ユニットテスト: fake の delay histogram を注入して snapshot 形状と
   閾値 warn の発火を検証。

### 受け入れ条件
- [ ] backend 起動でサンプラーが有効化され、 既存の metrics 出力経路に
      lag 値が現れる (手元で `npm run dev:backend` → 確認方法を PR に記載)
- [ ] スキーマ変更なし (`src/db/schema.ts` の diff がない)
- [ ] `npm test` / `npm run lint` green

### やらないこと
- ダッシュボード/web UI への表示追加 (別途)。 収集と警告ログのみ。
