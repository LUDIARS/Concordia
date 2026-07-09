---
type: setup
title: "Augur log injection を Concordia で使うための設定 (log-injection)"
description: "Augur の log injection framework (安定稼働ログの外部注入) の管理対象として Concordia を登録する設定。ルート augur.inject.json が正本。scan で安定化チェックリスト由来の注入候補 (bare catch / 未監視 spawn / 未ガード async listener) を検出し、apply で marker 付き観測コードを挿入、ログは @ludiars/log-weaver 経由で Vg JSONL へ流れ observability の error pipeline に乗る。"
service: concordia
domain: observability
tags:
  - typescript
  - monitoring
  - logging
  - auto-fix
  - codemod
  - stability
status: implemented
related:
  - observability.md
  - ../plan/problems/stability-checklist.md
updated: 2026-07-09
---

# Augur log injection を Concordia で使うための設定 (log-injection)

## 目的

「Cc がよく落ちる」解析 ([stability-checklist](../plan/problems/stability-checklist.md)) で
一般化した停止バグの芽 (bare catch / error リスナー無し spawn / 未ガード async
listener・interval) を、**Augur が外部からスキャン・注入・一括管理**できるようにする。
注入されたログは Vestigium (Vg) JSONL に落ち、observability の file tail → error task →
auto-fix パイプライン ([observability.md](observability.md)) の入力になる。

仕組み自体の正本は Augur 側: `Augur spec/feature/log-injection.md` (設計) /
`Augur spec/interface/inject-cli.md` (CLI)。runtime は Lapilli `@ludiars/log-weaver`。

## 設定の正本: augur.inject.json

リポジトリルートの `augur.inject.json` が管理対象の宣言。

| フィールド | 値 | 理由 |
|-----------|----|------|
| `include` | `src/**/*.ts`, `tools/**/*.mjs` | backend 本体と hook/worker スクリプト |
| `exclude` | tests / `src/testing/**` / `web/**` / `lib/**` | テスト・フロント・vendored パッケージは対象外 |
| `runtime.autoImport` | `false` | Concordia は #298 で自前の安全網 (unhandledRejection / uncaughtException) と Vg install (`src/shared/vestigium.ts`) を持つため、`@ludiars/log-weaver/auto` の entrypoint 注入は不要 |
| `rules` | 全 rule on | scan は候補提示のみ。コメント付き catch (`/* never throw from logging */` 等) は「人間の判断済み」としてスキップされる |

## 手順

Augur checkout から実行する (Concordia 側に依存は要らない):

```bash
cd ../Augur
npm run inject -- scan  --project ../Concordia          # 候補一覧 (read-only)
npm run inject -- check --project ../Concordia --strict # CI 向けドリフト検査
npm run inject -- apply --project ../Concordia          # marker 付き注入 (要 log-weaver 依存)
npm run inject -- remove --project ../Concordia         # 全 fragment 撤去
```

現状 (2026-07-09) の scan は **29 件 pending**: silent-catch 23 / listener-guard 5
(slack/bot.ts の socket listener 群、codex-worker の child.on('close')) / spawn-watch 1
(api/register-core.ts の spawn)。

## apply を実施する場合の前提

1. `@ludiars/log-weaver` を dependencies に追加する (GitHub Packages。lib/ 配下への
   vendor でも可 — memory / blackbox と同じ方式)。
2. 注入ログを既存の Vg writer に合流させるなら、bootstrap で
   `bindSink((e) => vg.writer.write({ ...e }))` を 1 行呼ぶ (`src/shared/vestigium.ts` に
   隣接させるのが自然)。bind しなくてもフォールバックで
   `${VESTIGIUM_LOGS_DIR || cwd/logs}/weaver.jsonl` に落ち、file tail からは見える。
3. 注入 fragment は `/* augur-inject:<rule>:<id> */` marker 付きで機械管理される。
   手で編集しない — 撤去は `remove`、ドリフトは `check` で検出する。

## 運用ルール

- ctx に機微情報を入れない Vg のルールは注入コードにも適用される (fragment が載せるのは
  rule / where / id とエラーメッセージのみ)。
- `check --strict` を CI に足す場合、新しい bare catch 等は「pending が増えた」として
  検出される。意図的に観測不要なら catch にコメントを書けば scan 対象から外れる。
