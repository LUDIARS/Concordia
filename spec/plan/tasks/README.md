---
type: plan
title: "3軸分離リファクタリング — 実装タスク指示書 (索引・共通ルール)"
description: "refactor-3axis-architecture.md を実装するための AI エージェント (Codex) 向けタスク指示書の索引。タスクの粒度 (1タスク=1PR)、全タスク共通の不変条件 (HTTP ルート不変・hook 契約不変・vitest/tsc green)、着手順序と依存関係、検証コマンド、コミット規約を定義する。各 Phase の詳細は phase-0.md〜phase-4.md。"
service: concordia
domain: architecture
tags:
  - refactoring
  - task-instructions
  - codex
  - process
status: planned
related:
  - ../refactor-3axis-architecture.md
  - phase-0.md
  - phase-1.md
  - phase-2.md
  - phase-3.md
  - phase-4.md
updated: 2026-07-02
---

# 3軸分離リファクタリング — 実装タスク指示書

実装者: Codex (AI コーディングエージェント)。
計画正本: [`../refactor-3axis-architecture.md`](../refactor-3axis-architecture.md)
(以下「計画」。 §番号は計画本文を指す)。

## タスク一覧と着手順序

| ID | タスク | 依存 | 規模 |
|---|---|---|---|
| [T0-1](phase-0.md#t0-1) | dependency-cruiser 導入 + 既存違反の許容リスト化 | なし | S |
| [T0-2](phase-0.md#t0-2) | `providers/` ユニットテスト追加 | なし | M |
| [T0-3](phase-0.md#t0-3) | `testing/` ユニットテスト追加 | なし | S |
| [T0-4](phase-0.md#t0-4) | `delegation/` テスト補充 | なし | S |
| [T0-5](phase-0.md#t0-5) | event-loop lag サンプラー追加 | なし | S |
| [T1-1](phase-1.md#t1-1) | V1: cost↔subsidiary 循環依存の解消 | T0-1 | S |
| [T1-2](phase-1.md#t1-2) | V2: `RunClaudeFn` 型の移設 | T0-1 | S |
| [T1-3](phase-1.md#t1-3) | V3: formatter / egress-filters を `platform/` へ | T0-1 | S |
| [T1-4](phase-1.md#t1-4) | V4: `BotStarter` port 導入 | T0-1 | S |
| [T1-5](phase-1.md#t1-5) | V7/V8: 両 bot の `runClaude` / `repin` 注入化 | T0-1 | M |
| [T1-6](phase-1.md#t1-6) | V10: cost router の Discord repo 依存除去 | T0-1 | S |
| [T1-7](phase-1.md#t1-7) | V14: sweeper → dispatcher 直呼びの eventBus 化 | T0-1 | S |
| [T2-1](phase-2.md#t2-1) | `api/sessions.ts` サブルーター分割 (V5/V6 含む) | T1-* | L |
| [T2-2](phase-2.md#t2-2) | `server.ts` → 軸別 bootstrap 分割 | T1-* | L |
| [T2-3](phase-2.md#t2-3) | `app.ts` → 軸別 route 登録分割 | T2-2 | M |
| [T2-4](phase-2.md#t2-4) | `ChatPlatform` 実インターフェース化 (V9/V11/V13) | T2-2 | L |
| [T3-1](phase-3.md#t3-1) | cost-worker プロセス分離 | T2-2 | M |
| [T3-2](phase-3.md#t3-2) | chat-worker 昇格 (discord-worker + Slack 収容) | T2-2, T2-4 | L |
| [T3-3](phase-3.md#t3-3) | event 契約の名前空間分割とバージョン付け (V12) | T3-1, T3-2 | M |
| [T4-1](phase-4.md#t4-1) | `src/core|chat|cost` ディレクトリ再編 | T3-* 完了後 | L |

- Phase 0 の 5 タスクは相互に独立 — 並行着手可。
- Phase 1 の 7 タスクも相互に独立 — 並行着手可 (T0-1 完了後)。
- Phase 2 以降は表の依存に従う。 T2-1 と T2-2 は並行可だが、
  どちらも Phase 1 全完了後に始めること (diff 衝突回避)。

## 全タスク共通の不変条件 (違反したら PR を出さない)

1. **HTTP ルート URL・リクエスト/レスポンス形状を変えない。**
   hook (`.claude/hooks/*.mjs`)・MCP サーバ・web frontend が URL を直叩きしている。
   確認: `tests/` の API テストが無修正で green であること。
2. **hook 契約 (SessionStart / UserPromptSubmit / Stop 等の入出力) を変えない。**
3. **`npm test` (vitest) と `npm run lint` (tsc ×2) が green。**
   既存テストの修正は「import パス追随」のみ許可。 assert の書き換えで
   green にすることは禁止 (挙動が変わった証拠なので設計に戻る)。
4. **`npm run dev` の開発体験を変えない** (単一コマンドで backend+web が起動)。
5. **機械的移動とロジック変更を同一コミットに混ぜない。**
   移動 (ファイル/型/関数の引越し) → 別コミット → ロジック変更、 の順に積む。
6. **lock 機構を導入しない** (README 設計指針)。
7. DB スキーマ変更が必要になったら **作業を止めて人間に確認** (本計画の範囲では
   スキーマ変更は想定していない)。

## 検証コマンド

```bash
npm run lint          # tsc --noEmit (app + test)
npm test              # vitest run
npm run depcruise     # T0-1 で追加。軸間依存の境界チェック
npm run build         # Phase 2 以降のタスクでは必ず実行 (dist 生成確認)
```

環境準備: `git submodule update --init` → `lib/vestigium` 内で `npm install`
→ ルートで `npm install` (better-sqlite3 のネイティブビルドに失敗する環境では
`--ignore-scripts` で入れると vitest の一部 DB テストが落ちる。 その場合は
ビルドツールチェーン (python3 / make / g++) を先に入れること)。

## ブランチ・コミット・PR 規約

- ブランチ: `refactor/<task-id>-<slug>` (例: `refactor/t1-1-cost-subsidiary-cycle`)
- コミット: Conventional Commits。 refactor 系は `refactor(scope): ...`、
  テスト追加は `test(scope): ...`、 基盤導入は `build:` / `chore:`。
  本文に計画の参照 (`spec/plan/refactor-3axis-architecture.md §N` / `V番号`) を含める。
- PR: 1 タスク = 1 PR。 PR 本文に (a) 対応タスク ID、 (b) 受け入れ条件の
  チェックリスト、 (c) 検証コマンドの実行結果を記載。
- タスクの受け入れ条件を満たせない・指示書と実コードが食い違う場合は、
  **勝手に解釈を広げず** PR を draft にして食い違いを本文に明記する。

## 指示書の読み方

各タスクカードは以下の構成:

- **目的** — なぜやるか (計画との対応)
- **対象** — 触るファイル (調査時点の file:line。 ずれていたら周辺を検索)
- **手順** — 実装ステップ
- **受け入れ条件** — PR マージの判定基準 (機械的に検証可能な形)
- **やらないこと** — スコープ外 (やると差し戻し)

> file:line は 2026-07-02 時点 (main = f491e80) のスナップショット。
> 行番号のずれは許容し、 シンボル名で特定すること。
