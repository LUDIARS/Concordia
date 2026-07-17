---
task: full-async-io
project: Concordia
kind: 実装
status: pending
created: 2026-07-17T00:00:00.000Z
source_session: lictor-340dbfff-25a8-4bd0-9a66-8ba0a0ceb69e
memoria_task_id: 538
actio_task_id: null
memory_links: []
---
# ランタイム I/O の完全非同期化 — イベントループを止めない

## 目的

Concordia のランタイム経路 (request / interval tick / spawn) に残る同期 fs I/O を
fs/promises 化し、「絶対にプロセスを止めない」状態にする (neco 指示:
「Sync 系の関数を全て除外し完全非同期にする」)。

実測根拠:
- findCodexTranscript の head 読み+キャッシュ化後も 1 スキャン 8.2 秒
  (8,601 ファイルの readdirSync + head open、Windows+AV で open が重い) が
  同期実行され、負キャッシュ TTL 60s で再発する。
- `DELETE /v1/sessions/:id` が実測 55.4 秒 (2026-07-16 22:15) —
  end-session フロー内に同期読みが残っている。経路を特定して潰す。
- cost/ ログ集計は過去に 16-17 秒ブロックの前科。

## 完了条件

- A-1/A-2: cost/ ログ集計 (log-usage / channel-cost-cache / windowed-usage-cache /
  session-usage-cache / log-totals-cache) の同期 fs を全 async 化。
  SessionWindowReader / ChannelCostReader 契約を Promise 化し、
  org-cost / channel-cost / cost-report / getMonitorSnapshot /
  Discord・Slack bot まで await 連鎖を通す。
- A-3: リクエスト経路 (reaction-workflow / discord egress / mcp readers /
  session-logs reader / delegation service / codex-cli transcript 解決) を async 化。
  AgentProvider.transcriptPath / parseTranscript 契約を async 化し、
  負キャッシュを指数バックオフ化 (60s 開始 ×2、最大 30 分/sessionId)。
  DELETE /v1/sessions の 55 秒ブロックの犯人を特定して排除。
- A-4: interval tick (sweeper / stalled-session-nudge / md-store /
  anthropic-oauth-usage) の同期 fs を async 化。
- A-5 (余力): spawn 経路の existsSync/statSync 等。やり切れない分は残件報告。
- B (boot 時のみ) / C (CLI) / D (テスト) / better-sqlite3 は対象外。
- `npx tsc --noEmit` 緑 + `npx vitest run` 緑 (real-git 系フレークは単独再実行で判断)。
- 残した同期 fs 呼び出しを理由つきで列挙。

## スコープ (編集可ディレクトリ)

- src/ (ただし src/personas/ と persona 関連コードは並行セッションのため触らない)
- tests/
