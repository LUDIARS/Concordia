---
type: plan
title: "3軸分離リファクタリング計画 — 策定セッションログ"
description: "refactor-3axis-architecture.md を策定した AI セッション (2026-07-02) の作業ログ。コードベース調査の手順 (並列 3 系統の構造調査 + git 履歴分析)、各調査で得られた事実 (コンポジションルートの実態・チャット層の結合・cost 系のパイプラインと循環依存)、計画に反映した判断とその根拠を記録する。計画本文の背景資料。"
service: concordia
domain: architecture
tags:
  - refactoring
  - architecture
  - investigation
  - session-log
status: implemented
related:
  - refactor-3axis-architecture.md
updated: 2026-07-02
---

# 3軸分離リファクタリング計画 — 策定セッションログ

- 日時: 2026-07-02
- 依頼: 「サービスが大きくなり God Class もありそうで不安定。 AI協働サポート /
  Discord・Slack連携+RWF / コストリポーターは別軸の機能。 この観点で
  Cc 安定化と運用継続のためのリファクタリングプランを作る」
- 成果物: [`refactor-3axis-architecture.md`](refactor-3axis-architecture.md) (PR #265)

---

## 1. 調査の進め方

1. リポジトリ全体の規模・ファイルサイズ計測 (`src` 42k 行、 上位: `api/sessions.ts`
   1438 / `db/schema.ts` 1102 / `platform/reaction-workflow.ts` 1073 /
   `slack/bot.ts` 1022 / `app.ts` 926 / `discord/bot.ts` 824 / `server.ts` 806)
2. git 履歴から不安定化の証跡を収集 (§2)
3. 並列 3 系統の構造調査 (§3〜§5):
   - (i) コンポジションルートと軸間結合 (`server.ts` / `app.ts` /
     `api/sessions.ts` / `db/schema.ts` / `events.ts` / `dispatcher.ts`)
   - (ii) チャット連携層 (`discord/` / `slack/` / `platform/` RWF)
   - (iii) AI協働コア + コスト系 (`harness/` / `delegation/` / `subsidiary/` /
     `providers/` / `testing/` / `control/` / `cost/`)
4. 調査結果を統合し、 結合違反 14 件 (V1〜V14) のインベントリと Phase 0〜4 の
   段階計画に落とし込み

## 2. git 履歴に見る不安定化の証跡

| コミット | 内容 | 示唆 |
|---|---|---|
| #255 | perf(cost): 窓集計 reader を memo 化しイベントループ長時間ブロックを解消 | cost 走査がコアを止める |
| #257 | perf(cost): channel-cost reader を tail/増分読み化し残り 16 秒を解消 | 同上 (対症の連鎖) |
| #259 | fix(restart): supervisor 二重化による EADDRINUSE クラッシュループを根治 | 単一プロセスゆえ再起動の影響半径が全機能 |
| #263 | fix: Cc 安定化バッチ — cost 性能根治 / spawn 安定化 / テスト交通整備 | 安定化対応が多軸に同時飛散 |

→ 「協働が本質でない cost がコアと同一プロセスに同居している」ことが
構造的原因である、 という計画 §1 の診断の根拠。

## 3. 調査 (i): コンポジションルートと軸間結合

- `server.ts` が実質のコンポジションルート: 約 30 repo の生成、 cost sampler
  timer 群、 sweeper/reaper/metrics/compaction/daily/stat/PR sync の全スケジューラ、
  Discord/Slack/subsidiary bot 起動、 `buildApp` への約 40 依存の受け渡しまでを
  1 ファイルで実施。
- `app.ts` は 3 軸のルーターを 1 つの `AppDeps` で混載。 cost router が
  `discordChannels` repo を受け取る (C→B 結合)。
- `api/sessions.ts` (1438 行) はセッションライフサイクルに加え、
  permission/question・transcript/inject リレー・title/goal・compaction まで同居。
  Discord repo 3 種を必須依存とし (`:22-27`)、 `discord:`/`slack:` source
  プレフィクスをハードコード (`:1019-1022`)。
- `events.ts` の `ConcordiaEvent` union は全軸混載のまま、 `discord-worker.ts`
  の WS ブリッジ経由で **cross-process wire 契約** 化している。
- 既存の分離の芽: `discord-worker.ts` (relay-owner lease で embedded との
  二重リレー防止) と、 observability の Excubitor への切り出し前例。
  ただし worker は repo 群を自前配線する「第二のコンポジションルート」。

## 4. 調査 (ii): チャット連携層 + RWF

- `platform/chat-platform.ts` は名目インターフェース: `stop()` 以外の共有面が
  無く、 準拠しているのは Slack のみ (Discord は独自 handle を返す)。
- 両 bot が `runClaude` (LLM ランナー) を直 import、 Discord bot は
  `control/repin-session` も直 import。 repo 直読み +
  `session.metadata` / event `payload` の inline JSON parse が広範囲に存在。
- ダッシュボード (monitor / cost-channel / pr-queue / status-card) の業務集計が
  chat 層内で行われている。
- `slack/render.ts` `slack/bot.ts` が `discord/egress-filters.ts`
  `discord/formatter.ts` を import (実体は platform 中立なのに置き場が discord/)。
- **RWF (`reaction-workflow.ts`) は例外的にクリーン**: `runHeadless` /
  `emitInject` 等を全て deps 注入で受け、 discord.js / core を一切 import しない。
  → 計画で「port 注入の標準形」として採用した根拠。
  懸念は絵文字→prompt 表に埋まった絶対パス・他サービス URL のハードコードのみ。

## 5. 調査 (iii): AI協働コア + コスト系

- 軸A の各サブ機能は概ね綺麗に分離済み: harness (predicates→session-gate の
  純関数層 + LLM advisory 層)、 providers (`AgentProvider` レジストリ)、
  delegation、 subsidiary (guard は fail-closed)、 testing (branch-watch →
  eventBus inject)。 コアで見つかった違反は
  `subsidiary/manager.ts` → `discord/bot.ts` 直 import と、
  `RunClaudeFn` 型が `subsidiary/guard.ts` 住まいで harness 一式が逆参照する
  ねじれの 2 点。
- cost 系は 3 レーン (JSONL 直読み / 予算 sampler / 外部 cost-feed)。
  **cost↔subsidiary の循環依存を確認**
  (`cost/org-cost.ts:17` ⇄ `subsidiary/budget.ts:17-18`)。
- テスト空白: `providers/` 0 本、 `testing/` 0 本、 `delegation/` 1 本のみ。
  cost (16/20) / harness (5/5) / subsidiary (6/7) は厚い。
  → Phase 0 の先行テスト補充対象の根拠。
- 運用形態: 単一 Node プロセス + 任意の discord-worker + stdio MCP 群。
  PM2 / systemd 等の supervisor 定義はリポジトリに無い。

## 6. 計画に反映した主な判断

| 判断 | 根拠 |
|---|---|
| 依存規則を dependency-cruiser で CI 強制 (Phase 0) | 違反 14 件が目視レビューをすり抜けて蓄積した実績 |
| port 注入を標準形に | RWF が既に模範実装として存在し、 テストも I/O フリーで書けている |
| cost をプロセス分離 (cost-worker) | #255/#257 のイベントループブロックは memo 化では再発しうる。 プロセス境界なら構造的に不可能 |
| chat-worker は新造でなく discord-worker の昇格 | lease による二重リレー防止が実運用済み。 Slack 収容と bootstrap 共用のみ追加 |
| ディレクトリ再編は最後 (Phase 4)・workspaces 化はしない | 移動 diff が Phase 1-3 のレビューを壊す。 #261 (junction 問題) の再来回避 |
| HTTP ルート・hook 契約は全フェーズ不変 | hook / MCP / web が URL 直叩きしており、 変更すると全エージェント環境に波及 |

## 7. 成果と後続

- `spec/plan/refactor-3axis-architecture.md` 新設、 `spec/README.md` に
  `plan/` を追記、 `spec-index.jsonl` 再生成 (37 entries)。
- PR #265 として提出、 CI (run #425) green を確認。
- 後続の最初の着手候補は Phase 0 (dependency-cruiser 導入 + providers/testing
  のテスト補充 + event-loop lag 計測)。
