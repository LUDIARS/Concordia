---
task: fix-codex-transcript-scan-block
project: Concordia
kind: 実装
status: done
created: 2026-07-16T00:00:00.000Z
source_session: lictor-340dbfff-25a8-4bd0-9a66-8ba0a0ceb69e
memoria_task_id: 526
pr_number: 348
actio_task_id: null
memory_links: []
---
# findCodexTranscript の同期全量スキャンを排除する

## 目的

10 分周期 (実測: 起動 +10min×k、20〜110 秒/回) でイベントループが完全停止し、
/health・/v1/harness/gate を含む全 API が無応答になる問題の根治。

計測根拠 (2026-07-16):
- host_metrics event-loop lag max 20〜110s がほぼ 10 分周期 (162/1859 サンプル)。
- Excubitor 死活: 24h で 163 incidents / 累計 3.8h ダウン (uptime 84%)。
- CPU プロファイル (pid 2980, tick 跨ぎ 110s): self-time 上位が
  readFileSync 35.2s + readFileUtf8 34.9s + transcriptHasSessionId 15.4s。
- 直近 15s プロファイルでは同 3 関数が 89% — lost な codex セッションの
  transcript 解決失敗が sweeper (60s) / stall-nudge (10min) で毎回再スキャンを誘発。
- `~/.codex/sessions` 実測: 8,553 JSONL / 1.48 GB。

原因: `src/providers/codex-cli.ts` `findCodexTranscript` が
① ツリー全 walk ② 各ファイルを **readFileSync で全量読み** (先頭 20 行しか使わない)
③ 結果を一切キャッシュしない (見つからない session id は毎回 1.48GB 再読)。

## 完了条件

- transcriptHasSessionId が先頭チャンク (8〜64KB) のみ読む (全量読み禁止)。
- sessionId→path の正キャッシュ (existsSync で失効検証) と、
  見つからなかった sessionId の負キャッシュ (TTL 付き) を持つ。
- walk が新しい日付ディレクトリ優先 (YYYY/MM/DD 降順) で早期 return する。
- 既存テスト (providers) が緑 + 新規ユニットテストで
  「全量読みしない」「負キャッシュが効く」を検証。

## スコープ (編集可ディレクトリ)

- src/providers/ (codex-cli.ts とそのテスト)

## 実装状況 (2026-07-19 追記)

PR #348 (`fix: リクエスト詰まり根治 — codex transcript 全量スキャン排除 + 同期 taskkill/cost lease 是正`)
で完了条件を全て満たして main にマージ済み (`src/providers/codex-cli.ts`):
先頭 64KB head 読み (`HEAD_READ_BYTES` / `transcriptHeadHasSessionId`)、
sessionId→path 正キャッシュ (`foundPathCache`, existsSync 失効検証)、
負キャッシュ (`missCache`, TTL は id 538 で指数バックオフ化済み)、
日付ディレクトリ降順 walk + 早期 return、`src/providers/codex-cli.test.ts` 新規テスト追加。
Memoria task id 526/527/528/538 の統合対応 (本 md 群) の一環として 2026-07-19 に再検証:
`npx tsc --noEmit` (両 tsconfig) / `npx vitest run` (240 files / 1681 tests) /
`npx depcruise` / `npm run build` すべて green。status を pending → done に更新。
